import {
  defineEnrichmentProvider,
  type EnrichmentProvider,
  type EnrichmentResult,
} from "@hogsend/core";
import { describe, expect, it } from "vitest";

// The engine parses `process.env` once at module load, so anything env-driven
// must be set BEFORE the first `import("@hogsend/engine")`. This file asserts
// the ZERO-CONFIG posture (nothing explicitly requested), so it must ensure
// `ENRICHMENT_PROVIDER` is genuinely unset — otherwise the "sole registered
// provider wins" and "boots inert" criteria would silently test the explicit
// path instead. Files run isolated (fresh module graph), so this is scoped here.
delete process.env.ENRICHMENT_PROVIDER;
delete process.env.APOLLO_API_KEY;

const { createHogsendClient } = await import("@hogsend/engine");

const MISS: EnrichmentResult = { found: false, raw: null };

/**
 * A minimal conforming provider. None of the five criteria under test call the
 * wire — they exercise registry merge, active resolution and boot errors only —
 * so `enrichPerson` returns a fixed result and carries a `marker` we can assert
 * identity on when two providers share a `meta.id`.
 */
function fakeProvider(id: string, marker: string): EnrichmentProvider {
  return defineEnrichmentProvider({
    meta: { id, name: `Fake ${id} (${marker})` },
    capabilities: { personLookup: true, companyLookup: false },
    async enrichPerson() {
      return { ...MISS, raw: marker };
    },
  });
}

describe("enrichment container wiring", () => {
  // AC 2
  it("merges enrichment.provider LAST, beating a same-id entry in enrichment.providers", async () => {
    const fromProviders = fakeProvider("clay", "from-providers");
    const fromProvider = fakeProvider("clay", "from-provider");

    const client = createHogsendClient({
      enrichment: { providers: [fromProviders], provider: fromProvider },
    });

    // Same id ⇒ one registry entry, and it is the `provider` one (consumer-last
    // wins), NOT the `providers` one.
    expect(client.enrichmentProviders.count()).toBe(1);
    const registered = client.enrichmentProviders.get("clay");
    expect(registered).toBe(fromProvider);
    expect(registered).not.toBe(fromProviders);
    // Assert on OBSERVED behaviour too, not just object identity, so the test
    // still fails if a future merge clones providers instead of passing them
    // through.
    expect((await registered?.enrichPerson({ email: "a@b.com" }))?.raw).toBe(
      "from-provider",
    );
    expect(client.enrichmentProvider).toBe(fromProvider);
  });

  // AC 3
  it("throws at client construction when defaultProvider names an unregistered id", () => {
    let thrown: unknown;
    try {
      createHogsendClient({
        enrichment: {
          providers: [fakeProvider("clay", "a"), fakeProvider("clearbit", "b")],
          defaultProvider: "apollo",
        },
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    // The message must name the REQUESTED id...
    expect(message).toMatch(/enrichment provider "apollo" is not registered/i);
    // ...and the ids that ARE registered, so the operator can see the typo.
    expect(message).toContain("clay");
    expect(message).toContain("clearbit");
  });

  // AC 4
  it("constructs inert with no provider registered and none requested", () => {
    let client: ReturnType<typeof createHogsendClient> | undefined;
    expect(() => {
      client = createHogsendClient();
    }).not.toThrow();

    expect(client?.enrichmentProviders.count()).toBe(0);
    expect(client?.enrichmentProvider).toBeUndefined();
  });

  // AC 5
  it("resolves the SOLE registered provider as active even when its id is not the apollo default", () => {
    // Deliberately "clay", not "apollo": if the resolver fell back to the
    // "apollo" default instead of applying the sole-provider rule, `get()`
    // would miss and this would be undefined.
    const clay = fakeProvider("clay", "sole");

    const client = createHogsendClient({ enrichment: { provider: clay } });

    expect(client.enrichmentProviders.count()).toBe(1);
    expect(client.enrichmentProvider).toBe(clay);
    expect(client.enrichmentProvider?.meta.id).toBe("clay");
  });
});
