import { type Database, userEvents } from "@hogsend/db";
import {
  and,
  count,
  eq,
  isNotNull,
  isNull,
  max,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

/**
 * Revenue rollups over the event spine — pure reads of the first-class
 * `user_events.value`/`currency` columns (served by the partial
 * `user_events_valued_user_idx`). Totals are grouped per currency and NEVER
 * summed across currencies (a GBP deal and a USD deal don't add).
 */

/**
 * Events whose `value` must NOT count toward revenue: one CRM deal's value
 * rides `funnel.stage_changed` on EVERY stage change plus the once-per-stage
 * money events, so summing them all counts one sale several times over —
 * and a quote is unrealized money, not revenue. Only `deal.sold` (and
 * any other valued event) contributes. Keep the admin contacts `minRevenue`
 * subquery (routes/admin/contacts.ts) in sync with this list.
 */
export const REVENUE_EXCLUDED_EVENTS = [
  "funnel.stage_changed",
  "deal.quoted",
] as const;

/**
 * Rollup trust gate: browser (`pk_`/`inapp`) events can carry any value
 * anyone mints, so they never count toward revenue — the same trust tier
 * the conversion-point forged-value guard enforces. `source` null =
 * engine-written, trusted.
 */
export function trustedValuedEventFilter() {
  return and(
    isNotNull(userEvents.value),
    notInArray(userEvents.event, [...REVENUE_EXCLUDED_EVENTS]),
    or(isNull(userEvents.source), ne(userEvents.source, "inapp")),
  );
}

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
    .where(and(eq(userEvents.userId, opts.key), trustedValuedEventFilter()))
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
