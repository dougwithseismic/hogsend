import {
  char,
  date,
  numeric,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Cached quote→base FX rates backing the OPTIONAL base-currency lens
 * (docs/groups.md §Base-currency lens). Written only by rate providers that
 * fetch from a network source (the frankfurter preset); the static
 * operator-supplied preset never touches this table. Serving conversions from
 * this cache is what keeps the lens at ≤1 outbound call per staleness window
 * AND pins a day's conversions to one recorded sheet (reproducible figures,
 * not whatever the API says mid-request).
 *
 * One CURRENT row per (base, quote) — a refetch upserts in place rather than
 * appending an `as_of` history. The lens only ever asks "the freshest usable
 * rate and when it's from" (`as_of` records that provenance); a per-date
 * history would grow by ~30 rows a day and force every read through a
 * latest-per-pair window for a history nothing reads. If a rate AUDIT trail
 * is ever needed it can be layered on separately without changing this
 * serving shape.
 */
export const fxRates = pgTable(
  "fx_rates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** ISO-4217 code conversions target (the operator's BASE_CURRENCY). */
    base: char("base", { length: 3 }).notNull(),
    /** ISO-4217 code being converted FROM. */
    quote: char("quote", { length: 3 }).notNull(),
    /**
     * How many BASE units one QUOTE unit is worth (quote→base). Scale 12
     * comfortably holds the small side of real pairs (e.g. IRR→USD ≈
     * 0.0000238) without float drift in the stored value.
     */
    rate: numeric("rate", {
      precision: 24,
      scale: 12,
      mode: "number",
    }).notNull(),
    /** The source's publication date for this rate (ECB reference date). */
    asOf: date("as_of").notNull(),
    /** When WE fetched it — drives the ≤1-call-per-window staleness check. */
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // The upsert arbiter: one current rate per (base, quote).
    uniqueIndex("fx_rates_base_quote_unique_idx").on(table.base, table.quote),
  ],
);
