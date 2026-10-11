import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createRateLimit } from "./rate-limit";
import type { CreateRateLimitOptions } from "./rate-limit";

/** Bindings Hono passes as `c.env` on Bun: the server, with `requestIP`. */
const bunSocket = (address: string | null) => ({
  requestIP: () => (address === null ? null : { address, family: "IPv4", port: 1234 }),
});

describe("createRateLimit", () => {
  function setup(
    overrides: { increment?: any; ttl?: any } & Partial<CreateRateLimitOptions> = {},
  ) {
    const errors: string[] = [];
    const { increment, ttl, ...options } = overrides;
    const rateLimit = createRateLimit({
      redis: {
        increment: increment ?? (async () => 1),
        client: { ttl: ttl ?? (async () => 60) },
      },
      onError: (_error, context) => errors.push(context),
      ...options,
    });
    return { rateLimit, errors };
  }

  const appWith = (rateLimit: ReturnType<typeof setup>["rateLimit"]) =>
    new Hono()
      .use(rateLimit({ keyPrefix: "x", windowSec: 60, max: 5 }))
      .get("/", (c) => c.json({ ok: true }));

  test("passes through under the limit", async () => {
    const { rateLimit } = setup({ increment: async () => 1 });
    const res = await appWith(rateLimit).request("/", {}, bunSocket("10.0.0.1"));
    expect(res.status).toBe(200);
  });

  test("429s over the limit with Retry-After", async () => {
    const { rateLimit } = setup({ increment: async () => 6, ttl: async () => 42 });
    const res = await appWith(rateLimit).request("/", {}, bunSocket("10.0.0.1"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
  });

  test("onLimit overrides the 429 response", async () => {
    const { rateLimit } = setup({
      increment: async () => 6,
      ttl: async () => 42,
      onLimit: (c, retryAfter) => c.json({ error: "slow down", retryAfter }, 429),
    });
    const res = await appWith(rateLimit).request("/", {}, bunSocket("10.0.0.1"));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "slow down", retryAfter: 42 });
  });

  test("fails open when Redis errors", async () => {
    const { rateLimit, errors } = setup({
      increment: async () => {
        throw new Error("down");
      },
    });
    const res = await appWith(rateLimit).request("/", {}, bunSocket("10.0.0.1"));
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

describe("client identity", () => {
  function track(options: Partial<CreateRateLimitOptions> = {}) {
    const keys: string[] = [];
    const errors: { context: string; message: string }[] = [];
    const rateLimit = createRateLimit({
      redis: {
        increment: async (key: string) => {
          keys.push(key);
          return 1;
        },
        client: { ttl: async () => 60 },
      },
      onError: (error, context) => errors.push({ context, message: error.message }),
      ...options,
    });
    const app = new Hono()
      .use(rateLimit({ keyPrefix: "x", windowSec: 60, max: 5 }))
      .get("/", (c) => c.json({ ok: true }));
    return { app, keys, errors };
  }

  describe("no proxy configured (the default)", () => {
    test("uses the socket address", async () => {
      const { app, keys } = track();
      await app.request("/", {}, bunSocket("10.0.0.9"));
      expect(keys).toEqual(["ratelimit:x:10.0.0.9"]);
    });

    test("ignores a client-supplied x-forwarded-for", async () => {
      const { app, keys } = track();
      await app.request("/", { headers: { "x-forwarded-for": "1.2.3.4" } }, bunSocket("10.0.0.9"));
      expect(keys).toEqual(["ratelimit:x:10.0.0.9"]);
    });

    test("ignores cf-connecting-ip", async () => {
      const { app, keys } = track();
      await app.request("/", { headers: { "cf-connecting-ip": "1.2.3.4" } }, bunSocket("10.0.0.9"));
      expect(keys).toEqual(["ratelimit:x:10.0.0.9"]);
    });

    test("gives different clients different buckets, not one shared bucket", async () => {
      const { app, keys } = track();
      await app.request("/", {}, bunSocket("10.0.0.1"));
      await app.request("/", {}, bunSocket("10.0.0.2"));
      expect(keys).toEqual(["ratelimit:x:10.0.0.1", "ratelimit:x:10.0.0.2"]);
    });

    test("reads the server from c.env.server as well", async () => {
      const { app, keys } = track();
      await app.request("/", {}, { server: bunSocket("10.0.0.7") });
      expect(keys).toEqual(["ratelimit:x:10.0.0.7"]);
    });

    test("reads the @hono/node-server socket", async () => {
      const { app, keys } = track();
      await app.request("/", {}, { incoming: { socket: { remoteAddress: "10.0.0.8" } } });
      expect(keys).toEqual(["ratelimit:x:10.0.0.8"]);
    });

    test("warns once when x-forwarded-for is present but ignored", async () => {
      const { app, errors } = track();
      const init = { headers: { "x-forwarded-for": "1.2.3.4" } };
      await app.request("/", init, bunSocket("10.0.0.9"));
      await app.request("/", init, bunSocket("10.0.0.9"));
      expect(errors.map((e) => e.context)).toEqual(["ratelimit.config"]);
      expect(errors[0]!.message).toContain("trustedProxies");
    });

    test("does not warn when there is no forwarding header", async () => {
      const { app, errors } = track();
      await app.request("/", {}, bunSocket("10.0.0.9"));
      expect(errors).toEqual([]);
    });
  });

  describe("trustedProxies", () => {
    test("1 takes the last entry when the proxy appends to a client-supplied header", async () => {
      const { app, keys } = track({ trustedProxies: 1 });
      // the client sent "6.6.6.6"; the proxy appended the address it actually saw
      await app.request("/", { headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.5" } });
      expect(keys).toEqual(["ratelimit:x:203.0.113.5"]);
    });

    test("1 takes the only entry when the proxy overwrites the header", async () => {
      const { app, keys } = track({ trustedProxies: 1 });
      await app.request("/", { headers: { "x-forwarded-for": "203.0.113.5" } });
      expect(keys).toEqual(["ratelimit:x:203.0.113.5"]);
    });

    test("2 takes the second entry from the right", async () => {
      const { app, keys } = track({ trustedProxies: 2 });
      await app.request("/", {
        headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.5, 10.1.1.1" },
      });
      expect(keys).toEqual(["ratelimit:x:203.0.113.5"]);
    });

    test("a spoofed leading entry cannot change the bucket", async () => {
      const { app, keys } = track({ trustedProxies: 1 });
      for (const spoof of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) {
        await app.request("/", { headers: { "x-forwarded-for": `${spoof}, 203.0.113.5` } });
      }
      expect(new Set(keys)).toEqual(new Set(["ratelimit:x:203.0.113.5"]));
    });

    test("fewer entries than trusted hops means no identity: passes through and reports", async () => {
      const { app, keys, errors } = track({ trustedProxies: 2 });
      const res = await app.request("/", { headers: { "x-forwarded-for": "203.0.113.5" } });
      expect(res.status).toBe(200);
      expect(keys).toEqual([]);
      expect(errors.map((e) => e.context)).toEqual(["ratelimit.x.identity"]);
    });

    test("a missing header means no identity", async () => {
      const { app, keys, errors } = track({ trustedProxies: 1 });
      const res = await app.request("/");
      expect(res.status).toBe(200);
      expect(keys).toEqual([]);
      expect(errors.map((e) => e.context)).toEqual(["ratelimit.x.identity"]);
    });

    test("does not read the socket address", async () => {
      const { app, keys } = track({ trustedProxies: 1 });
      await app.request(
        "/",
        { headers: { "x-forwarded-for": "203.0.113.5" } },
        bunSocket("10.0.0.9"),
      );
      expect(keys).toEqual(["ratelimit:x:203.0.113.5"]);
    });
  });

  describe("ipHeader", () => {
    test("reads the named header", async () => {
      const { app, keys } = track({ ipHeader: "cf-connecting-ip" });
      await app.request("/", { headers: { "cf-connecting-ip": " 203.0.113.5 " } });
      expect(keys).toEqual(["ratelimit:x:203.0.113.5"]);
    });

    test("ignores x-forwarded-for and the socket", async () => {
      const { app, keys } = track({ ipHeader: "cf-connecting-ip" });
      await app.request(
        "/",
        { headers: { "cf-connecting-ip": "203.0.113.5", "x-forwarded-for": "6.6.6.6" } },
        bunSocket("10.0.0.9"),
      );
      expect(keys).toEqual(["ratelimit:x:203.0.113.5"]);
    });

    test("a missing header means no identity, not a fallback to another header", async () => {
      const { app, keys, errors } = track({ ipHeader: "cf-connecting-ip" });
      const res = await app.request(
        "/",
        { headers: { "x-forwarded-for": "6.6.6.6" } },
        bunSocket("10.0.0.9"),
      );
      expect(res.status).toBe(200);
      expect(keys).toEqual([]);
      expect(errors.map((e) => e.context)).toEqual(["ratelimit.x.identity"]);
    });
  });

  describe("no identity", () => {
    test("no socket bindings (e.g. app.request in a test) passes through and reports", async () => {
      const { app, keys, errors } = track();
      const res = await app.request("/");
      expect(res.status).toBe(200);
      expect(keys).toEqual([]);
      expect(errors.map((e) => e.context)).toEqual(["ratelimit.x.identity"]);
    });

    test("a socket that cannot report an address passes through and reports", async () => {
      const { app, keys, errors } = track();
      const res = await app.request("/", {}, bunSocket(null));
      expect(res.status).toBe(200);
      expect(keys).toEqual([]);
      expect(errors.map((e) => e.context)).toEqual(["ratelimit.x.identity"]);
    });

    test("a custom by() returning undefined passes through and reports", async () => {
      const keys: string[] = [];
      const errors: string[] = [];
      const rateLimit = createRateLimit({
        redis: {
          increment: async (key: string) => {
            keys.push(key);
            return 1;
          },
          client: { ttl: async () => 60 },
        },
        onError: (_e, context) => errors.push(context),
      });
      const app = new Hono()
        .use(rateLimit({ keyPrefix: "x", windowSec: 60, max: 5, by: () => undefined }))
        .get("/", (c) => c.json({ ok: true }));
      const res = await app.request("/");
      expect(res.status).toBe(200);
      expect(keys).toEqual([]);
      expect(errors).toEqual(["ratelimit.x.identity"]);
    });
  });

  describe("configuration is validated when the limiter is created", () => {
    const redis = { increment: async () => 1, client: { ttl: async () => 60 } };

    test.each([-1, 1.5, Number.NaN])("rejects trustedProxies %p", (value) => {
      expect(() => createRateLimit({ redis, trustedProxies: value })).toThrow(RangeError);
    });

    test("rejects trustedProxies together with ipHeader", () => {
      expect(() =>
        createRateLimit({ redis, trustedProxies: 1, ipHeader: "cf-connecting-ip" }),
      ).toThrow(TypeError);
    });

    test("accepts trustedProxies of 0", () => {
      expect(() => createRateLimit({ redis, trustedProxies: 0 })).not.toThrow();
    });
  });
});
