# @vicstack/cache

Hono rate-limit middleware, backed by
[`@vicstack/redis`](https://github.com/FranciscoAVD/redis).

```ts
import { createRedis } from "@vicstack/redis";
import { createRateLimit } from "@vicstack/cache";

const redis = createRedis({ url: env.REDIS_URL });
const rateLimit = createRateLimit({ redis, onError? });

rateLimit({ keyPrefix, windowSec, max, by? })   // Hono middleware
```

- `redis` is anything shaped like a `@vicstack/redis` instance — `{ client, increment }`.
- `onError?: (error, context) => void` defaults to `console.error` and is
  called instead of throwing whenever a Redis op fails — `rateLimit` fails
  soft (lets the request through rather than taking the route down).
- `by` derives the identity the limit is scoped to; it defaults to the
  caller's IP (`x-forwarded-for` / `cf-connecting-ip`), falling back to a
  single shared bucket. Pass your own to scope by session user, API key, etc.
  Reading anything beyond the request itself (e.g. `c.get("session")`) needs
  an explicit type argument for `c` to type-check against your app's `Env`:
  `rateLimit<RequireSessionEnv>({ by: (c) => c.get("session").user.id })`.
  This only catches a wrong/misspelled key — it can't catch calling it before
  the middleware that actually sets `session` has run.

```ts
// routes.ts
import { createRedis } from "@vicstack/redis";
import { createRateLimit } from "@vicstack/cache";

const redis = createRedis({ url: env.REDIS_URL });
const rateLimit = createRateLimit({ redis });

const writeRateLimit = rateLimit<RequireSessionEnv>({
  keyPrefix: "todo-write",
  windowSec: 60,
  max: 60,
  by: (c) => c.get("session").user.id,
});

app.post("/todos", writeRateLimit, async (c) => { ... });
```
