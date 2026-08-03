import type { EnrichmentResult } from "@hogsend/core";

/**
 * Identity of the lookup that produced a patch — the provenance every
 * successful refinement stamps alongside the vendor's own facts.
 */
export interface RefinedTraitsMeta {
  /** The enrichment provider id that answered (`enrichment.provider`). */
  provider: string;
  /** The lookup instant, written as an ISO string (`enrichment.at`). */
  refinedAt: Date;
}

/**
 * The single nested key that carries refinement PROVENANCE — who answered and
 * when. Split out from the vendor FACTS on purpose:
 *
 *  - Facts land on the CANONICAL, flat property keys a contact already carries
 *    (`title`, `company`, `company_employees`, …) so a bucket segments on the
 *    field it already knows — `b.prop("company_employees").gte(100)` — instead
 *    of a parallel `refined_*` vocabulary sitting next to the real one.
 *  - Provenance is NEVER read by `evaluatePropertyConditions` (segmentation is
 *    about facts, not who told us), so it nests freely under one key with no
 *    dotted-path support required from the condition engine. That is the whole
 *    reason the facts must stay flat and the provenance is free to be an object.
 */
export const ENRICHMENT_KEY = "enrichment";

/** The provenance object stored under {@link ENRICHMENT_KEY}. */
export interface EnrichmentProvenance {
  /** The enrichment provider id that answered. */
  provider: string;
  /** ISO — the instant the vendor answer was obtained. */
  at: string;
}

/**
 * Map a normalized {@link EnrichmentResult} onto a CANONICAL contact-property
 * patch that `ingestEvent` merges into `contacts.properties`. The vendor facts
 * fill the fields a contact already segments and personalizes on; a single
 * nested `enrichment` object records the provenance.
 *
 * Three rules make this function load-bearing rather than cosmetic:
 *
 *  - **Facts are flat + canonical.** `evaluatePropertyConditions` reads
 *    `properties[condition.property]` — a flat lookup with no dotted-path
 *    traversal — so every fact key is a top-level string a bucket can author
 *    verbatim (`company_industry`, not `company.industry`).
 *  - **Provenance is one nested object.** The condition engine never reads it,
 *    so `enrichment: { provider, at }` replaces the old flat `refined_at` /
 *    `refined_provider` sibling keys without touching the evaluator.
 *  - **Absent means ABSENT.** An undefined vendor field is omitted from the
 *    patch entirely — never written as `null`. `mergePropertiesSql` wraps the
 *    patch in `jsonb_strip_nulls`, so a null would DELETE a previously-good key
 *    rather than leave it alone.
 *
 * Numeric traits are written as real JSON numbers: `conditions/property.ts` does
 * no coercion, so a `"42"` would silently never match a `gte`.
 *
 * The patch is the vendor's FULL answer, keyed canonically. Whether an
 * individual fact actually overwrites what a contact already holds is decided at
 * LANDING time (fill-if-absent, in `refine-chain.ts`), because that answer
 * depends on the specific contact — the same stored patch lands on every contact
 * that shares a company domain, and each may already carry different first-party
 * fields.
 */
export function flattenTraits(
  result: EnrichmentResult,
  meta: RefinedTraitsMeta,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const person = result.person;
  const company = result.company;

  putString(patch, "title", person?.title);
  putString(patch, "seniority", person?.seniority);
  putString(patch, "department", person?.department);
  putString(patch, "linkedin_url", person?.linkedinUrl);
  putString(patch, "country", person?.country);

  putString(patch, "company", company?.name);
  putString(patch, "company_domain", company?.domain);
  putString(patch, "company_industry", company?.industry);
  putNumber(patch, "company_employees", company?.employeeCount);
  putNumber(patch, "company_revenue", company?.estimatedRevenue);
  putString(patch, "company_country", company?.country);

  const provenance: EnrichmentProvenance = {
    provider: meta.provider,
    at: meta.refinedAt.toISOString(),
  };
  patch[ENRICHMENT_KEY] = provenance;

  return patch;
}

/**
 * Translate a ledger `traits` patch written by the PRE-canonical release (flat
 * `refined_*` fact keys plus flat `refined_at` / `refined_provider` provenance)
 * into the canonical shape {@link flattenTraits} now produces. A cache HIT can
 * land a row written by an older engine, and landing it verbatim would
 * re-introduce exactly the flat vocabulary this design removed.
 *
 * A patch with no `refined_*` key is already canonical and passes through
 * untouched (the common case, once the ledger has turned over). The two legacy
 * provenance keys are dropped: they are not facts, and the fresh ISO provenance
 * is not recoverable from them here, so a legacy cache hit simply lands the
 * facts without a new `enrichment` stamp.
 */
export function canonicalizeStoredTraits(
  traits: Record<string, unknown>,
): Record<string, unknown> {
  let sawLegacy = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(traits)) {
    if (key === "refined_at" || key === "refined_provider") {
      sawLegacy = true;
      continue;
    }
    const canonical = LEGACY_TRAIT_KEYS[key];
    if (canonical) {
      sawLegacy = true;
      out[canonical] = value;
    } else {
      out[key] = value;
    }
  }
  return sawLegacy ? out : traits;
}

/** Pre-canonical `refined_*` fact key → its canonical replacement. */
const LEGACY_TRAIT_KEYS: Record<string, string> = {
  refined_title: "title",
  refined_seniority: "seniority",
  refined_department: "department",
  refined_linkedin_url: "linkedin_url",
  refined_country: "country",
  refined_company_name: "company",
  refined_company_domain: "company_domain",
  refined_company_industry: "company_industry",
  refined_company_employees: "company_employees",
  refined_company_revenue: "company_revenue",
  refined_company_country: "company_country",
};

/**
 * Write a string trait, omitting anything that carries no information. An empty
 * (or whitespace-only) string is dropped for the same reason a null is: it is
 * not a fact, and writing it would overwrite a previously-good value.
 */
function putString(
  patch: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed === "") return;
  patch[key] = trimmed;
}

/**
 * Write a numeric trait as a real JSON number. A provider is contractually
 * obliged to normalize to `number`, but a JS (untyped) provider can still hand
 * back a numeric string — coercing here is the difference between a working
 * `b.prop("company_employees").gte(100)` and one that silently never matches.
 * Non-finite / non-numeric values are omitted entirely.
 */
function putNumber(
  patch: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (typeof value === "number") {
    if (Number.isFinite(value)) patch[key] = value;
    return;
  }
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed === "") return;
  const parsed = Number(trimmed);
  if (Number.isFinite(parsed)) patch[key] = parsed;
}
