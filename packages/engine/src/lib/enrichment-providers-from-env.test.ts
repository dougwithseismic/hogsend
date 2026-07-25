import assert from "node:assert/strict";
import test from "node:test";
import type { env as envSchema } from "../env.js";
import {
  enrichmentProvidersFromEnv,
  loadEnrichmentPluginFactory,
} from "./enrichment-providers-from-env.js";

// This test process never sets APOLLO_API_KEY, so the module-scope guarded
// dynamic import in enrichment-providers-from-env.ts must not have fired —
// which is exactly the AC 6 posture the assertions below pin.
const baseEnv = { APOLLO_API_KEY: undefined } as unknown as typeof envSchema;

test("AC 6: no APOLLO_API_KEY → empty preset list (no import attempted)", () => {
  assert.deepEqual(enrichmentProvidersFromEnv(baseEnv), []);
});

test("AC 7 (preset half): key set but factory unresolved → empty list, no throw", () => {
  // APOLLO_API_KEY was unset at module load, so the factory is null even when
  // the *passed* env carries a key — the same degraded state as "key set but
  // package not installed". The preset must skip, never throw.
  const envWithKey = {
    APOLLO_API_KEY: "apollo-test-key",
  } as unknown as typeof envSchema;
  assert.deepEqual(enrichmentProvidersFromEnv(envWithKey), []);
});

test("AC 7 (guard half): unresolvable specifier → null + logged once, no throw", async () => {
  // Deliberately an INJECTED unresolvable specifier — NOT @hogsend/plugin-apollo,
  // which a later PRD adds to optionalDependencies (an absence-based test would
  // then silently invert its meaning).
  const messages: string[] = [];
  const factory = await loadEnrichmentPluginFactory({
    specifier: "@hogsend/plugin-test-does-not-exist",
    exportName: "createTestProvider",
    onMissing: (message) => messages.push(message),
  });
  assert.equal(factory, null);
  assert.equal(messages.length, 1);
  assert.match(messages[0] ?? "", /@hogsend\/plugin-test-does-not-exist/);
});

test("AC 7 control: resolvable specifier → returns the named export", async () => {
  // Proves the null above comes from the unresolvable specifier, not a broken
  // loader — keeping the guard-half assertion honest.
  const messages: string[] = [];
  const factory = await loadEnrichmentPluginFactory<
    typeof import("node:path")["join"]
  >({
    specifier: "node:path",
    exportName: "join",
    onMissing: (message) => messages.push(message),
  });
  assert.equal(typeof factory, "function");
  assert.equal(messages.length, 0);
});

test("a resolvable specifier MISSING the named export → null + logged, no throw", async () => {
  const messages: string[] = [];
  const factory = await loadEnrichmentPluginFactory({
    specifier: "node:path",
    exportName: "createApolloProvider",
    onMissing: (message) => messages.push(message),
  });
  assert.equal(factory, null);
  assert.equal(messages.length, 1);
});
