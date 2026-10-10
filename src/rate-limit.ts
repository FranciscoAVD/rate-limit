import { createMiddleware } from "hono/factory";
import type { Context, Env } from "hono";
import HTTP from "@vicstack/http";
import tryCatch from "@vicstack/try-catch";
import type { Increment, OnError } from "@vicstack/redis";

export type RateLimitOptions<E extends Env = Env> = {
  /** Namespaces the counter so different routes don't share a budget. */
  keyPrefix: string;
  /** Window size in seconds. */
  windowSec: number;
  /** Max requests allowed per window. */
  max: number;
  /**
   * Derives the identity the limit is scoped to. Defaults to the caller's
   * IP (`x-forwarded-for` / `cf-connecting-ip`), falling back to a single
   * shared bucket if neither header is present.
   *
   * Reading anything beyond the default requires an explicit type argument
   * to type-check, e.g. `rateLimit<RequireSessionEnv>({ by: (c) =>
   * c.get("session").user.id })` — TS can't infer `E` from the callback body.
   * This only catches a wrong/misspelled key; it can't catch using a
   * variable before the middleware that actually sets it has run.
   */
  by?: (c: Context<E>) => string | Promise<string>;
};

const defaultBy = (c: Context) =>
  c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
  c.req.header("cf-connecting-ip") ??
  "anonymous";

const defaultOnError: OnError = (error, context) => {
  console.error(`[cache] ${context}`, error);
};

export type CreateRateLimitOptions = {
  /** A `@vicstack/redis` instance, e.g. `createRedis({ url: env.REDIS_URL })`. */
  redis: { client: { ttl(key: string): Promise<number> }; increment: Increment };
  /** Called whenever a Redis operation fails. Defaults to `console.error`. */
  onError?: OnError;
};

/**
 * Builds a Hono rate-limit middleware factory on top of an atomic
 * increment-with-TTL primitive. Fails open: a Redis outage reports the
 * error through `onError` and lets the request through rather than taking
 * the route down with it.
 */
export function createRateLimit({ redis, onError = defaultOnError }: CreateRateLimitOptions) {
  return function rateLimit<E extends Env = Env>({
    keyPrefix,
    windowSec,
    max,
    by = defaultBy as (c: Context<E>) => string | Promise<string>,
  }: RateLimitOptions<E>) {
    return createMiddleware<E>(async (c, next) => {
      const subject = await by(c);
      const key = `ratelimit:${keyPrefix}:${subject}`;

      const [count, error] = await tryCatch(redis.increment(key, windowSec));
      if (error) {
        onError(error, `ratelimit.${keyPrefix}`);
        return next();
      }

      if (count > max) {
        const [retryAfter] = await tryCatch(redis.client.ttl(key));
        return c.json(
          { message: "Too many requests. Please try again later." },
          HTTP.TooManyRequests,
          { "Retry-After": String(Math.max(retryAfter ?? windowSec, 1)) },
        );
      }

      await next();
    });
  };
}
