import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createRateLimit } from "./rate-limit";

describe("createRateLimit", () => {
  function setup(overrides: { increment?: any; ttl?: any } = {}) {
    const errors: string[] = [];
    const rateLimit = createRateLimit({
      redis: {
        increment: overrides.increment ?? (async () => 1),
        client: { ttl: overrides.ttl ?? (async () => 60) },
      },
      onError: (_error, context) => errors.push(context),
    });
    return { rateLimit, errors };
  }

  test("passes through under the limit", async () => {
    const { rateLimit } = setup({ increment: async () => 1 });
    const app = new Hono()
      .use(rateLimit({ keyPrefix: "x", windowSec: 60, max: 5 }))
      .get("/", (c) => c.json({ ok: true }));

    const res = await app.request("/");
    expect(res.status).toBe(200);
  });

  test("429s over the limit with Retry-After", async () => {
    const { rateLimit } = setup({ increment: async () => 6, ttl: async () => 42 });
    const app = new Hono()
      .use(rateLimit({ keyPrefix: "x", windowSec: 60, max: 5 }))
      .get("/", (c) => c.json({ ok: true }));

    const res = await app.request("/");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
  });

  test("fails open when Redis errors", async () => {
    const { rateLimit, errors } = setup({
      increment: async () => {
        throw new Error("down");
      },
    });
    const app = new Hono()
      .use(rateLimit({ keyPrefix: "x", windowSec: 60, max: 5 }))
      .get("/", (c) => c.json({ ok: true }));

    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(errors).toEqual(["ratelimit.x"]);
  });

  test("by() scopes the key to a custom identity", async () => {
    const seen: string[] = [];
    const { rateLimit } = setup({
      increment: async (key: string) => {
        seen.push(key);
        return 1;
      },
    });
    const app = new Hono()
      .use(rateLimit({ keyPrefix: "x", windowSec: 60, max: 5, by: () => "user-1" }))
      .get("/", (c) => c.json({ ok: true }));

    await app.request("/");
    expect(seen).toEqual(["ratelimit:x:user-1"]);
  });

  test("by() can be typed against a custom Env via an explicit type argument", async () => {
    type RequireSessionEnv = { Variables: { session: { user: { id: string } } } };
    const seen: string[] = [];
    const { rateLimit } = setup({
      increment: async (key: string) => {
        seen.push(key);
        return 1;
      },
    });
    const app = new Hono<RequireSessionEnv>()
      .use(async (c, next) => {
        c.set("session", { user: { id: "user-1" } });
        await next();
      })
      .use(rateLimit<RequireSessionEnv>({
        keyPrefix: "x",
        windowSec: 60,
        max: 5,
        by: (c) => c.get("session").user.id,
      }))
      .get("/", (c) => c.json({ ok: true }));

    await app.request("/");
    expect(seen).toEqual(["ratelimit:x:user-1"]);
  });
});
