import {
  acquireLeaderLease,
  newLeaseToken,
  releaseLeaderLease,
  renewLeaderLease,
} from "@hogsend/engine";
import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";

/**
 * In-memory stand-in for the two Redis ops the lease uses: `SET … NX PX` and the
 * two compare-and-set Lua scripts (renew = compare-then-PEXPIRE, release =
 * compare-then-DEL). It interprets the fencing exactly as the real scripts do —
 * an op only succeeds when the stored value equals the caller's token — so the
 * "non-owner cannot renew/release" invariant is exercised without a live Redis.
 */
class FakeRedis {
  store = new Map<string, string>();

  async set(
    key: string,
    value: string,
    ...opts: (string | number)[]
  ): Promise<"OK" | null> {
    const nx = opts.includes("NX");
    if (nx && this.store.has(key)) return null;
    this.store.set(key, value);
    return "OK";
  }

  async eval(
    script: string,
    _numKeys: number,
    key: string,
    token: string,
  ): Promise<number> {
    if (this.store.get(key) !== token) return 0; // not the owner — fenced out
    if (script.includes("del")) {
      this.store.delete(key);
      return 1;
    }
    return 1; // renew (pexpire) — ownership confirmed
  }
}

function fake(): { redis: Redis; store: Map<string, string> } {
  const r = new FakeRedis();
  return { redis: r as unknown as Redis, store: r.store };
}

const KEY = "hogsend:connector-runtime:test:leader";

describe("leader lease", () => {
  it("only the first acquirer wins (SET NX)", async () => {
    const { redis } = fake();
    const a = newLeaseToken();
    const b = newLeaseToken();

    expect(
      await acquireLeaderLease({ key: KEY, token: a, ttlMs: 30_000, redis }),
    ).toBe(true);
    // A different replica racing the same key loses while A holds it.
    expect(
      await acquireLeaderLease({ key: KEY, token: b, ttlMs: 30_000, redis }),
    ).toBe(false);
  });

  it("only the owner can renew", async () => {
    const { redis } = fake();
    const owner = newLeaseToken();
    const other = newLeaseToken();
    await acquireLeaderLease({ key: KEY, token: owner, ttlMs: 30_000, redis });

    expect(
      await renewLeaderLease({ key: KEY, token: owner, ttlMs: 30_000, redis }),
    ).toBe(true);
    // A stale ex-leader cannot extend a lease it no longer owns.
    expect(
      await renewLeaderLease({ key: KEY, token: other, ttlMs: 30_000, redis }),
    ).toBe(false);
  });

  it("a non-owner cannot release someone else's lease", async () => {
    const { redis, store } = fake();
    const owner = newLeaseToken();
    const other = newLeaseToken();
    await acquireLeaderLease({ key: KEY, token: owner, ttlMs: 30_000, redis });

    expect(await releaseLeaderLease({ key: KEY, token: other, redis })).toBe(
      false,
    );
    // The owner's key is untouched.
    expect(store.get(KEY)).toBe(owner);

    expect(await releaseLeaderLease({ key: KEY, token: owner, redis })).toBe(
      true,
    );
    expect(store.has(KEY)).toBe(false);
  });

  it("the lease is re-acquirable after release (failover)", async () => {
    const { redis } = fake();
    const first = newLeaseToken();
    const second = newLeaseToken();
    await acquireLeaderLease({ key: KEY, token: first, ttlMs: 30_000, redis });
    await releaseLeaderLease({ key: KEY, token: first, redis });

    // A standby replica takes over once the lease is free.
    expect(
      await acquireLeaderLease({
        key: KEY,
        token: second,
        ttlMs: 30_000,
        redis,
      }),
    ).toBe(true);
  });

  it("acquire/renew/release fail safe (no throw) when Redis errors", async () => {
    const throwing = {
      async set() {
        throw new Error("redis down");
      },
      async eval() {
        throw new Error("redis down");
      },
    } as unknown as Redis;
    const token = newLeaseToken();

    // Fail-safe: no lease ⇒ no socket, never an unhandled throw.
    expect(
      await acquireLeaderLease({
        key: KEY,
        token,
        ttlMs: 30_000,
        redis: throwing,
      }),
    ).toBe(false);
    expect(
      await renewLeaderLease({
        key: KEY,
        token,
        ttlMs: 30_000,
        redis: throwing,
      }),
    ).toBe(false);
    expect(await releaseLeaderLease({ key: KEY, token, redis: throwing })).toBe(
      false,
    );
  });
});
