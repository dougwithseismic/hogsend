import { bigint, index, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { cloud, timestamps } from "./_shared";
import { environments } from "./environments";
import { organizations } from "./organizations";

/**
 * Per-environment, per-month meter. Written by upsert-increment
 * (`onConflictDoUpdate` against the (environment_id, month) unique index) so
 * concurrent metering writes never lose a count and never need a read-first
 * round trip. The metering SOURCE lands in PRD 06 — this is only the sink.
 */
export const usageCounters = cloud.table(
  "usage_counters",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    /** Billing period as `YYYY-MM` (UTC). */
    month: text("month").notNull(),
    // `mode: "number"` — counts stay well inside Number.MAX_SAFE_INTEGER, and a
    // bigint-as-string would force every caller to parse before arithmetic.
    eventsCount: bigint("events_count", { mode: "number" })
      .default(0)
      .notNull(),
    emailsCount: bigint("emails_count", { mode: "number" })
      .default(0)
      .notNull(),
    /**
     * Hogsend Email sends the RELAY accepted, incremented one message at a time
     * as each send succeeds (PRD 09). Its own column, and that is load-bearing
     * twice over:
     *
     *  - `emails_count` is written ABSOLUTELY by the nightly sweep, from the
     *    tenant's own `email_sends`. An increment into the same column would be
     *    overwritten every night at 03:00, and a meter a sweep can clobber is
     *    not a meter;
     *  - the two count different things. `emails_count` is every email the
     *    tenant sent through ANY provider — a tenant on their own Resend key
     *    fills it without touching our SES account. Billing Hogsend Email
     *    overage off that number would charge them for mail we never sent.
     *
     * Monotonic within a month: it only ever increases, which is what makes the
     * overage ledger's delta reporting safe (`metering/overage.ts`).
     */
    relayEmailsCount: bigint("relay_emails_count", { mode: "number" })
      .default(0)
      .notNull(),
    ...timestamps,
  },
  (table) => [
    // The upsert arbiter AND the read path.
    uniqueIndex("usage_counters_environment_month_unique_idx").on(
      table.environmentId,
      table.month,
    ),
    // Org-wide rollup for a billing period.
    index("usage_counters_org_month_idx").on(table.organizationId, table.month),
  ],
);
