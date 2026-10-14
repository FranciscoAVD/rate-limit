import type { Context } from "hono";
import { parseCidr, parseIp, matchesCidr, type ParsedCidr } from "./ip-match";

export type ClientIpOptions = {
  /**
   * How to find the real client behind reverse proxies you control. Two shapes:
   *
   * - A number: how many proxy hops sit between the internet and this app. The address is the
   *   `n`th entry from the right of `x-forwarded-for`. One proxy that appends to the header and
   *   one that overwrites it both put the real address last, so `1` is right for either. Add one
   *   per extra hop you control (a CDN in front of a proxy is `2`). This mode trusts every one of
   *   those hops by position alone - it never looks at what address they actually are.
   * - An array of IPs/CIDRs: the known addresses of your own reverse proxies (this is what
   *   better-auth's own `advanced.ipAddress.trustedProxies` takes, so the same value can drive
   *   both). `x-forwarded-for` is walked from the right, skipping any entry that matches one of
   *   these ranges, until the first entry that doesn't - that's the client, however many trusted
   *   hops away. Handles a variable or unknown number of hops (several edge load balancers, a
   *   CDN that sometimes double-appends), which a hop count can't. A malformed entry reached
   *   before an untrusted one breaks the chain (returns `undefined`): if a hop can't be read, the
   *   hops before it can't be trusted to be honest either.
   *
   * `0` or `[]` (the default) means neither configured: the client address is the socket's and
   * every forwarding header is ignored, because without a trusted proxy the client chose those
   * headers itself.
   */
  trustedProxies?: number | readonly string[];
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

function forwardedHops(c: Context): string[] {
  return (c.req.header("x-forwarded-for") ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
}

/**
 * Walks `hops` from the right, skipping any entry that matches one of `trusted`'s ranges, and
 * returns the first one that doesn't - the client, as seen by the first hop we don't control. A
 * hop that fails to parse as an IP at all breaks the chain (`undefined`): an attacker who can make
 * one entry unreadable could be hiding behind it, so nothing past it is trustworthy either.
 * `undefined` also when `hops` is empty, or every hop was trusted (nothing left to report).
 */
function clientFromTrustedChain(hops: string[], trusted: readonly ParsedCidr[]): string | undefined {
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i]!;
    const bytes = parseIp(hop);
    if (!bytes) return undefined;
    if (trusted.some((net) => matchesCidr(bytes, net))) continue;
    return hop;
  }
  return undefined;
}

/**
 * Resolves the client address for `c`, or `undefined` when it cannot be
 * determined with the configured trust. Never falls back to a header the
 * configuration does not trust.
 *
 * TODO: an IPv6 client can rotate through its /64 to get a fresh identity
 * (and bucket) on every request. Consider truncating to the /64 prefix
 * before using the result as a rate-limit key.
 */
export function getClientIp(
  c: Context,
  { trustedProxies = 0, ipHeader }: ClientIpOptions = {},
): string | undefined {
  if (ipHeader) return clean(c.req.header(ipHeader));

  if (Array.isArray(trustedProxies)) {
    if (trustedProxies.length === 0) return socketAddress(c);
    // validated at createRateLimit time (assertClientIpOptions), so every entry parses here
    const trusted = trustedProxies.map((entry) => parseCidr(entry)!);
    return clientFromTrustedChain(forwardedHops(c), trusted);
  }

  if (typeof trustedProxies === "number" && trustedProxies > 0) {
    const hops = forwardedHops(c);
    return hops.length >= trustedProxies ? hops.at(-trustedProxies) : undefined;
  }

  return socketAddress(c);
}

const trustedProxiesConfigured = (trustedProxies: number | readonly string[] | undefined) =>
  typeof trustedProxies === "number" ? trustedProxies > 0 : (trustedProxies?.length ?? 0) > 0;

/** Throws on a configuration that cannot be what the caller meant. */
export function assertClientIpOptions({ trustedProxies, ipHeader }: ClientIpOptions): void {
  if (typeof trustedProxies === "number") {
    if (!Number.isInteger(trustedProxies) || trustedProxies < 0) {
      throw new RangeError(
        `@vicstack/rate-limit: trustedProxies must be a non-negative integer or an array of IPs/CIDRs, got ${trustedProxies}`,
      );
    }
  } else if (Array.isArray(trustedProxies)) {
    const invalid = trustedProxies.filter((entry) => parseCidr(entry) === null);
    if (invalid.length > 0) {
      throw new TypeError(
        `@vicstack/rate-limit: trustedProxies contains entries that are not an IP address or CIDR range: ${invalid.join(", ")}`,
      );
    }
  } else if (trustedProxies !== undefined) {
    throw new TypeError(
      "@vicstack/rate-limit: trustedProxies must be a non-negative integer or an array of IPs/CIDRs",
    );
  }

  if (ipHeader && trustedProxiesConfigured(trustedProxies)) {
    throw new TypeError(
      "@vicstack/rate-limit: set either ipHeader or trustedProxies, not both",
    );
  }
}
