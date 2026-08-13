import assert from "node:assert/strict";
import test from "node:test";
import {
  type AccountLinkThrottleRedis,
  checkAccountLinkThrottle,
} from "./account-link-throttle.js";

/**
 * PRD 07 T3. The fake redis is the whole point: this throttle is FAIL-CLOSED
 * (DECISIONS §6.8), which is the opposite of the connector callback's
 * degrade-to-TTL posture, so the "no redis" arm must be exercised directly.
 */
function fakeRedis(opts: { throwOnIncr?: boolean } = {}): {
  redis: AccountLinkThrottleRedis;
  counts: Map<string, number>;
  expires: Array<{ key: string; seconds: number }>;
} {
  const counts = new Map<string, number>();
  const expires: Array<{ key: string; seconds: number }> = [];
  return {
    counts,
    expires,
    redis: {
      async incr(key) {
        if (opts.throwOnIncr) throw new Error("connection lost");
        const next = (counts.get(key) ?? 0) + 1;
        counts.set(key, next);
        return next;
      },
      async expire(key, seconds) {
        expires.push({ key, seconds });
        return 1;
      },
    },
  };
}

test("allows under the cap", async () => {
  const { redis } = fakeRedis();
  for (let i = 0; i < 20; i++) {
    const result = await checkAccountLinkThrottle({
      surface: "start",
      ip: "203.0.113.7",
      redis,
    });
    assert.deepEqual(result, { ok: true }, `attempt ${i + 1} should pass`);
  }
});

test("rejects over the cap with rate_limited", async () => {
  const { redis } = fakeRedis();
  for (let i = 0; i < 20; i++) {
    await checkAccountLinkThrottle({
      surface: "callback",
      ip: "203.0.113.8",
      redis,
    });
  }
  const result = await checkAccountLinkThrottle({
    surface: "callback",
    ip: "203.0.113.8",
    redis,
  });
  assert.deepEqual(result, { ok: false, reason: "rate_limited" });
});

test("rejects with redis_unavailable when redis is null", async () => {
  // FAIL-CLOSED. A replayed account link can MOVE a platform account between
  // contacts, so a cache miss must never wave one through.
  const result = await checkAccountLinkThrottle({
    surface: "start",
    ip: "203.0.113.9",
    redis: null,
  });
  assert.deepEqual(result, { ok: false, reason: "redis_unavailable" });
});

test("rejects with redis_unavailable when redis throws", async () => {
  const { redis } = fakeRedis({ throwOnIncr: true });
  const result = await checkAccountLinkThrottle({
    surface: "start",
    ip: "203.0.113.10",
    redis,
  });
  assert.deepEqual(result, { ok: false, reason: "redis_unavailable" });
});

test("sets the TTL exactly once, on the first increment", async () => {
  const { redis, expires } = fakeRedis();
  for (let i = 0; i < 5; i++) {
    await checkAccountLinkThrottle({
      surface: "start",
      ip: "203.0.113.11",
      redis,
    });
  }
  assert.deepEqual(expires, [
    { key: "hogsend:al:throttle:start:203.0.113.11", seconds: 900 },
  ]);
});

test("the warm path adds a per-contact budget on its own key", async () => {
  const { redis, counts } = fakeRedis();
  await checkAccountLinkThrottle({
    surface: "start",
    ip: "203.0.113.12",
    contactId: "c-1",
    redis,
  });
  assert.equal(counts.get("hogsend:al:throttle:start:203.0.113.12"), 1);
  assert.equal(counts.get("hogsend:al:throttle:contact:c-1"), 1);
});

test("a per-contact budget over the cap rejects even from a fresh IP", async () => {
  const { redis } = fakeRedis();
  for (let i = 0; i < 20; i++) {
    await checkAccountLinkThrottle({
      surface: "start",
      ip: `198.51.100.${i}`,
      contactId: "c-hot",
      redis,
    });
  }
  const result = await checkAccountLinkThrottle({
    surface: "start",
    ip: "198.51.100.200",
    contactId: "c-hot",
    redis,
  });
  assert.deepEqual(result, { ok: false, reason: "rate_limited" });
});

test("a contact-only call bumps the contact budget and no IP budget", async () => {
  // `/start` calls this shape for the WARM leg, after the binding is known —
  // re-passing the IP would double-count it against its own budget.
  const { redis, counts } = fakeRedis();
  const result = await checkAccountLinkThrottle({
    surface: "start",
    contactId: "c-2",
    redis,
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual([...counts.keys()], ["hogsend:al:throttle:contact:c-2"]);
});

test("start and callback hold separate budgets", async () => {
  const { redis, counts } = fakeRedis();
  await checkAccountLinkThrottle({ surface: "start", ip: "1.2.3.4", redis });
  await checkAccountLinkThrottle({ surface: "callback", ip: "1.2.3.4", redis });
  assert.equal(counts.get("hogsend:al:throttle:start:1.2.3.4"), 1);
  assert.equal(counts.get("hogsend:al:throttle:cb:1.2.3.4"), 1);
});

test("config overrides the window and the cap", async () => {
  const { redis, expires } = fakeRedis();
  const config = { windowSeconds: 60, max: 1 };
  assert.deepEqual(
    await checkAccountLinkThrottle({
      surface: "start",
      ip: "5.6.7.8",
      config,
      redis,
    }),
    { ok: true },
  );
  assert.deepEqual(
    await checkAccountLinkThrottle({
      surface: "start",
      ip: "5.6.7.8",
      config,
      redis,
    }),
    { ok: false, reason: "rate_limited" },
  );
  assert.deepEqual(expires, [
    { key: "hogsend:al:throttle:start:5.6.7.8", seconds: 60 },
  ]);
});
