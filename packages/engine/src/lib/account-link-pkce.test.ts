import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  type AccountLinkPkceRedis,
  generatePkcePair,
  storePkceVerifier,
  takePkceVerifier,
} from "./account-link-pkce.js";

/** A fake with real `SET NX EX` / `GETDEL` semantics — the two that matter. */
function fakeRedis(): AccountLinkPkceRedis & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async set(key, value, _ex, _ttl, _nx) {
      if (store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    async getdel(key) {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    },
  };
}

test("the challenge is the base64url SHA-256 of the verifier", () => {
  const { verifier, challenge } = generatePkcePair();
  assert.equal(
    challenge,
    createHash("sha256").update(verifier).digest("base64url"),
  );
  // base64url only — a `+`, `/` or `=` breaks the authorize URL.
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
});

test("the verifier length is within RFC 7636 bounds", () => {
  for (let i = 0; i < 25; i++) {
    const { verifier } = generatePkcePair();
    assert.ok(
      verifier.length >= 43 && verifier.length <= 128,
      `verifier length ${verifier.length} is outside RFC 7636's 43..128`,
    );
    // RFC 7636 unreserved charset.
    assert.match(verifier, /^[A-Za-z0-9._~-]+$/);
  }
});

test("two pairs are never the same", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) seen.add(generatePkcePair().verifier);
  assert.equal(seen.size, 50);
});

test("takePkceVerifier returns the verifier once and null thereafter", async () => {
  const redis = fakeRedis();
  assert.equal(
    await storePkceVerifier("nonce-1", "verifier-1", 900, redis),
    true,
  );

  assert.equal(await takePkceVerifier("nonce-1", redis), "verifier-1");
  // GETDEL, not GET: single-use even if the nonce burn were somehow bypassed.
  assert.equal(await takePkceVerifier("nonce-1", redis), null);
  assert.equal(redis.store.size, 0);
});

test("takePkceVerifier returns null for an unknown nonce", async () => {
  assert.equal(await takePkceVerifier("never-stored", fakeRedis()), null);
});

test("storePkceVerifier refuses to overwrite an existing nonce", async () => {
  const redis = fakeRedis();
  assert.equal(await storePkceVerifier("nonce-2", "first", 900, redis), true);
  assert.equal(await storePkceVerifier("nonce-2", "second", 900, redis), false);
  // The original custody is intact — a collision never silently rebinds it.
  assert.equal(await takePkceVerifier("nonce-2", redis), "first");
});

test("a null redis stores nothing and takes nothing (fail closed)", async () => {
  assert.equal(await storePkceVerifier("nonce-3", "v", 900, null), false);
  assert.equal(await takePkceVerifier("nonce-3", null), null);
});

test("the key is namespaced per nonce", async () => {
  const redis = fakeRedis();
  await storePkceVerifier("abc", "v", 900, redis);
  assert.deepEqual([...redis.store.keys()], ["account_link:pkce:abc"]);
});
