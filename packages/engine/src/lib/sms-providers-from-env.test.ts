import assert from "node:assert/strict";
import test from "node:test";
import type { env as envSchema } from "../env.js";
import { getBootDiagnostics } from "./boot-diagnostics.js";
import { smsProvidersFromEnv } from "./sms-providers-from-env.js";

// This test process never sets TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN, so the
// module-scope guarded dynamic import in sms-providers-from-env.ts must not
// have fired — `createTwilioProvider` is null and the preset can never push a
// provider here. What IS testable is the creds-without-sender DETECTION, which
// keys on the env object passed per call, not the module-load snapshot.
//
// Assertions target the specific `sms.no-sender` code, never absolute
// collector counts: the collector is process-global and module-scope loader
// recordings never re-evaluate, so a count can move for unrelated reasons.
function noSenderDiagnostic() {
  return getBootDiagnostics().find((d) => d.code === "sms.no-sender");
}

function fakeEnv(overrides: Record<string, string | undefined>) {
  return {
    API_PUBLIC_URL: "http://localhost:3002",
    ...overrides,
  } as unknown as typeof envSchema;
}

// ORDER MATTERS: the negative cases run BEFORE the positive one. Once the
// positive case records `sms.no-sender` it stays in the process-global
// collector, so an absence assertion after it would be meaningless.

test("no Twilio creds → no warn, no sms.no-sender diagnostic", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  assert.deepEqual(smsProvidersFromEnv(fakeEnv({})), []);
  assert.equal(warn.mock.callCount(), 0);
  assert.equal(noSenderDiagnostic(), undefined);
});

test("creds WITH a sender → no sms.no-sender diagnostic", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  // The factory is null in this process (creds unset at module load), so the
  // preset list stays empty — but a configured sender means the sender check
  // must stay quiet.
  assert.deepEqual(
    smsProvidersFromEnv(
      fakeEnv({
        TWILIO_ACCOUNT_SID: "ACtest",
        TWILIO_AUTH_TOKEN: "token",
        SMS_FROM: "+15555550100",
      }),
    ),
    [],
  );
  assert.equal(warn.mock.callCount(), 0);
  assert.equal(noSenderDiagnostic(), undefined);
});

test("AC13: creds WITHOUT a sender → warns AND records sms.no-sender", (t) => {
  // The previously fully-silent skip: Twilio creds set, but neither SMS_FROM
  // nor TWILIO_MESSAGING_SERVICE_SID — the container installs the inert
  // throwing SMS stub and (pre-fix) the first symptom was `sendSms` throwing
  // at send time. Both channels must fire: the stdout warn (operator's first
  // channel) and the boot diagnostic (the queryable second one).
  const warn = t.mock.method(console, "warn", () => {});
  assert.deepEqual(
    smsProvidersFromEnv(
      fakeEnv({
        TWILIO_ACCOUNT_SID: "ACtest",
        TWILIO_AUTH_TOKEN: "token",
      }),
    ),
    [],
  );
  assert.equal(warn.mock.callCount(), 1);
  const warned = String(warn.mock.calls[0]?.arguments[0] ?? "");
  // The message must name BOTH ways out, or the operator can't fix it.
  assert.match(warned, /SMS_FROM/);
  assert.match(warned, /TWILIO_MESSAGING_SERVICE_SID/);
  const recorded = noSenderDiagnostic();
  assert.ok(recorded, "expected an sms.no-sender boot diagnostic");
  assert.equal(recorded.message, warned);
});
