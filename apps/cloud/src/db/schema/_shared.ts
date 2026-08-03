import { pgSchema, timestamp } from "drizzle-orm/pg-core";

/**
 * Every cloud control-plane table lives in the `cloud` Postgres schema so it
 * can never collide with the engine's `public` tables, even if someone points
 * both at one database by mistake. The migration ledger
 * (`cloud.__cloud_migrations`) lives here too.
 *
 * Declared here rather than in `index.ts` so the per-domain table files can
 * import it without a cycle through the barrel.
 */
export const cloud = pgSchema("cloud");

/** Mutable-row timestamps. Append-only tables take `createdAt` alone. */
export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
};
