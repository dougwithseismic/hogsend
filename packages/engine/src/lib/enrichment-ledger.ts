import { type Database, enrichmentLookups } from "@hogsend/db";
import { and, count, eq, gte, lt } from "drizzle-orm";

/** The lookup subject's kind — mirrors the `enrichment_lookup_kind` pgEnum. */
export type EnrichmentLookupKind = "email" | "domain";

/**
 * The lookup's outcome — mirrors the `enrichment_lookup_status` pgEnum.
 * `found`/`not_found` are both PAID answers and suppress re-spend until the row
 * expires; `error` is not a paid answer and must never suppress a retry.
 */
export type EnrichmentLookupStatus = "found" | "not_found" | "error";

/** A ledger row as the refinement gate chain reads it. */
export interface EnrichmentLookupRow {
  id: string;
  provider: string;
  lookupKind: EnrichmentLookupKind;
  lookupKey: string;
  status: EnrichmentLookupStatus;
  contactId: string | null;
  refinedAt: Date;
  expiresAt: Date;
  raw: Record<string, unknown> | null;
}

/**
 * The ledger row for a `(provider, lookupKind, lookupKey)` triple, or null when
 * this subject has never been looked up by this provider.
 *
 * Deliberately returns the row REGARDLESS of status and expiry: the gate chain
 * owns the "unexpired AND paid" verdict so the `error`-never-short-circuits rule
 * lives next to the rest of the gate ordering rather than being buried in a
 * WHERE clause.
 */
export async function findEnrichmentLookup(opts: {
  db: Database;
  provider: string;
  lookupKind: EnrichmentLookupKind;
  lookupKey: string;
}): Promise<EnrichmentLookupRow | null> {
  const rows = await opts.db
    .select()
    .from(enrichmentLookups)
    .where(
      and(
        eq(enrichmentLookups.provider, opts.provider),
        eq(enrichmentLookups.lookupKind, opts.lookupKind),
        eq(enrichmentLookups.lookupKey, opts.lookupKey),
      ),
    )
    .limit(1);
  return (rows[0] as EnrichmentLookupRow | undefined) ?? null;
}

/**
 * Record a lookup against the `(provider, lookup_kind, lookup_key)` unique index
 * — the Layer-2, version-independent exactly-once backstop for refinement.
 *
 * Conflict behaviour is status-dependent, and deliberately asymmetric:
 *
 *  - a PAID answer (`found` / `not_found`) UPDATES the existing row, so a
 *    `force: true` re-lookup refreshes the TTL in place instead of inserting a
 *    duplicate (the unique index would reject one anyway);
 *  - an `error` does NOTHING on conflict, so a transient vendor 5xx during a
 *    forced re-lookup can never clobber a live, good cached row. An error row is
 *    only ever WRITTEN when the subject has no row at all — which is the only
 *    case where its existence is informative.
 */
export async function upsertEnrichmentLookup(opts: {
  db: Database;
  provider: string;
  lookupKind: EnrichmentLookupKind;
  lookupKey: string;
  status: EnrichmentLookupStatus;
  contactId?: string | null;
  refinedAt: Date;
  expiresAt: Date;
  raw?: unknown;
}): Promise<void> {
  const values = {
    provider: opts.provider,
    lookupKind: opts.lookupKind,
    lookupKey: opts.lookupKey,
    status: opts.status,
    contactId: opts.contactId ?? null,
    refinedAt: opts.refinedAt,
    expiresAt: opts.expiresAt,
    raw: toJsonbRecord(opts.raw),
  };

  const insert = opts.db.insert(enrichmentLookups).values(values);

  if (opts.status === "error") {
    await insert.onConflictDoNothing({
      target: [
        enrichmentLookups.provider,
        enrichmentLookups.lookupKind,
        enrichmentLookups.lookupKey,
      ],
    });
    return;
  }

  await insert.onConflictDoUpdate({
    target: [
      enrichmentLookups.provider,
      enrichmentLookups.lookupKind,
      enrichmentLookups.lookupKey,
    ],
    set: {
      status: values.status,
      refinedAt: values.refinedAt,
      expiresAt: values.expiresAt,
      raw: values.raw,
      updatedAt: new Date(),
      // Only ever ATTACH a contact, never detach one: a later lookup that
      // resolved no contact must not erase the contact the first one attributed
      // the spend to.
      ...(values.contactId ? { contactId: values.contactId } : {}),
    },
  });
}

/**
 * How many lookups the ledger recorded in `[since, until)` — the budget-period
 * COUNT behind `ENRICHMENT_MONTHLY_LOOKUPS`.
 *
 * Counts EVERY row in the window, across all providers and all statuses. That is
 * the fail-closed reading of a spend cap: an `error` row still represents a
 * request that left the building, and the operator's cap is a ceiling on
 * requests, not on successful matches. Served by
 * `enrichment_lookups_refined_at_idx`.
 */
export async function countEnrichmentLookups(opts: {
  db: Database;
  since: Date;
  until?: Date;
}): Promise<number> {
  const window = opts.until
    ? and(
        gte(enrichmentLookups.refinedAt, opts.since),
        lt(enrichmentLookups.refinedAt, opts.until),
      )
    : gte(enrichmentLookups.refinedAt, opts.since);

  const rows = await opts.db
    .select({ total: count() })
    .from(enrichmentLookups)
    .where(window);
  return rows[0]?.total ?? 0;
}

/**
 * The first instant of `at`'s calendar month in UTC — the lower bound of the
 * monthly budget window. UTC (not local) so the cap resets at the same instant
 * for every process regardless of the host's timezone.
 */
export function startOfUtcMonth(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

/**
 * Narrow a provider's verbatim payload to something the `raw` jsonb column
 * accepts. A plain object is stored as-is; anything else (array, scalar) is
 * wrapped so it stays inspectable without widening the column's type.
 */
function toJsonbRecord(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return { value: raw as never };
}
