import type { EnrichmentProvider } from "@hogsend/core";

/**
 * Container-held registry of enrichment providers, keyed by `provider.meta.id`.
 * The container picks ONE active provider out of it (resolved as
 * `enrichment.defaultProvider ?? ENRICHMENT_PROVIDER ?? "apollo"`) for the
 * `refineContact()` pipeline.
 *
 * The enrichment sibling of {@link SmsProviderRegistry}. `meta` is REQUIRED on
 * the enrichment contract (no pre-registry back-compat), so there is no
 * fallback id — last-writer-wins on `meta.id`.
 */
export class EnrichmentProviderRegistry {
  private byId = new Map<string, EnrichmentProvider>();

  constructor(providers: EnrichmentProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: EnrichmentProvider): void {
    this.byId.set(provider.meta.id, provider);
  }

  get(id: string): EnrichmentProvider | undefined {
    return this.byId.get(id);
  }

  getAll(): EnrichmentProvider[] {
    return [...this.byId.values()];
  }

  count(): number {
    return this.byId.size;
  }
}
