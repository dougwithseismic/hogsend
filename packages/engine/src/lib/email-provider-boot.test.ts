import assert from "node:assert/strict";
import test from "node:test";

// EMAIL_PROVIDER=hogsend with the package/token absent must fail LOUDLY at boot,
// exactly like any other unresolvable id. Nothing about Hogsend Email gets a
// softer landing than Postmark does: a typo'd or unbuildable active provider is
// a config error, and the one thing it must never do is silently fall back to
// Resend and mail from the wrong sender.
//
// Env is set BEFORE the container is imported — env.ts validates at module
// scope. No DATABASE_URL connection is opened: `postgres()` is lazy and the
// throw happens during registry resolution, well before any query.
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "error";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.BETTER_AUTH_SECRET ??=
  "test-secret-for-node-test-minimum-32-characters-long";
process.env.HATCHET_CLIENT_TOKEN ??=
  "eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ.eyJhdWQiOiJsb2NhbGhvc3QiLCJleHAiOjQ5MzMyNDA5ODMsImdycGNfYnJvYWRjYXN0X2FkZHJlc3MiOiJsb2NhbGhvc3Q6NzA3NyIsImlhdCI6MTc3OTY0MDk4MywiaXNzIjoibG9jYWxob3N0Iiwic2VydmVyX3VybCI6ImxvY2FsaG9zdCIsInN1YiI6InRlc3QtdGVuYW50LWlkIiwidG9rZW5faWQiOiJ0ZXN0LXRva2VuLWlkIn0.test";
// The provider is SELECTED but nothing registers it: no HOGSEND_EMAIL_TOKEN
// (so the plugin is never even imported) and a Resend key so the registry is
// non-empty — which is the case that would otherwise silently degrade.
process.env.EMAIL_PROVIDER = "hogsend";
process.env.RESEND_API_KEY ??= "re_test_000000000000000000000000";

const { createHogsendClient } = await import("../container.js");

test("EMAIL_PROVIDER=hogsend with no provider registered throws at boot", () => {
  assert.throws(
    () => createHogsendClient(),
    /email provider "hogsend" is not registered/,
  );
});
