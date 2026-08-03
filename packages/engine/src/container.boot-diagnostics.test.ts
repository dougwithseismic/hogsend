import assert from "node:assert/strict";
import test from "node:test";
import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";

// env.ts validates process.env ONCE at first import, so the boot contract must
// be in place BEFORE any engine module loads — hence the dynamic imports below
// (static imports would hoist above these assignments). Mirrors the env set
// apps/api's vitest config injects, minus every provider credential: this
// suite asserts the DIAGNOSTICS a credential-less boot records.
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
process.env.BETTER_AUTH_SECRET =
  "test-secret-for-node-test-minimum-32-characters";
// The same structurally-valid dummy JWT apps/api's vitest config uses — the
// Hatchet SDK decodes it at module scope (lib/hatchet.ts) but never connects.
process.env.HATCHET_CLIENT_TOKEN =
  "eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ.eyJhdWQiOiJsb2NhbGhvc3QiLCJleHAiOjQ5MzMyNDA5ODMsImdycGNfYnJvYWRjYXN0X2FkZHJlc3MiOiJsb2NhbGhvc3Q6NzA3NyIsImlhdCI6MTc3OTY0MDk4MywiaXNzIjoibG9jYWxob3N0Iiwic2VydmVyX3VybCI6ImxvY2FsaG9zdCIsInN1YiI6InRlc3QtdGVuYW50LWlkIiwidG9rZW5faWQiOiJ0ZXN0LXRva2VuLWlkIn0.test";
// A misconfiguration-free email/analytics posture is load-bearing for the
// assertions below: no provider key set ⇒ the container must boot INERT and
// record `email.no-provider` instead of crashing.
delete process.env.RESEND_API_KEY;
delete process.env.POSTMARK_SERVER_TOKEN;
delete process.env.EMAIL_PROVIDER;
delete process.env.POSTHOG_API_KEY;
// The unsecured contact source below resolves its secret via
// `env[envKey] ?? process.env[envKey]` — both must be unset.
delete process.env.TEST_CONTACT_SOURCE_SECRET_UNSET;

const { createHogsendClient } = await import("./container.js");
const { getBootDiagnostics } = await import("./lib/boot-diagnostics.js");
const { defineContactSource } = await import(
  "./sources/define-contact-source.js"
);

function unsecuredSource(id: string) {
  return defineContactSource({
    meta: { id, name: `Unsecured ${id}` },
    auth: {
      type: "match",
      header: "x-webhook-secret",
      envKey: "TEST_CONTACT_SOURCE_SECRET_UNSET",
    },
    transform: async () => null,
  });
}

// ONE boot covers both criteria: the container detects no-email-provider and
// the unsecured contact sources in the same createHogsendClient call. The
// hatchet override keeps boot off real gRPC (the apps/api test convention).
createHogsendClient({
  contactSources: [
    unsecuredSource("test-crm-a"),
    unsecuredSource("test-crm-b"),
  ],
  overrides: { hatchet: {} as unknown as HatchetClient },
});

// Assertions target specific codes, never absolute collector counts: the
// collector is process-global, and module-scope recordings (plugin loaders)
// never re-evaluate — a count assertion would measure the wrong thing.
function codes() {
  return getBootDiagnostics().map((d) => d.code);
}

test("AC3: no email provider configured → records email.no-provider", () => {
  const recorded = getBootDiagnostics().find(
    (d) => d.code === "email.no-provider",
  );
  assert.ok(recorded, "expected an email.no-provider boot diagnostic");
  // The message must name the way out, same as the boot warn.
  assert.match(recorded.message, /RESEND_API_KEY/);
});

test("AC4: contact source with match auth and no secret → records per-source diagnostic", () => {
  // TWO unsecured sources must yield TWO entries — the source id is baked into
  // the code so distinct occurrences never silently dedupe into one.
  assert.ok(codes().includes("contact-source.no-secret:test-crm-a"));
  assert.ok(codes().includes("contact-source.no-secret:test-crm-b"));
  const recorded = getBootDiagnostics().find(
    (d) => d.code === "contact-source.no-secret:test-crm-a",
  );
  // The message names the env var to set — that is the fix.
  assert.match(recorded?.message ?? "", /TEST_CONTACT_SOURCE_SECRET_UNSET/);
});
