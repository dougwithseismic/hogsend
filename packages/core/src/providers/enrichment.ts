// ---------------------------------------------------------------------------
// Lookup query (vendor-neutral wire — the engine owns everything else)
// ---------------------------------------------------------------------------

/**
 * What the engine hands a provider to identify the person/company to look up.
 * The common denominator across Apollo/Clay/Clearbit — nothing vendor-specific
 * ever lands here (the same discipline {@link EmailProvider} held against
 * Resend). The engine builds this from the contact row; a provider uses
 * whatever subset its vendor matches on.
 */
export interface EnrichmentQuery {
  /** The contact's email — the highest-signal match key for person lookup. */
  email?: string;
  /** Company domain (e.g. "acme.com") — the match key for company lookup. */
  domain?: string;
  firstName?: string;
  lastName?: string;
  /** Company NAME (free text), when no domain is known. */
  company?: string;
}

// ---------------------------------------------------------------------------
// Normalized results (the ONE shape the engine's refinement pipeline reads)
// ---------------------------------------------------------------------------

/**
 * Vendor-neutral person intelligence. Every field optional — a provider fills
 * what its vendor returned and omits the rest. Field names are the flat,
 * top-level trait vocabulary the engine prefixes into `refined_*` contact
 * properties (dotted paths never resolve in bucket conditions).
 */
export interface EnrichedPerson {
  firstName?: string;
  lastName?: string;
  /** Job title, verbatim from the vendor (e.g. "VP of Engineering"). */
  title?: string;
  /** Normalized seniority band (e.g. "vp", "director", "c_suite"). */
  seniority?: string;
  /** Department / function (e.g. "engineering", "marketing"). */
  department?: string;
  linkedinUrl?: string;
  city?: string;
  country?: string;
}

/**
 * Vendor-neutral company intelligence — the account-side sibling of
 * {@link EnrichedPerson}. Numeric fields MUST be real JSON numbers (never
 * numeric strings): the property-condition evaluator does no coercion, so a
 * `"42"` silently never matches a `gte`.
 */
export interface EnrichedCompany {
  name?: string;
  domain?: string;
  industry?: string;
  /** Headcount as a real number — drives `b.prop(...).gte(n)` fit conditions. */
  employeeCount?: number;
  /** Estimated annual revenue in whole USD, as a real number. */
  estimatedRevenue?: number;
  city?: string;
  country?: string;
  linkedinUrl?: string;
}

/**
 * The normalized result every lookup resolves to. `found: false` is a
 * LEGITIMATE, billable answer (the engine's ledger negative-caches it — a miss
 * costs money too and must not be retried every day). The untouched vendor
 * payload is preserved in `raw` for handler escape-hatch + debugging; the
 * engine never persists trait data out of `raw`, only out of the normalized
 * `person`/`company`.
 */
export interface EnrichmentResult {
  /** Whether the vendor matched the query at all. */
  found: boolean;
  person?: EnrichedPerson;
  company?: EnrichedCompany;
  /** The untouched vendor response. */
  raw: unknown;
}

// ---------------------------------------------------------------------------
// Provider identity & capabilities
// ---------------------------------------------------------------------------

/**
 * Provider identity. `id` is the key the engine's `EnrichmentProviderRegistry`
 * indexes by and the id `ENRICHMENT_PROVIDER` / `enrichment.defaultProvider`
 * selects. REQUIRED (mirrors {@link SmsProviderMeta}) — enrichment has no
 * pre-registry back-compat to protect.
 */
export interface EnrichmentProviderMeta {
  id: string;
  name: string;
  description?: string;
}

/**
 * What the provider's vendor can look up. Both person/company flags are
 * REQUIRED so the engine can route a lookup (or refuse one) without probing
 * for optional methods.
 */
export interface EnrichmentProviderCapabilities {
  /** Can resolve a person from an {@link EnrichmentQuery}. */
  personLookup: boolean;
  /** Can resolve a company from a bare domain. */
  companyLookup: boolean;
  /** Reserved — supports a bulk endpoint. No engine bulk path in v1. */
  bulk?: boolean;
}

// ---------------------------------------------------------------------------
// EnrichmentProvider contract (the entire provider surface)
// ---------------------------------------------------------------------------

/**
 * The dumb lookup contract every enrichment provider implements (Apollo,
 * Clay, Clearbit, …). A provider does ONE thing: query the vendor and
 * normalize the response. All DB, caching, TTL, budget-cap, preference and
 * ingest logic lives in the engine's `refineContact()` pipeline, never here —
 * every lookup costs money and the engine is where that is accounted.
 */
export interface EnrichmentProvider {
  /**
   * Provider identity. `meta.id` keys the registry and is what
   * `ENRICHMENT_PROVIDER` / `enrichment.defaultProvider` select. REQUIRED.
   */
  readonly meta: EnrichmentProviderMeta;
  /** What the vendor can look up. REQUIRED (both flags explicit). */
  readonly capabilities: EnrichmentProviderCapabilities;

  /** Look up a person (and usually their company) from a query. */
  enrichPerson(query: EnrichmentQuery): Promise<EnrichmentResult>;

  /**
   * Look up a company from a bare domain. Optional — a person-only vendor
   * omits it (and declares `companyLookup: false`).
   */
  enrichCompany?(domain: string): Promise<EnrichmentResult>;
}

/**
 * Identity factory for an {@link EnrichmentProvider}. Mirrors
 * `defineSmsProvider` — returns its argument unchanged but pins the literal
 * shape to the contract, so a typo in `meta` or a missing method is caught at
 * definition time.
 */
export function defineEnrichmentProvider(
  provider: EnrichmentProvider,
): EnrichmentProvider {
  return provider;
}
