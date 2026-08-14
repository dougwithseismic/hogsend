import assert from "node:assert/strict";
import test from "node:test";
import {
  type AccountLinkNonceRedis,
  burnAccountLinkNonce,
  NONCE_BURN_TTL_SECONDS,
} from "./account-link-nonce.js";

/** Real `SET NX EX` semantics, plus a record of the exact arguments. */
function fakeRedis(opts: { throws?: boolean } = {}): AccountLinkNonceRedis & {
  claimed: Map<string, { ttl: number }>;
} {
  const claimed = new Map<string, { ttl: number }>();
  return {
    claimed,
    async set(key, _value, _ex, ttlSeconds, _nx) {
      if (opts.throws) throw new Error("connection lost");
      if (claimed.has(key)) return null;
      claimed.set(key, { ttl: ttlSeconds });
      return "OK";
    },
  };
}

test("burns a nonce exactly once", async () => {
  const redis = fakeRedis();
  assert.equal(await burnAccountLinkNonce("n-1", redis), true);
  assert.equal(await burnAccountLinkNonce("n-1", redis), false);
});

test("the marker key and TTL mirror the connector burn byte-for-byte in shape", async () => {
  const redis = fakeRedis();
  await burnAccountLinkNonce("n-2", redis);
  assert.deepEqual(
    [...redis.claimed.entries()],
    [["account_link:state:used:n-2", { ttl: NONCE_BURN_TTL_SECONDS }]],
  );
  assert.equal(NONCE_BURN_TTL_SECONDS, 900);
});

test("a null redis REFUSES the burn (fail closed, unlike the connector route)", async () => {
  // The connector callback degrades to TTL-only validity here. This one must
  // not: a replayed account-link callback can MOVE a link (DECISIONS §6.1).
  assert.equal(await burnAccountLinkNonce("n-3", null), false);
});

test("a throwing redis REFUSES the burn", async () => {
  assert.equal(
    await burnAccountLinkNonce("n-4", fakeRedis({ throws: true })),
    false,
  );
});
