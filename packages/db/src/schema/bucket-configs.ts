import {
  boolean,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";

export const bucketConfigs = pgTable(
  "bucket_configs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    bucketId: text("bucket_id").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    // Stable hash of the normalized ConditionEval, written at boot. Diffed on the
    // next boot to detect a CRITERIA CHANGE and enqueue the re-evaluation job
    // (Section 6.6 B). Nullable until the first registration.
    criteriaHash: text("criteria_hash"),
    /**
     * When this bucket's previously-invisible membership cohort was CLAIMED —
     * the one-shot first-tick guard for the cron join-key fix.
     *
     * The leave/dwell passes used to join `contacts.external_id`, while
     * memberships key on the canonical `external_id ?? anonymous_id ?? id`. A
     * contact with a NULL `external_id` was therefore enrollable but never
     * evaluated, so its membership-age clocks (`dwellAnchorAt`/`enteredAt`,
     * `maxDwellAt`) ran unwatched — often for months. Once the join is
     * corrected the whole cohort becomes due AT ONCE, and a dwell reaction is
     * a full journey that can send, so the first tick would deliver a backlog
     * of months-old lifecycle mail.
     *
     * On the first tick after the fix, the cohort's age clocks are RESET to
     * that instant instead (nothing is emitted and nothing is silently
     * swallowed — the emissions simply happen later, on an honest schedule).
     * This column records that it happened, so it happens exactly once per
     * bucket. NULL = not yet claimed. Only age-driven emissions are deferred;
     * criteria-driven leaves evaluate against present-day state and are never
     * suppressed.
     */
    coalesceClaimedAt: timestamp("coalesce_claimed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [uniqueIndex("bucket_configs_bucket_id_idx").on(table.bucketId)],
);
