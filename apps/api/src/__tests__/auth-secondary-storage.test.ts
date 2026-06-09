import { describe, expect, it, vi } from "vitest";

// The vitest config points DATABASE_URL at :5432; the migrated test DB lives at
// :5434. Override before importing the engine (mirrors password-reset.test.ts).
process.env.DATABASE_URL = "postgresql://test:test@localhost:5434/test";

vi.mock("../lib/hatchet.js", () => ({
  hatchet: {
    durableTask: vi.fn(() => ({
      run: vi.fn(),
      runNoWait: vi.fn(),
      runAndWait: vi.fn(),
    })),
    task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
    events: { push: vi.fn() },
    runs: { cancel: vi.fn(), get: vi.fn() },
    worker: vi.fn(),
  },
}));

vi.mock("../workflows/send-email.js", () => ({
  sendEmailTask: { run: vi.fn(), runNoWait: vi.fn() },
}));

const { createAuth, createHogsendClient, createRedisSecondaryStorage } =
  await import("@hogsend/engine");

// A real (unconnected) drizzle DB is enough for `auth.$context` to resolve the
// rate-limit storage selection — the assertions never touch a query, just the
// resolved config. Mirrors how the container builds auth.
const { createDatabase } = await import("@hogsend/db");
const { db } = createDatabase({
  url: "postgresql://test:test@localhost:5434/test",
});

const baseAuthOpts = {
  db,
  secret: "test-secret-for-vitest-minimum-32-characters-long",
  baseURL: "http://localhost:3002",
};

// --- A fake ioredis surface capturing get/set/del calls. Lets us assert the
// adapter's wire behaviour (namespacing, TTL → EX, graceful degradation)
// without a live Redis. ---
function makeFakeRedis(overrides: Partial<Record<string, unknown>> = {}) {
  const store = new Map<string, string>();
  const calls: { op: string; args: unknown[] }[] = [];
  const fake = {
    store,
    calls,
    get: vi.fn(async (key: string) => {
      calls.push({ op: "get", args: [key] });
      return store.get(key) ?? null;
    }),
    set: vi.fn(async (key: string, value: string, ...rest: unknown[]) => {
      calls.push({ op: "set", args: [key, value, ...rest] });
      store.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key: string) => {
      calls.push({ op: "del", args: [key] });
      return store.delete(key) ? 1 : 0;
    }),
    ...overrides,
  };
  // biome-ignore lint/suspicious/noExplicitAny: minimal ioredis stand-in.
  return fake as any;
}

describe("createRedisSecondaryStorage (adapter)", () => {
  it("namespaces keys under hogsend:auth: on get/set/delete", async () => {
    const redis = makeFakeRedis();
    const storage = createRedisSecondaryStorage(redis);

    await storage.set("session-token", "{}");
    await storage.get("session-token");
    await storage.delete("session-token");

    expect(redis.set).toHaveBeenCalledWith("hogsend:auth:session-token", "{}");
    expect(redis.get).toHaveBeenCalledWith("hogsend:auth:session-token");
    expect(redis.del).toHaveBeenCalledWith("hogsend:auth:session-token");
  });

  it("honours better-auth's TTL (seconds) via EX, and persists when absent", async () => {
    const redis = makeFakeRedis();
    const storage = createRedisSecondaryStorage(redis);

    await storage.set("k1", "v1", 900);
    await storage.set("k2", "v2");

    expect(redis.set).toHaveBeenNthCalledWith(
      1,
      "hogsend:auth:k1",
      "v1",
      "EX",
      900,
    );
    // No TTL → plain SET (no EX), matching better-auth's own behaviour.
    expect(redis.set).toHaveBeenNthCalledWith(2, "hogsend:auth:k2", "v2");
  });

  it("round-trips a stored value (get returns the raw string for JSON.parse)", async () => {
    const redis = makeFakeRedis();
    const storage = createRedisSecondaryStorage(redis);

    await storage.set("rt", JSON.stringify({ count: 1, lastRequest: 42 }));
    const raw = await storage.get("rt");

    expect(raw).toBe(JSON.stringify({ count: 1, lastRequest: 42 }));
    expect(JSON.parse(raw as string)).toEqual({ count: 1, lastRequest: 42 });
  });

  it("degrades gracefully on a Redis fault (get→null, set/delete→no-op, never throws)", async () => {
    const boom = () => {
      throw new Error("redis down");
    };
    const redis = makeFakeRedis({
      get: vi.fn(boom),
      set: vi.fn(boom),
      del: vi.fn(boom),
    });
    const storage = createRedisSecondaryStorage(redis);

    await expect(storage.get("x")).resolves.toBeNull();
    await expect(storage.set("x", "y", 10)).resolves.toBeUndefined();
    await expect(storage.delete("x")).resolves.toBeUndefined();
  });
});

describe("better-auth secondaryStorage → rate-limit storage selection", () => {
  it("WITH secondaryStorage → rateLimit.storage resolves to 'secondary-storage'", async () => {
    const auth = createAuth({
      ...baseAuthOpts,
      secondaryStorage: createRedisSecondaryStorage(makeFakeRedis()),
    });
    const ctx = await auth.$context;
    expect(ctx.rateLimit.storage).toBe("secondary-storage");
    expect(ctx.secondaryStorage).toBeDefined();
  });

  it("WITHOUT secondaryStorage → rateLimit.storage falls back to in-memory", async () => {
    const auth = createAuth(baseAuthOpts);
    const ctx = await auth.$context;
    // This is exactly the per-instance default finding #2 flags as too weak on
    // a multi-replica deploy.
    expect(ctx.rateLimit.storage).toBe("memory");
    expect(ctx.secondaryStorage).toBeUndefined();
  });
});

describe("createHogsendClient wires Redis secondary storage when REDIS_URL is set", () => {
  it("the container's auth resolves rate-limit storage to 'secondary-storage'", async () => {
    // The vitest env sets REDIS_URL, so the container wires the shared-Redis
    // adapter into better-auth — the live assertion for finding #2.
    const container = createHogsendClient();
    const ctx = await container.auth.$context;
    expect(ctx.rateLimit.storage).toBe("secondary-storage");
    expect(ctx.secondaryStorage).toBeDefined();
  });
});
