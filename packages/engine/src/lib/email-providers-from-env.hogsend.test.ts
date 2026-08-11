import assert from "node:assert/strict";
import test from "node:test";
import type { env as envSchema } from "../env.js";

// A SEPARATE test file from email-providers-from-env.test.ts on purpose: that
// file's assertions require HOGSEND_EMAIL_TOKEN to be UNSET when the module's
// scope runs, while this one requires it SET. The node:test runner executes each
// file in its own process, so both postures hold simultaneously.
//
// The token must be in the environment BEFORE the module is imported — the
// guarded dynamic import of @hogsend/plugin-hogsend fires at module scope.
process.env.HOGSEND_EMAIL_TOKEN = "hsrel_preset_test_token";

// `lib/tracked.ts` (the home of the capability gate) validates the engine's env
// contract at module scope, so these must be in place before it is imported.
// Nothing here dials anything: the gate is a pure read of `provider.capabilities`.
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "error";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.BETTER_AUTH_SECRET ??=
  "test-secret-for-node-test-minimum-32-characters-long";
process.env.HATCHET_CLIENT_TOKEN ??=
  "eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ.eyJhdWQiOiJsb2NhbGhvc3QiLCJleHAiOjQ5MzMyNDA5ODMsImdycGNfYnJvYWRjYXN0X2FkZHJlc3MiOiJsb2NhbGhvc3Q6NzA3NyIsImlhdCI6MTc3OTY0MDk4MywiaXNzIjoibG9jYWxob3N0Iiwic2VydmVyX3VybCI6ImxvY2FsaG9zdCIsInN1YiI6InRlc3QtdGVuYW50LWlkIiwidG9rZW5faWQiOiJ0ZXN0LXRva2VuLWlkIn0.test";

const { providerConsumesIdempotencyKey } = await import("./tracked.js");

const RELAY = "https://cloud.example.com";

async function preset(over: Record<string, string | undefined> = {}) {
  const { emailProvidersFromEnv } = await import(
    "./email-providers-from-env.js"
  );
  return emailProvidersFromEnv({
    HOGSEND_EMAIL_TOKEN: "hsrel_preset_test_token",
    HOGSEND_EMAIL_RELAY_URL: RELAY,
    HOGSEND_EMAIL_WEBHOOK_SECRET: "whsec_preset_test",
    ...over,
  } as unknown as typeof envSchema);
}

test("HOGSEND_EMAIL_TOKEN set → the env preset registers the `hogsend` provider", async () => {
  const providers = await preset();

  // @hogsend/plugin-hogsend is an engine optionalDependency, so the guarded
  // dynamic import resolves and the preset produces a provider.
  const hogsend = providers.find((p) => p.meta?.id === "hogsend");
  assert.ok(hogsend, "expected a provider with meta.id === 'hogsend'");
  assert.equal(typeof hogsend.send, "function");
  // DECISIONS §3.6 — first-party tracking is sovereign, SES has no scheduled
  // send, and the relay signs every webhook.
  assert.equal(hogsend.capabilities?.nativeTracking, false);
  assert.equal(hogsend.capabilities?.scheduledSend, false);
  assert.equal(hogsend.capabilities?.signedWebhooks, true);
  // The relay lifts `Idempotency-Key` off the message onto the relay REQUEST, so
  // this transport is the one that may be handed the engine's internal key. It
  // says so by DECLARING it — the engine no longer infers it from the id.
  assert.equal(hogsend.capabilities?.consumesIdempotencyKey, true);
  assert.equal(providerConsumesIdempotencyKey(hogsend), true);
});

test("the REAL resend provider declares no such capability → wire unchanged", async () => {
  // The non-breaking-change claim, asserted rather than assumed. Resend forwards
  // `SendEmailOptions.headers` verbatim onto the delivered message, so if this
  // ever flipped, every existing self-hosted deploy would start stamping Hatchet
  // run ids — and, on campaign sends, the recipient's own address — onto real
  // customer mail on nothing more than an engine upgrade.
  const providers = await preset({ RESEND_API_KEY: "re_test_key" });
  const resend = providers.find((p) => p.meta?.id === "resend");

  assert.ok(resend, "expected a provider with meta.id === 'resend'");
  assert.equal(resend.capabilities?.consumesIdempotencyKey, undefined);
  assert.equal(providerConsumesIdempotencyKey(resend), false);
});

test("the preset REGISTERS the provider; it does not make it active", async () => {
  // Postmark's exact posture: registering is not selecting. EMAIL_PROVIDER (or
  // `email.defaultProvider`) is the only thing that switches the active wire, so
  // a Cloud instance that somehow got a token without EMAIL_PROVIDER=hogsend
  // keeps sending through whatever it sent through before.
  const providers = await preset({ RESEND_API_KEY: "re_test_key" });
  const ids = providers.map((p) => p.meta?.id);
  assert.deepEqual(ids, ["resend", "hogsend"]);
});

test("token set but no relay URL → warns and skips, never a provider pointed at nowhere", async () => {
  // The relay URL has NO default on purpose (staging and production control
  // planes have different origins), so a token without one is a
  // misconfiguration. Building the provider anyway would defer the failure to
  // the first send, against an `undefined/api/email/send` URL. Silence would be
  // worse still — the same swallowed-failure bug the Postmark block was fixed
  // for — so it warns and names the missing variable.
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  let providers: Awaited<ReturnType<typeof preset>>;
  try {
    providers = await preset({ HOGSEND_EMAIL_RELAY_URL: undefined });
  } finally {
    console.warn = original;
  }

  assert.equal(
    providers.find((p) => p.meta?.id === "hogsend"),
    undefined,
  );
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]?.[0]), /HOGSEND_EMAIL_RELAY_URL/);
});
