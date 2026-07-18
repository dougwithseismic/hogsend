import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";

/**
 * One multivariate arm of a flag: a keyed value served to a slice of the
 * rollout, sized by `weight` (weights are relative; the evaluator picks by
 * cumulative weight over a deterministic unit-hash of contactKey+flagKey).
 */
export interface FlagVariant {
  key: string;
  value: unknown;
  weight: number;
}

/**
 * Structural mirror of @hogsend/core's `PropertyCondition`. The db package
 * cannot import @hogsend/core (core depends on db), so the targeting column's
 * element shape is restated here for the jsonb `$type`. The canonical type +
 * its Zod schema live in @hogsend/core; this stays in sync with it.
 */
interface FlagPropertyCondition {
  type: "property";
  property: string;
  operator:
    | "eq"
    | "neq"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "exists"
    | "not_exists"
    | "contains";
  value?: string | number | boolean;
}

/**
 * Native, DB-backed feature flag — Hogsend's sovereign answer to a flag
 * service. Evaluation is STICKY by construction (a deterministic sha256 hash of
 * contactKey+flagKey), so there is no per-user assignment storage. `origin` is
 * the seam for a deferred provider sync (posthog/launchdarkly) — native today.
 */
export const flags = pgTable(
  "flags",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // The stable string identifier a client evaluates against (e.g.
    // "new-onboarding"). Uniqueness is the partial-unique live-row index below,
    // scoped to non-archived rows so an archived flag can retain its key.
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    // Master switch: a disabled flag always serves `defaultValue`.
    enabled: boolean("enabled").notNull().default(true),
    // "boolean" → serves `true` when eligible; "multivariate" → picks a variant.
    type: text("type").notNull(),
    // Multivariate arms. Empty for boolean flags.
    variants: jsonb("variants").$type<FlagVariant[]>().notNull().default([]),
    // Served when disabled / targeting fails / not in the rollout slice. For a
    // boolean flag this is `false`.
    defaultValue: jsonb("default_value"),
    // Targeting predicate — reuses the shared PropertyCondition vocabulary.
    // Empty means everyone matches.
    targeting: jsonb("targeting")
      .$type<FlagPropertyCondition[]>()
      .notNull()
      .default([]),
    // Percent (0-100) of the targeted audience eligible for a non-default value.
    rollout: integer("rollout").notNull().default(100),
    // Provenance seam for deferred provider sync — "native" today.
    origin: text("origin").notNull().default("native"),
    // Soft-delete: an archived flag stops evaluating and frees its key.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // Exactly one LIVE flag per key. Partial-unique scoped to non-archived rows
    // (`WHERE archived_at IS NULL`) so a soft-deleted row can retain its stale
    // key — identical idiom to the contacts identity indexes.
    uniqueIndex("flags_key_unique_idx")
      .on(table.key)
      .where(sql`archived_at IS NULL`),
  ],
);
