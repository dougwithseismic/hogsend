import type { EnrichmentResult } from "@hogsend/core";

/**
 * Identity of the lookup that produced a patch — the two synthetic traits every
 * successful refinement stamps alongside the vendor's own fields.
 */
export interface RefinedTraitsMeta {
  /** The enrichment provider id that answered (`refined_provider`). */
  provider: string;
  /** The lookup instant, written as an ISO string (`refined_at`). */
  refinedAt: Date;
}

/**
 * Map a normalized {@link EnrichmentResult} onto the FLAT, top-level,
 * `refined_`-prefixed contact-property patch that `ingestEvent` merges into
 * `contacts.properties`.
 *
 * Two rules make this function load-bearing rather than cosmetic:
 *
 *  - **Flat keys only.** `evaluatePropertyConditions` reads
 *    `journeyContext[condition.property]`, so a bucket authors
 *    `b.prop("refined_seniority")`. A dotted path would never resolve, which is
 *    why nothing here nests.
 *  - **Absent means ABSENT.** An undefined vendor field is omitted from the
 *    patch entirely — never written as `null`. `mergePropertiesSql` wraps the
 *    patch in `jsonb_strip_nulls`, so a null would DELETE a previously-good key
 *    rather than leave it alone.
 *
 * Numeric traits are written as real JSON numbers: `conditions/property.ts` does
 * no coercion, so a `"42"` would silently never match a `gte`.
 */
export function flattenTraits(
  result: EnrichmentResult,
  meta: RefinedTraitsMeta,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const person = result.person;
  const company = result.company;

  putString(patch, "refined_title", person?.title);
  putString(patch, "refined_seniority", person?.seniority);
  putString(patch, "refined_department", person?.department);
  putString(patch, "refined_linkedin_url", person?.linkedinUrl);
  putString(patch, "refined_country", person?.country);

  putString(patch, "refined_company_name", company?.name);
  putString(patch, "refined_company_domain", company?.domain);
  putString(patch, "refined_company_industry", company?.industry);
  putNumber(patch, "refined_company_employees", company?.employeeCount);
  putNumber(patch, "refined_company_revenue", company?.estimatedRevenue);
  putString(patch, "refined_company_country", company?.country);

  patch.refined_at = meta.refinedAt.toISOString();
  patch.refined_provider = meta.provider;

  return patch;
}

/** The prefix every trait this module writes carries. */
export const REFINED_TRAIT_PREFIX = "refined_";

/**
 * The `refined_*` subset of an already-stored `contacts.properties` bag — what
 * a cache hit compares the ledger row's stored patch against, to tell "this
 * contact already has the paid answer" apart from "another contact at the same
 * domain paid for it and this one has never seen it".
 */
export function pickRefinedTraits(
  properties: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  if (!properties) return picked;
  for (const [key, value] of Object.entries(properties)) {
    if (key.startsWith(REFINED_TRAIT_PREFIX)) picked[key] = value;
  }
  return picked;
}

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
 * `b.prop("refined_company_employees").gte(100)` and one that silently never
 * matches. Non-finite / non-numeric values are omitted entirely.
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
