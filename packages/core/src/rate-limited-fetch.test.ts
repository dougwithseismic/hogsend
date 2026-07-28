import { describe, expect, it, vi } from "vitest";
import { createRateLimitedFetch } from "./rate-limited-fetch.js";

const noSleep = async () => {};

describe("createRateLimitedFetch", () => {
  it("returns a non-429 response immediately without retrying", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    const rlFetch = createRateLimitedFetch({
      minIntervalMs: 0,
      fetchImpl: fetchMock,
      sleep: noSleep,
    });

    const res = await rlFetch("https://example.com");
    expect(res.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 with exponential backoff and returns the retry", async () => {
    const sleeps: number[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const rlFetch = createRateLimitedFetch({
      minIntervalMs: 0,
      fetchImpl: fetchMock,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const res = await rlFetch("https://example.com");
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Two backoff sleeps: 1s then 2s.
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("honours a Retry-After header", async () => {
    const sleeps: number[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("slow down", {
          status: 429,
          headers: { "Retry-After": "3" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const rlFetch = createRateLimitedFetch({
      minIntervalMs: 0,
      fetchImpl: fetchMock,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await rlFetch("https://example.com");
    expect(sleeps).toEqual([3000]);
  });

  it("caps the exponential backoff at 30s", async () => {
    const sleeps: number[] = [];
    const fetchMock = vi.fn(
      async () => new Response("slow down", { status: 429 }),
    );
    const rlFetch = createRateLimitedFetch({
      minIntervalMs: 0,
      maxRetries: 7,
      fetchImpl: fetchMock,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await rlFetch("https://example.com");
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it("defaults to 5 retries before returning the 429", async () => {
    const fetchMock = vi.fn(
      async () => new Response("slow down", { status: 429 }),
    );
    const rlFetch = createRateLimitedFetch({
      minIntervalMs: 0,
      fetchImpl: fetchMock,
      sleep: noSleep,
    });

    const res = await rlFetch("https://example.com");
    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("gives up after maxRetries and returns the 429", async () => {
    const fetchMock = vi.fn(
      async () => new Response("slow down", { status: 429 }),
    );
    const rlFetch = createRateLimitedFetch({
      minIntervalMs: 0,
      maxRetries: 2,
      fetchImpl: fetchMock,
      sleep: noSleep,
    });

    const res = await rlFetch("https://example.com");
    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("spaces request starts by the minimum interval", async () => {
    const sleeps: number[] = [];
    const fetchMock = vi.fn(async () => new Response("ok"));
    const rlFetch = createRateLimitedFetch({
      minIntervalMs: 100,
      fetchImpl: fetchMock,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await rlFetch("https://example.com/1");
    await rlFetch("https://example.com/2");
    await rlFetch("https://example.com/3");

    // First call goes straight through; the following calls wait ~100ms each.
    expect(sleeps.length).toBe(2);
    for (const ms of sleeps) {
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(200);
    }
  });

  it("spaces CONCURRENT request starts instead of bunching them", async () => {
    // The clock is frozen, so every concurrent caller reads the same `now` and
    // the wait it asks for IS its start offset from the first request. Without
    // the queue accumulation (`Math.max(nextSlot, now) + minInterval`) all four
    // callers would compute the same one-interval wait and fire together,
    // blowing the shared per-organization PostHog quota.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      // The first caller never waits, so it starts at offset 0.
      const startOffsets: number[] = [0];
      const fetchMock = vi.fn(async () => new Response("ok"));
      const rlFetch = createRateLimitedFetch({
        minIntervalMs: 100,
        fetchImpl: fetchMock,
        sleep: async (ms) => {
          startOffsets.push(ms);
        },
      });

      await Promise.all(
        [1, 2, 3, 4].map((n) => rlFetch(`https://example.com/${n}`)),
      );

      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(startOffsets).toEqual([0, 100, 200, 300]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults minIntervalMs to 100ms (10 req/s)", async () => {
    const sleeps: number[] = [];
    const fetchMock = vi.fn(async () => new Response("ok"));
    const rlFetch = createRateLimitedFetch({
      fetchImpl: fetchMock,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await rlFetch("https://example.com/1");
    await rlFetch("https://example.com/2");

    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(sleeps[0]).toBeLessThanOrEqual(100);
  });
});

describe("createRateLimitedFetch — public core export", () => {
  // Pulls the WHOLE core barrel, which on a cold CI runner (no warm module
  // cache, transpiling every re-export on first touch) comfortably exceeds
  // vitest's 5s default — it timed out in CI while passing locally. The import
  // cost is the point of the test, so raise the budget rather than reach for a
  // narrower import that would stop proving the barrel re-exports it.
  it("is exported from the @hogsend/core barrel", async () => {
    const core = await import("./index.js");
    expect(typeof core.createRateLimitedFetch).toBe("function");
  }, 30_000);
});
