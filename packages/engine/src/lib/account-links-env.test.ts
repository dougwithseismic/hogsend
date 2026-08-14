import assert from "node:assert/strict";
import test from "node:test";

// env.ts validates at IMPORT time (t3-env parses process.env once), so the
// required vars are stubbed BEFORE the dynamic import below — the
// email-provider-boot.test.ts idiom. No ACCOUNT_LINK_* / STEAM_WEB_API_KEY var
// is set, which is exactly the case under test: an entirely-unset account-link
// block must leave validation green and the TTL on its default.
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "error";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.BETTER_AUTH_SECRET ??=
  "test-secret-for-node-test-minimum-32-characters-long";
process.env.HATCHET_CLIENT_TOKEN ??=
  "eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ.eyJhdWQiOiJsb2NhbGhvc3QiLCJleHAiOjQ5MzMyNDA5ODMsImdycGNfYnJvYWRjYXN0X2FkZHJlc3MiOiJsb2NhbGhvc3Q6NzA3NyIsImlhdCI6MTc3OTY0MDk4MywiaXNzIjoibG9jYWxob3N0Iiwic2VydmVyX3VybCI6ImxvY2FsaG9zdCIsInN1YiI6InRlc3QtdGVuYW50LWlkIiwidG9rZW5faWQiOiJ0ZXN0LXRva2VuLWlkIn0.test";
for (const name of [
  "ACCOUNT_LINK_TWITCH_CLIENT_ID",
  "ACCOUNT_LINK_TWITCH_CLIENT_SECRET",
  "STEAM_WEB_API_KEY",
  "ACCOUNT_LINK_ALLOWED_ORIGINS",
  "ACCOUNT_LINK_STATE_TTL_SECONDS",
]) {
  delete process.env[name];
}

const { env } = await import("../env.js");

test("ACCOUNT_LINK_STATE_TTL_SECONDS defaults to 900", () => {
  assert.equal(env.ACCOUNT_LINK_STATE_TTL_SECONDS, 900);
});

test("an unset ACCOUNT_LINK_* block leaves env validation green", () => {
  // The import above already proved validation passed (a failure throws at
  // module load). Pin the unset optionals to undefined so a future .default()
  // or .min(1) requirement on them is a deliberate change, not drift.
  assert.equal(env.ACCOUNT_LINK_TWITCH_CLIENT_ID, undefined);
  assert.equal(env.ACCOUNT_LINK_TWITCH_CLIENT_SECRET, undefined);
  assert.equal(env.STEAM_WEB_API_KEY, undefined);
  assert.equal(env.ACCOUNT_LINK_ALLOWED_ORIGINS, undefined);
});
