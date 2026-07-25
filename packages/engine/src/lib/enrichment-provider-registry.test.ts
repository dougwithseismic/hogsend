import assert from "node:assert/strict";
import test from "node:test";
import type { EnrichmentProvider } from "@hogsend/core";
import { EnrichmentProviderRegistry } from "./enrichment-provider-registry.js";
import {
  getEnrichmentProvider,
  getEnrichmentProviderRegistry,
  resetEnrichmentProviders,
  setEnrichmentProviders,
} from "./enrichment-registry-singleton.js";

function fakeProvider(id: string, name = id): EnrichmentProvider {
  return {
    meta: { id, name },
    capabilities: { personLookup: true, companyLookup: false },
    async enrichPerson() {
      return { found: false, raw: null };
    },
  };
}

test("registry keys providers by meta.id", () => {
  const apollo = fakeProvider("apollo");
  const clay = fakeProvider("clay");
  const registry = new EnrichmentProviderRegistry([apollo, clay]);

  assert.equal(registry.get("apollo"), apollo);
  assert.equal(registry.get("clay"), clay);
  assert.equal(registry.get("clearbit"), undefined);
  assert.equal(registry.count(), 2);
  assert.deepEqual(registry.getAll(), [apollo, clay]);
});

test("duplicate meta.id is last-writer-wins (constructor order + register)", () => {
  const first = fakeProvider("apollo", "first");
  const second = fakeProvider("apollo", "second");
  const registry = new EnrichmentProviderRegistry([first, second]);

  assert.equal(registry.count(), 1);
  assert.equal(registry.get("apollo"), second);

  const third = fakeProvider("apollo", "third");
  registry.register(third);
  assert.equal(registry.count(), 1);
  assert.equal(registry.get("apollo"), third);
});

test("singleton: set → get (registry + active), reset clears", () => {
  const apollo = fakeProvider("apollo");
  const registry = new EnrichmentProviderRegistry([apollo]);

  setEnrichmentProviders(registry, apollo);
  assert.equal(getEnrichmentProviderRegistry(), registry);
  assert.equal(getEnrichmentProvider(), apollo);

  // Active is legitimately undefined (registered-but-inert deploy).
  setEnrichmentProviders(registry, undefined);
  assert.equal(getEnrichmentProviderRegistry(), registry);
  assert.equal(getEnrichmentProvider(), undefined);

  resetEnrichmentProviders();
  assert.equal(getEnrichmentProviderRegistry(), undefined);
  assert.equal(getEnrichmentProvider(), undefined);
});
