import { type Database, userEvents } from "@hogsend/db";
import { and, count, eq, isNotNull, max, sql } from "drizzle-orm";

/**
 * Revenue rollups over the event spine — pure reads of the first-class
 * `user_events.value`/`currency` columns (served by the partial
 * `user_events_valued_user_idx`). Totals are grouped per currency and NEVER
 * summed across currencies (a GBP deal and a USD deal don't add).
 */

export interface ContactRevenueTotal {
  /** ISO-4217 code, or null for valued events ingested without a currency. */
  currency: string | null;
  total: number;
  /** Number of valued events contributing to this total. */
  count: number;
}

export interface ContactRevenue {
  totals: ContactRevenueTotal[];
  /** `occurredAt` of the most recent valued event, across all currencies. */
  lastValuedAt: string | null;
}

/**
 * Sum a contact's valued events, per currency. `key` is the contact's
 * canonical event key (`external_id ?? anonymous_id ?? id`) — the same key
 * `ingestEvent` stamps on `user_events.user_id`.
 */
export async function getContactRevenue(opts: {
  db: Database;
  key: string;
}): Promise<ContactRevenue> {
  const rows = await opts.db
    .select({
      currency: userEvents.currency,
      total: sql<number>`sum(${userEvents.value})::float8`,
      count: count(),
      lastAt: max(userEvents.occurredAt),
    })
    .from(userEvents)
    .where(and(eq(userEvents.userId, opts.key), isNotNull(userEvents.value)))
    .groupBy(userEvents.currency);

  let lastValuedAt: Date | null = null;
  for (const row of rows) {
    if (row.lastAt && (!lastValuedAt || row.lastAt > lastValuedAt)) {
      lastValuedAt = row.lastAt;
    }
  }

  return {
    totals: rows
      .map((row) => ({
        currency: row.currency,
        total: row.total ?? 0,
        count: Number(row.count),
      }))
      .sort((a, b) => b.total - a.total),
    lastValuedAt: lastValuedAt ? lastValuedAt.toISOString() : null,
  };
}
