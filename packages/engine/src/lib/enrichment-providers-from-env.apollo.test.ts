import assert from "node:assert/strict";
import test from "node:test";
import type { env as envSchema } from "../env.js";

// A SEPARATE test file from enrichment-providers-from-env.test.ts on purpose:
// that file's assertions require APOLLO_API_KEY to be UNSET when the module's
// scope runs, while this one requires it SET. The node:test runner executes
// each file in its own process, so both postures hold simultaneously.
//
// The key must be in the environment BEFORE the module is imported — the
// guarded dynamic import of @hogsend/plugin-apollo fires at module scope.
process.env.APOLLO_API_KEY = "apollo-preset-test-key";

test("PRD 04 T4.3: APOLLO_API_KEY set → env preset resolves the Apollo provider", async () => {
  const { enrichmentProvidersFromEnv } = await import(
    "./enrichment-providers-from-env.js"
  );
  const providers = enrichmentProvidersFromEnv({
    APOLLO_API_KEY: "apollo-preset-test-key",
  } as unknown as typeof envSchema);

  // @hogsend/plugin-apollo is now in the engine's optionalDependencies, so
  // the guarded dynamic import resolves and the preset produces a provider.
  assert.equal(providers.length, 1);
  const provider = providers[0];
  assert.equal(provider?.meta.id, "apollo");
  assert.equal(provider?.capabilities.personLookup, true);
  assert.equal(provider?.capabilities.companyLookup, true);
  assert.equal(typeof provider?.enrichPerson, "function");
});
