/**
 * `createRateLimit` header contract, driven through the factory options on a
 * bare Hono app (no container, no DB). The limiter no-ops under NODE_ENV=test
 * by default; every instance here passes `disableInTest: false` instead of
 * touching that default. Runs against the suite's Redis (the production path),
 * with a run-scoped prefix so parallel files and re-runs never share a bucket.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

const { createRateLimit } = await import("@hogsend/engine");

const RUN = `rlh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function limitedApp(opts: { max: number; windowMs?: number; tag: string }) {
  const limiter = createRateLimit({
    prefix: `ratelimit:test:${RUN}:${opts.tag}`,
    max: opts.max,
    windowMs: opts.windowMs ?? 60_000,
    keyFn: () => "bucket",
    disableInTest: false,
  });
  // biome-ignore lint/suspicious/noExplicitAny: bare app, no AppEnv needed
  const app = new Hono<any>();
  app.use("/r", limiter);
  app.get("/r", (c) => c.json({ ok: true }));
  return app;
}

describe("createRateLimit headers", () => {
  it("sets the IETF RateLimit-* headers and keeps the X-RateLimit-* pair", async () => {
    const app = limitedApp({ max: 5, tag: "headers" });
    const res = await app.request("/r");
    expect(res.status).toBe(200);
    expect(res.headers.get("RateLimit-Limit")).toBe("5");
    expect(res.headers.get("RateLimit-Remaining")).toBe("4");
    expect(res.headers.get("RateLimit-Policy")).toBe("5;w=60");
    // First request in an empty window: the slot it took frees one full
    // window from now.
    expect(res.headers.get("RateLimit-Reset")).toBe("60");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("5");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("4");
    // Retry-After is a 429-only header.
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  it("counts down, then 429s with Retry-After equal to RateLimit-Reset", async () => {
    const app = limitedApp({ max: 2, tag: "exhaust" });

    const first = await app.request("/r");
    const second = await app.request("/r");
    expect(first.headers.get("RateLimit-Remaining")).toBe("1");
    expect(second.status).toBe(200);
    expect(second.headers.get("RateLimit-Remaining")).toBe("0");

    const third = await app.request("/r");
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "Rate limit exceeded" });
    expect(third.headers.get("RateLimit-Remaining")).toBe("0");
    expect(third.headers.get("X-RateLimit-Remaining")).toBe("0");

    const retryAfter = Number(third.headers.get("Retry-After"));
    const reset = Number(third.headers.get("RateLimit-Reset"));
    expect(retryAfter).toBe(reset);
    // Computed from the log, not hard-coded to the window: the requests were
    // made within the last second, so the next slot is 59-60s away.
    expect(retryAfter).toBeGreaterThanOrEqual(59);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it("computes RateLimit-Reset from the oldest entry still in the window", async () => {
    const app = limitedApp({ max: 3, windowMs: 3_000, tag: "reset" });
    const first = await app.request("/r");
    expect(first.headers.get("RateLimit-Policy")).toBe("3;w=3");
    expect(first.headers.get("RateLimit-Reset")).toBe("3");

    await new Promise((r) => setTimeout(r, 1_200));
    // The first entry is ~1.2s old, so it ages out in ~1.8s (ceil → 2; a
    // slow machine may land on 1). Anything below the 3s window proves the
    // reset is read from the oldest entry rather than the window length.
    const second = await app.request("/r");
    expect(second.headers.get("RateLimit-Remaining")).toBe("1");
    const reset = Number(second.headers.get("RateLimit-Reset"));
    expect(reset).toBeGreaterThanOrEqual(1);
    expect(reset).toBeLessThan(3);
  });

  it("lets a request through again once the window frees a slot", async () => {
    const app = limitedApp({ max: 1, windowMs: 1_000, tag: "recover" });
    expect((await app.request("/r")).status).toBe(200);
    const blocked = await app.request("/r");
    expect(blocked.status).toBe(429);
    const wait = Number(blocked.headers.get("Retry-After"));
    expect(wait).toBe(1);
    await new Promise((r) => setTimeout(r, wait * 1000 + 50));
    expect((await app.request("/r")).status).toBe(200);
  });

  it("counts a request once when overlapping patterns mount the same instance", async () => {
    const limiter = createRateLimit({
      prefix: `ratelimit:test:${RUN}:overlap`,
      max: 10,
      keyFn: () => "bucket",
      disableInTest: false,
    });
    // biome-ignore lint/suspicious/noExplicitAny: bare app, no AppEnv needed
    const app = new Hono<any>();
    // `/feed/*` also matches the bare `/feed`, so both run for `GET /feed`.
    app.use("/feed", limiter);
    app.use("/feed/*", limiter);
    app.get("/feed", (c) => c.json({ ok: true }));

    const a = await app.request("/feed");
    const b = await app.request("/feed");
    expect(a.headers.get("RateLimit-Remaining")).toBe("9");
    expect(b.headers.get("RateLimit-Remaining")).toBe("8");
  });

  it("keeps budgets isolated per prefix", async () => {
    const a = limitedApp({ max: 1, tag: "iso-a" });
    const b = limitedApp({ max: 1, tag: "iso-b" });
    expect((await a.request("/r")).status).toBe(200);
    expect((await a.request("/r")).status).toBe(429);
    expect((await b.request("/r")).status).toBe(200);
  });

  it("stays a no-op under NODE_ENV=test by default", async () => {
    const limiter = createRateLimit({
      prefix: `ratelimit:test:${RUN}:default`,
      max: 1,
      keyFn: () => "bucket",
    });
    // biome-ignore lint/suspicious/noExplicitAny: bare app, no AppEnv needed
    const app = new Hono<any>();
    app.use("/r", limiter);
    app.get("/r", (c) => c.json({ ok: true }));
    expect((await app.request("/r")).status).toBe(200);
    const again = await app.request("/r");
    expect(again.status).toBe(200);
    expect(again.headers.get("RateLimit-Limit")).toBeNull();
  });
});
