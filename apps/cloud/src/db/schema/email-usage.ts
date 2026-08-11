import {
  bigint,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { cloud, timestamps } from "./_shared";
import { organizations } from "./organizations";

/**
 * The two ledgers PRD 09 needs, both of them answering "have we already done
 * this to this tenant in this period?"
 *
 * They are ORGANIZATION-scoped rather than environment-scoped, and that is a
 * decision rather than an oversight: the plan allowance is bought once per
 * organization and `usage_counters` is per environment, so overage is an
 * organization-level number. A per-environment ledger would hand every
 * environment its own allowance to exceed, which would under-bill every tenant
 * running a staging stack — and the billing customer is the organization
 * anyway, so there is nothing per-environment to invoice.
 */

/**
 * How much overage has been reported to the billing provider for one
 * (organization, period), and how much is currently in flight.
 *
 * TWO columns because a report is a two-phase write against a system we do not
 * share a transaction with:
 *
 *  1. CLAIM — `pending_quantity` is set to the cumulative overage this run
 *     intends to have reported, and it STICKS until the report is confirmed. A
 *     sticky claim is what pins the idempotency key: a retry after an unknown
 *     outcome must present the SAME key, and the key is derived from this
 *     number;
 *  2. COMMIT — `reported_quantity` moves up to it and the claim clears.
 *
 * A crash between the two leaves a claim behind, so the next run re-reports the
 * same delta under the same key and the provider deduplicates it. The
 * alternative order (commit first) would silently drop revenue on a failed
 * call, and a single-column ledger would let usage growth between the attempt
 * and the retry change the key, which is exactly how a lost response becomes a
 * double charge.
 */
export const emailOverageReports = cloud.table(
  "email_overage_reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Billing period as `YYYY-MM` (UTC), matching `usage_counters.month`. */
    period: text("period").notNull(),
    /** Cumulative overage the provider has CONFIRMED for this period. */
    reportedQuantity: bigint("reported_quantity", { mode: "number" })
      .default(0)
      .notNull(),
    /** The cumulative total an unconfirmed report claimed; null when settled. */
    pendingQuantity: bigint("pending_quantity", { mode: "number" }),
    lastReportedAt: timestamp("last_reported_at", { withTimezone: true }),
    ...timestamps,
  },
  // The upsert arbiter AND the read path — and the reason two concurrent
  // reporting runs cannot both claim the same period.
  (table) => [
    uniqueIndex("email_overage_reports_org_period_unique_idx").on(
      table.organizationId,
      table.period,
    ),
  ],
);

/**
 * One row per warning threshold already sent, per organization, per period.
 *
 * The INSERT is the lock: `onConflictDoNothing().returning()` gives back a row
 * only to the caller that won, so "notify exactly once per month per threshold"
 * survives two sweeps running at once. Recording it in the database rather than
 * in memory is what makes it survive a redeploy too.
 */
export const emailAllowanceWarnings = cloud.table(
  "email_allowance_warnings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    period: text("period").notNull(),
    /** Whole percent of the included allowance. An integer, so the unique index
     * can never be defeated by a float that does not round-trip. */
    percent: integer("percent").notNull(),
    /** What the numbers were when it fired — the record of why we said it. */
    used: bigint("used", { mode: "number" }).notNull(),
    allowance: bigint("allowance", { mode: "number" }).notNull(),
    /** How many owner addresses the notice actually reached. */
    recipients: integer("recipients").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("email_allowance_warnings_org_period_percent_unique_idx").on(
      table.organizationId,
      table.period,
      table.percent,
    ),
  ],
);
