import assert from "node:assert/strict";
import test from "node:test";

// The half-configured-twitch boot needs ACCOUNT_LINK_TWITCH_CLIENT_ID set and
// _CLIENT_SECRET unset at env-parse time, and t3-env parses process.env
// exactly once per import — so this combination lives in its own file (its own
// node:test process), the container.account-links.env.test.ts split. Env is
// set BEFORE the container import; LOG_LEVEL=warn so the warning under test is
// actually emitted.
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "warn";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.BETTER_AUTH_SECRET ??=
  "test-secret-for-node-test-minimum-32-characters-long";
process.env.HATCHET_CLIENT_TOKEN ??=
  "eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ.eyJhdWQiOiJsb2NhbGhvc3QiLCJleHAiOjQ5MzMyNDA5ODMsImdycGNfYnJvYWRjYXN0X2FkZHJlc3MiOiJsb2NhbGhvc3Q6NzA3NyIsImlhdCI6MTc3OTY0MDk4MywiaXNzIjoibG9jYWxob3N0Iiwic2VydmVyX3VybCI6ImxvY2FsaG9zdCIsInN1YiI6InRlc3QtdGVuYW50LWlkIiwidG9rZW5faWQiOiJ0ZXN0LXRva2VuLWlkIn0.test";
process.env.ACCOUNT_LINK_TWITCH_CLIENT_ID = "env-twitch-client-id";
delete process.env.ACCOUNT_LINK_TWITCH_CLIENT_SECRET;

const { createHogsendClient } = await import("./container.js");

/** Same boot-capture idiom as container.account-links.test.ts. */
function captureBoot<T>(fn: () => T): { value: T; out: string } {
  const original = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = ((chunk: unknown) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    return { value: fn(), out };
  } finally {
    process.stdout.write = original;
  }
}

const HALF_CONFIGURED_WARN = "twitch account linking is half-configured";

test("warns once, does not throw, on a half-configured twitch", () => {
  // Does not throw — the boot completes…
  const { value: client, out } = captureBoot(() => createHogsendClient());
  // …twitch is ABSENT from the registry (not present-but-disabled), steam
  // still registers…
  assert.deepEqual(client.accountLinkProviders.ids(), ["steam"]);
  // …and the warning fires exactly once, naming the MISSING var.
  assert.equal(out.split(HALF_CONFIGURED_WARN).length - 1, 1);
  assert.match(out, /ACCOUNT_LINK_TWITCH_CLIENT_SECRET is unset/);
});
