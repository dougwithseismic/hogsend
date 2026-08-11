import assert from "node:assert/strict";
import test from "node:test";
import type { env as envSchema } from "../env.js";
import { emailProvidersFromEnv } from "./email-providers-from-env.js";
import { loadOptionalPlugin } from "./load-optional-plugin.js";

// This test process never sets HOGSEND_EMAIL_TOKEN (nor POSTMARK_SERVER_TOKEN),
// so the module-scope guarded dynamic imports in email-providers-from-env.ts
// must NOT have fired — which is exactly the posture the assertions below pin.
// The token-present posture lives in email-providers-from-env.hogsend.test.ts:
// node:test runs each file in its own process, so both hold simultaneously.

test("no HOGSEND_EMAIL_TOKEN → no hogsend provider (the package is never imported)", () => {
  const providers = emailProvidersFromEnv({} as unknown as typeof envSchema);
  assert.equal(
    providers.find((p) => p.meta?.id === "hogsend"),
    undefined,
  );
});

test("token in the passed env but the factory never loaded → skipped, no throw", () => {
  // HOGSEND_EMAIL_TOKEN was unset at module load, so the factory is null even
  // when the *passed* env carries a token — the same degraded state as "token
  // set but package not installed". The preset must skip, never throw: a
  // container that then selects `hogsend` fails at boot with the registry's own
  // unresolvable-provider error, which is the loud, correct place for it.
  const providers = emailProvidersFromEnv({
    HOGSEND_EMAIL_TOKEN: "hsrel_test_token",
    HOGSEND_EMAIL_RELAY_URL: "https://cloud.example.com",
    HOGSEND_EMAIL_WEBHOOK_SECRET: "whsec_test",
  } as unknown as typeof envSchema);
  assert.deepEqual(providers, []);
});

test("a hogsend load failure WARNS, naming the package and the enabling variable", async () => {
  // The preset hands `loadOptionalPlugin` the same `enabledBy` string it uses
  // in production. An INJECTED unresolvable specifier stands in for the real
  // package: `@hogsend/plugin-hogsend` is an engine optionalDependency, so an
  // absence-based test would silently invert its meaning once it resolves.
  const warnings: string[] = [];
  const factory = await loadOptionalPlugin({
    specifier: "@hogsend/plugin-hogsend-does-not-exist",
    exportName: "createHogsendEmailProvider",
    enabledBy: "HOGSEND_EMAIL_TOKEN is set",
    onFailure: (message) => warnings.push(message),
  });

  assert.equal(factory, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /@hogsend\/plugin-hogsend-does-not-exist/);
  assert.match(warnings[0] ?? "", /HOGSEND_EMAIL_TOKEN is set/);
});
