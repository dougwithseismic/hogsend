import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Immutable archive of every version of a DB journey spec (Slice 3). The live
 * `journey_specs` row is a POINTER to the latest; this table keeps the full
 * history so a version can be listed, diffed, and rolled back to (Conductor's
 * "running executions stay on their version; roll a new one forward" model).
 *
 * Only `createdAt` (no `updatedAt`): a version row is written once and never
 * mutated — an "edit" is a NEW row at the next version number.
 */
export const journeySpecVersions = pgTable(
  "journey_spec_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    journeyId: text("journey_id").notNull(),
    /** Row revision this snapshot corresponds to (`journey_specs.version`). */
    version: integer("version").notNull(),
    spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("journey_spec_versions_journey_version_idx").on(
      table.journeyId,
      table.version,
    ),
  ],
);
