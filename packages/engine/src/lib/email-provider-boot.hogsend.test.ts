import assert from "node:assert/strict";
import test from "node:test";

// The positive half of email-provider-boot.test.ts, in its own process because
// the two need opposite HOGSEND_EMAIL_TOKEN postures at module load (the guarded
// dynamic import fires at module scope). Together they are the whole contract:
// token present ⇒ registered and resolvable; token absent ⇒ boot throws.
//
// This is the end-to-end wiring proof for the engine side of PRD 10 — env var →
// guarded import → preset → EmailProviderRegistry → the ACTIVE provider the
// tracked mailer sends through. No network: the provider is constructed, never
// called.
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "error";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.BETTER_AUTH_SECRET ??=
  "test-secret-for-node-test-minimum-32-characters-long";
process.env.HATCHET_CLIENT_TOKEN ??=
  "eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ.eyJhdWQiOiJsb2NhbGhvc3QiLCJleHAiOjQ5MzMyNDA5ODMsImdycGNfYnJvYWRjYXN0X2FkZHJlc3MiOiJsb2NhbGhvc3Q6NzA3NyIsImlhdCI6MTc3OTY0MDk4MywiaXNzIjoibG9jYWxob3N0Iiwic2VydmVyX3VybCI6ImxvY2FsaG9zdCIsInN1YiI6InRlc3QtdGVuYW50LWlkIiwidG9rZW5faWQiOiJ0ZXN0LXRva2VuLWlkIn0.test";
// Exactly what a provisioned Cloud environment gets — and deliberately NO
// RESEND_API_KEY, which is the point: a Cloud instance sends with no Resend
// account anywhere in the picture.
process.env.HOGSEND_EMAIL_TOKEN = "hsrel_boot_test_token";
process.env.HOGSEND_EMAIL_RELAY_URL = "https://cloud.example.com";
process.env.HOGSEND_EMAIL_WEBHOOK_SECRET = "whsec_boot_test";
process.env.EMAIL_PROVIDER = "hogsend";

const { createHogsendClient } = await import("../container.js");

test("EMAIL_PROVIDER=hogsend + a relay token → hogsend is the ACTIVE provider", () => {
  const client = createHogsendClient();

  assert.equal(client.emailProvider.meta?.id, "hogsend");
  assert.ok(
    client.emailProviders.get("hogsend"),
    "the registry must hold the provider the webhook route dispatches by id",
  );
  // No Resend key was set, so nothing else is registered — a Cloud instance
  // boots and sends with no Resend account at all.
  assert.deepEqual(
    client.emailProviders.getAll().map((p) => p.meta?.id),
    ["hogsend"],
  );
});
