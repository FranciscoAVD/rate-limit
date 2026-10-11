import { createMiddleware } from "hono/factory";
import type { Context, Env } from "hono";
import HTTP from "@vicstack/http";
import tryCatch from "@vicstack/try-catch";
import { assertClientIpOptions, getClientIp, type ClientIpOptions } from "./client-ip";

type Increment = (key: string, ttlSec: number) => Promise<number>;
type OnError = (error: Error, context: string) => void;

export type RateLimitOptions<E extends Env = Env> = {
  /** Namespaces the counter so different routes don't share a budget. */
  keyPrefix: string;
  /** Window size in seconds. */
  windowSec: number;
  /** Max requests allowed per window. */
  max: number;
  /**
   * Derives the identity the limit is scoped to. Defaults to the client
   * address resolved with the `trustedProxies` / `ipHeader` given to
   * `createRateLimit` (the socket address if neither is set).
   *
   * Returning `undefined` means "no identity": the request is let through
   * and the problem is reported through `onError`, rather than being pooled
   * into one bucket shared by everyone.
   *
   * Reading anything beyond the default requires an explicit type argument
   * to type-check, e.g. `rateLimit<RequireSessionEnv>({ by: (c) =>
   * c.get("session").user.id })` — TS can't infer `E` from the callback body.
   * This only catches a wrong/misspelled key; it can't catch using a
   * variable before the middleware that actually sets it has run.
   */
  by?: (c: Context<E>) => string | undefined | Promise<string | undefined>;
};

const defaultOnError: OnError = (error, context) => {
  console.error(`[ratelimit] ${context}`, error);
};

const defaultOnLimit = (c: Context, retryAfter: number) =>
  c.json(
    { message: "Too many requests. Please try again later." },
    HTTP.TooManyRequests,
    { "Retry-After": String(retryAfter) },
  );

export type CreateRateLimitOptions = ClientIpOptions & {
  /** Anything shaped like a `@vicstack/redis` instance, e.g. `createRedis({ url: env.REDIS_URL })`. */
  redis: { client: { ttl(key: string): Promise<number> }; increment: Increment };
  /** Called whenever a Redis operation fails. Defaults to `console.error`. */
  onError?: OnError;
  /**
   * Builds the response for a request over its limit. `retryAfter` is the
   * number of seconds until the window resets, already clamped to at least
   * 1. Defaults to a `429` with `{ message }` and a `Retry-After` header;
   * override to match your app's error envelope.
   */
  onLimit?: (c: Context, retryAfter: number) => Response | Promise<Response>;
};

/**
 * Builds a Hono rate-limit middleware factory on top of an atomic
 * increment-with-TTL primitive. Fails open: a Redis outage reports the
 * error through `onError` and lets the request through rather than taking
 * the route down with it.
 *
 * Behind a reverse proxy, set `trustedProxies` (or `ipHeader`) so the default
 * identity is the real client rather than the proxy. Without either, the
 * socket address is used and forwarding headers are ignored, since a client
 * can set them to anything.
 *
 * @throws if `trustedProxies` is not a non-negative integer, or if both
 * `trustedProxies` and `ipHeader` are set.
 */
export function createRateLimit({
  redis,
  onError = defaultOnError,
  onLimit = defaultOnLimit,
  trustedProxies,
  ipHeader,
}: CreateRateLimitOptions) {
  assertClientIpOptions({ trustedProxies, ipHeader });

  const ipOptions: ClientIpOptions = { trustedProxies, ipHeader };
  const proxyUnconfigured = !ipHeader && !trustedProxies;
  let warnedAboutForwardedHeader = false;

  const defaultBy = (c: Context) => {
    if (
      proxyUnconfigured &&
      !warnedAboutForwardedHeader &&
      c.req.header("x-forwarded-for") !== undefined
    ) {
      warnedAboutForwardedHeader = true;
      onError(
        new Error(
          "x-forwarded-for is present but trustedProxies is 0, so it is ignored and every client behind the proxy shares one address. Set trustedProxies (or ipHeader) to the number of proxies you control.",
        ),
        "ratelimit.config",
      );
    }
    return getClientIp(c, ipOptions);
  };

  return function rateLimit<E extends Env = Env>({
    keyPrefix,
    windowSec,
    max,
    by = defaultBy as (c: Context<E>) => string | undefined | Promise<string | undefined>,
  }: RateLimitOptions<E>) {
    return createMiddleware<E>(async (c, next) => {
      const subject = await by(c);
      if (subject === undefined) {
        onError(
          new Error("could not determine the client identity; request not rate limited"),
          `ratelimit.${keyPrefix}.identity`,
        );
        return next();
      }

      const key = `ratelimit:${keyPrefix}:${subject}`;

      const [count, error] = await tryCatch(redis.increment(key, windowSec));
      if (error) {
        onError(error, `ratelimit.${keyPrefix}`);
        return next();
      }

      if (count > max) {
        const [retryAfter] = await tryCatch(redis.client.ttl(key));
        return onLimit(c, Math.max(retryAfter ?? windowSec, 1));
      }

      await next();
    });
  };
}
