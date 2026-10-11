import type { Context } from "hono";

export type ClientIpOptions = {
  /**
   * How many reverse proxies you control sit between the internet and this
   * app. `0` (the default) means none: the client address is the socket's
   * and every forwarding header is ignored, because without a trusted proxy
   * the client chose those headers itself.
   *
   * With `n > 0` the address is the `n`th entry from the right of
   * `x-forwarded-for`. One proxy that appends to the header and one that
   * overwrites it both put the real address last, so `1` is right for either.
   * Add one per extra hop you control (a CDN in front of a proxy is `2`).
   */
  trustedProxies?: number;
  /**
   * A single header your proxy sets to the client address, such as
   * `cf-connecting-ip`. Only safe if the proxy overwrites it on every request
   * and the app is reachable only through that proxy. Cannot be combined with
   * `trustedProxies`.
   */
  ipHeader?: string;
};

type BunServerLike = {
  requestIP(req: Request): { address: string } | null | undefined;
};

type NodeBindingsLike = {
  incoming?: { socket?: { remoteAddress?: string } };
};

const clean = (value: string | undefined) => value?.trim() || undefined;

/**
 * The address of the TCP peer, read from the runtime bindings Hono exposes as
 * `c.env`: Bun's server object (passed as the second argument to `fetch`) or
 * `@hono/node-server`'s `incoming` request. Returns `undefined` anywhere else,
 * including `app.request()` in tests with no bindings.
 *
 * Hono's own `getConnInfo` helper is not used: the `hono/bun` one is
 * deprecated and throws when the bindings are missing.
 */
function socketAddress(c: Context): string | undefined {
  const env = c.env as (BunServerLike & NodeBindingsLike & { server?: BunServerLike }) | undefined;
  if (!env) return undefined;

  const bun =
    typeof env.requestIP === "function"
      ? env
      : typeof env.server?.requestIP === "function"
        ? env.server
        : undefined;
  if (bun) return clean(bun.requestIP(c.req.raw)?.address);

  return clean(env.incoming?.socket?.remoteAddress);
}

/**
 * Resolves the client address for `c`, or `undefined` when it cannot be
 * determined with the configured trust. Never falls back to a header the
 * configuration does not trust.
 */
export function getClientIp(
  c: Context,
  { trustedProxies = 0, ipHeader }: ClientIpOptions = {},
): string | undefined {
  if (ipHeader) return clean(c.req.header(ipHeader));

  if (trustedProxies > 0) {
    const hops = (c.req.header("x-forwarded-for") ?? "")
      .split(",")
      .map((hop) => hop.trim())
      .filter(Boolean);
    return hops.length >= trustedProxies ? hops.at(-trustedProxies) : undefined;
  }

  return socketAddress(c);
}

/** Throws on a configuration that cannot be what the caller meant. */
export function assertClientIpOptions({ trustedProxies, ipHeader }: ClientIpOptions): void {
  if (trustedProxies !== undefined && (!Number.isInteger(trustedProxies) || trustedProxies < 0)) {
    throw new RangeError(
      `@vicstack/rate-limit: trustedProxies must be a non-negative integer, got ${trustedProxies}`,
    );
  }
  if (ipHeader && trustedProxies) {
    throw new TypeError(
      "@vicstack/rate-limit: set either ipHeader or trustedProxies, not both",
    );
  }
}
