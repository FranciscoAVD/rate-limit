# @vicstack/rate-limit

Hono rate-limit middleware on top of an atomic increment-with-TTL primitive.
Works with [`@vicstack/redis`](https://github.com/FranciscoAVD/redis) or any
object shaped the same way — see `redis` below.

```ts
import { createRedis } from "@vicstack/redis";
import { createRateLimit } from "@vicstack/rate-limit";

const redis = createRedis({ url: env.REDIS_URL });
const rateLimit = createRateLimit({ redis, trustedProxies: 1, onError?, onLimit? });

rateLimit({ keyPrefix, windowSec, max, by? })   // Hono middleware
```

- `redis` is anything shaped like a `@vicstack/redis` instance — `{ client, increment }`.
- `onError?: (error, context) => void` defaults to `console.error` and is
  called instead of throwing whenever a Redis op fails — `rateLimit` fails
  soft (lets the request through rather than taking the route down).
- `onLimit?: (c, retryAfter) => Response` builds the response for a request
  over its limit. `retryAfter` is the seconds until the window resets
  (already clamped to at least 1). Defaults to a `429` with
  `{ message: "Too many requests. Please try again later." }` and a
  `Retry-After` header; override it to match your app's error envelope:
  `onLimit: (c, retryAfter) => c.json({ error: { code: "rate_limited", retryAfter } }, 429)`.
- `trustedProxies` / `ipHeader` say how to find the client address behind a
  reverse proxy. See [Behind a reverse proxy](#behind-a-reverse-proxy).
- `by` derives the identity the limit is scoped to; it defaults to the client
  address described below. Pass your own to scope by session user, API key,
  etc. Return `undefined` for "no identity": the request is let through and
  `onError` is called with the context `ratelimit.<keyPrefix>.identity`.
  Reading anything beyond the request itself (e.g. `c.get("session")`) needs
  an explicit type argument for `c` to type-check against your app's `Env`:
  `rateLimit<RequireSessionEnv>({ by: (c) => c.get("session").user.id })`.
  This only catches a wrong/misspelled key — it can't catch calling it before
  the middleware that actually sets `session` has run.

## Behind a reverse proxy

The default identity is the client's IP address, and where that comes from is
a trust decision, so you state it when you create the limiter:

| You run | Set | The client address is |
| --- | --- | --- |
| The app exposed directly | nothing | The socket address. Forwarding headers are ignored. |
| One reverse proxy you control | `trustedProxies: 1` | The last entry of `x-forwarded-for` |
| A CDN in front of a proxy, both yours | `trustedProxies: 2` | The second entry from the right |
| A proxy that sets one header, such as Cloudflare | `ipHeader: "cf-connecting-ip"` | That header |

**Why not just read `x-forwarded-for`.** Many proxies *append* to a header the
client already sent, so the first entry is whatever the client chose. Reading
it lets anyone get a fresh bucket per request by rotating the value. The last
entry (with one proxy) is the address your proxy saw, whether it appends or
overwrites, so that is what `trustedProxies` reads. Count only proxies you
control.

**Things to get right**

- Make the app reachable only through the proxy (bind to a private interface
  or firewall it). If clients can connect to the app directly, they can send
  any header they like and the settings above stop meaning anything.
- With `ipHeader`, the proxy must overwrite that header on every request,
  never pass the client's value through.
- `trustedProxies` and `ipHeader` are mutually exclusive; setting both, or a
  `trustedProxies` that is not a non-negative integer, throws when you call
  `createRateLimit`.
- If the address cannot be determined (header missing, fewer entries than
  `trustedProxies`, no socket bindings), the request is let through and
  `onError` is called. There is no shared fallback bucket.
- With nothing set behind a proxy, every client appears to come from the
  proxy's address and shares one bucket. If it sees `x-forwarded-for` while
  `trustedProxies` is `0`, the limiter calls `onError` once with the context
  `ratelimit.config` to say so.
- The socket address is read from the runtime bindings Hono exposes as
  `c.env`: Bun (`export default { fetch: app.fetch }`, which passes the
  server) and `@hono/node-server`. Other runtimes have no socket address;
  use `ipHeader` or `trustedProxies`, or pass `by`.

`getClientIp(c, { trustedProxies, ipHeader })` is exported if you want the same
resolution inside your own `by`, for example to fall back to the IP when there
is no session:

```ts
import { getClientIp } from "@vicstack/rate-limit";

by: (c) => c.get("session")?.user.id ?? getClientIp(c, { trustedProxies: 1 }),
```

```ts
// routes.ts
import { createRedis } from "@vicstack/redis";
import { createRateLimit } from "@vicstack/rate-limit";

const redis = createRedis({ url: env.REDIS_URL });
const rateLimit = createRateLimit({ redis, trustedProxies: 1 });

const writeRateLimit = rateLimit<RequireSessionEnv>({
  keyPrefix: "todo-write",
  windowSec: 60,
  max: 60,
  by: (c) => c.get("session").user.id,
});

app.post("/todos", writeRateLimit, async (c) => { ... });
```

## Upgrading from 0.1

The default identity changed. 0.1 used the first `x-forwarded-for` entry (or
`cf-connecting-ip`) and pooled requests with neither into one `"anonymous"`
bucket. Now it uses the socket address unless you set `trustedProxies` or
`ipHeader`. Behind a proxy, add `trustedProxies: 1` (or the right number).
