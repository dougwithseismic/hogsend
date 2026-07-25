import { type Database, enrichmentLookups } from "@hogsend/db";
import { and, eq, sql, sum } from "drizzle-orm";

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
  /** The normalized canonical trait patch the paid answer produced. */
  traits: Record<string, unknown> | null;
  spendWindow: Date | null;
  spendCount: number;
  lastErrorAt: Date | null;
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
 * — the Layer-2, version-independent exactly-once backstop for refinement — AND
 * the spend it cost.
 *
 * Conflict behaviour is status-dependent, and deliberately asymmetric:
 *
 *  - a PAID answer (`found` / `not_found`) UPDATES the existing row, so a
 *    `force: true` re-lookup refreshes the TTL + the stored traits in place
 *    instead of inserting a duplicate (the unique index would reject one
 *    anyway);
 *  - an `error` never touches the CACHE columns (`status`/`expiresAt`/`raw`/
 *    `traits`/`refinedAt`), so a transient vendor 5xx during a forced re-lookup
 *    can never clobber a live, good cached row.
 *
 * What BOTH branches always do is bump the spend counter and stamp
 * `spend_window`. That is the whole point: the row is one-per-key, so counting
 * rows counts SUBJECTS, not vendor calls — a `force` loop, or an outage
 * retrying an already-refined base, would otherwise spend real money without
 * ever moving the budget cap. `spend_count` resets to 1 whenever the call lands
 * in a window later than the one on the row, so a previous month's attempts can
 * never be pulled into this month's ceiling.
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
  traits?: Record<string, unknown> | null;
  /** First instant of the budget window this call is charged to. */
  spendWindow: Date;
}): Promise<void> {
  const isError = opts.status === "error";
  const values = {
    provider: opts.provider,
    lookupKind: opts.lookupKind,
    lookupKey: opts.lookupKey,
    status: opts.status,
    contactId: opts.contactId ?? null,
    refinedAt: opts.refinedAt,
    expiresAt: opts.expiresAt,
    raw: toJsonbRecord(opts.raw),
    traits: opts.traits ?? null,
    spendWindow: opts.spendWindow,
    spendCount: 1,
    lastErrorAt: isError ? opts.refinedAt : null,
  };

  // A call that lands in the SAME window as the one already on the row extends
  // that window's tally; a call in a LATER window starts a fresh tally. Written
  // as SQL so the whole thing is one atomic statement — a read-modify-write
  // here would lose concurrent lookups, which is exactly the spend the cap
  // exists to bound.
  const bumpedSpend = sql`case
    when ${enrichmentLookups.spendWindow} = excluded.spend_window
    then ${enrichmentLookups.spendCount} + 1
    else 1
  end`;

  const spend = {
    spendWindow: opts.spendWindow,
    spendCount: bumpedSpend,
    updatedAt: new Date(),
  };

  const insert = opts.db.insert(enrichmentLookups).values(values);
  const target = [
    enrichmentLookups.provider,
    enrichmentLookups.lookupKind,
    enrichmentLookups.lookupKey,
  ];

  if (isError) {
    // Spend + forensics ONLY. Every cache column is left exactly as it was.
    await insert.onConflictDoUpdate({
      target,
      set: { ...spend, lastErrorAt: opts.refinedAt },
    });
    return;
  }

  await insert.onConflictDoUpdate({
    target,
    set: {
      ...spend,
      status: values.status,
      refinedAt: values.refinedAt,
      expiresAt: values.expiresAt,
      raw: values.raw,
      traits: values.traits,
      // Only ever ATTACH a contact, never detach one: a later lookup that
      // resolved no contact must not erase the contact the first one attributed
      // the spend to.
      ...(values.contactId ? { contactId: values.contactId } : {}),
    },
  });
}

/**
 * How many provider LOOKUPS the ledger recorded in the budget window starting
 * at `since` — the number behind `ENRICHMENT_MONTHLY_LOOKUPS`.
 *
 * A SUM of `spend_count` over the rows stamped with this window, not a COUNT of
 * rows: the table holds one row per subject, so a row count would answer "how
 * many distinct subjects were touched", which equals spend only when nothing is
 * ever re-looked-up. Errors are included — an `error` row still represents a
 * request that left the building, and the operator's cap is a ceiling on
 * requests, not on successful matches. Served by
 * `enrichment_lookups_spend_window_idx`.
 */
export async function countEnrichmentLookups(opts: {
  db: Database;
  since: Date;
}): Promise<number> {
  const rows = await opts.db
    .select({ total: sum(enrichmentLookups.spendCount) })
    .from(enrichmentLookups)
    .where(eq(enrichmentLookups.spendWindow, opts.since));
  return Number(rows[0]?.total ?? 0);
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
