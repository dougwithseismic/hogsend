import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { journeySpecOriginEnum } from "./enums.js";

/**
 * A journey authored as DATA and stored in the DB (Slice 1 of the runtime-JSON
 * plan). Loaded at engine boot next to the code journeys and adapted through
 * `journeyFromSpec` exactly like a code-array spec.
 *
 * Design notes (Conductor / Novu prior art):
 *  - One row per `journeyId` (unique). An edit REPLACES the `spec` in place and
 *    bumps `version` — the row revision. Version pinning of in-flight
 *    enrollments (a history table) is a later slice; today the loader always
 *    reads the latest enabled revision.
 *  - `specSchemaVersion` mirrors `JourneySpec.specVersion` (the step-vocabulary
 *    version) as a column so a loader can filter unsupported rows WITHOUT
 *    parsing the jsonb.
 *  - `spec` is the full validated `JourneySpec` object. Typed loosely here
 *    (`Record<string, unknown>`) so `@hogsend/db` keeps no dependency on
 *    `@hogsend/core`; the engine loader re-parses it via `journeySpecSchema`,
 *    the single source of truth for shape.
 *  - The admin write path validates before insert, so stored rows are
 *    valid-at-write; the loader still tolerates a per-row parse failure (schema
 *    drift across engine versions) by skipping + logging, never crashing boot.
 */
export const journeySpecs = pgTable(
  "journey_specs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    journeyId: text("journey_id").notNull(),
    /** `JourneySpec.specVersion` — the step-vocabulary version (currently 1). */
    specSchemaVersion: integer("spec_schema_version").notNull().default(1),
    /** Row revision — bumped on every edit; the pin target for a later slice. */
    version: integer("version").notNull().default(1),
    origin: journeySpecOriginEnum("origin").notNull().default("json"),
    enabled: boolean("enabled").notNull().default(true),
    spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("journey_specs_journey_id_idx").on(table.journeyId)],
);
