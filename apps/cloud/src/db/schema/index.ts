import { pgSchema } from "drizzle-orm/pg-core";

/**
 * Every cloud control-plane table lives in the `cloud` Postgres schema so it
 * can never collide with the engine's `public` tables, even if someone points
 * both at one database by mistake. The migration ledger
 * (`cloud.__cloud_migrations`) lives here too.
 */
export const cloud = pgSchema("cloud");

// No tables yet — this is the baseline. New tables land in sibling files here
// and are re-exported below.
