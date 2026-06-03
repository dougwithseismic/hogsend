import { boolean, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
    ...timestamps,
  },
  (table) => [uniqueIndex("bucket_configs_bucket_id_idx").on(table.bucketId)],
);
