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
 * The richer flag-targeting leaves (bucket/journey/deal/event/email_engagement).
 * Structural mirrors of @hogsend/core (db can't import core) — the non-`type`
 * fields are typed `unknown` so the canonical core leaves (which carry concrete
 * field types) remain assignable when the engine writes them. @hogsend/core owns
 * the canonical types + Zod validation; the db layer only stores the jsonb.
 */
interface FlagBucketCondition {
  type: "bucket";
  bucketId?: unknown;
  negate?: unknown;
}
interface FlagJourneyCondition {
  type: "journey";
  journeyId?: unknown;
  state?: unknown;
  negate?: unknown;
}
interface FlagDealCondition {
  type: "deal";
  predicate?: unknown;
  stage?: unknown;
  negate?: unknown;
}
interface FlagEventCondition {
  type: "event";
  eventName?: unknown;
  check?: unknown;
  operator?: unknown;
  value?: unknown;
  within?: unknown;
}
interface FlagEmailEngagementCondition {
  type: "email_engagement";
  templateKey?: unknown;
  check?: unknown;
}

/**
 * A composite (AND/OR) node of the targeting tree. Structural mirror of
 * @hogsend/core's `FlagTargetingComposite` (db can't import core). Children are
 * themselves targeting nodes, so groups nest arbitrarily.
 */
interface FlagTargetingComposite {
  type: "composite";
  operator: "and" | "or";
  conditions: FlagTargetingNode[];
}

/**
 * One node of a flag's targeting tree: a property/bucket/journey/deal/event/
 * email_engagement leaf or an AND/OR composite. The stored `targeting` column
 * also accepts the legacy bare `FlagPropertyCondition[]` (implicit AND) — see
 * the column `$type` below.
 */
type FlagTargetingNode =
  | FlagPropertyCondition
  | FlagBucketCondition
  | FlagJourneyCondition
  | FlagDealCondition
  | FlagEventCondition
  | FlagEmailEngagementCondition
  | FlagTargetingComposite;

/**
 * One ordered targeting rule: a targeting tree plus its own rollout percent.
 * Structural mirror of @hogsend/core's `ConditionSet`.
 */
interface FlagConditionSet {
  description?: string;
  targeting: FlagTargetingNode | FlagPropertyCondition[];
  rollout: number;
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
    // Targeting predicate — a property leaf or an AND/OR composite tree of
    // property leaves, OR the legacy bare `FlagPropertyCondition[]` (implicit
    // AND). Empty (`[]`) means everyone matches.
    targeting: jsonb("targeting")
      .$type<FlagTargetingNode | FlagPropertyCondition[]>()
      .notNull()
      .default([]),
    // Percent (0-100) of the targeted audience eligible for a non-default value.
    rollout: integer("rollout").notNull().default(100),
    // Ordered targeting rules (first matching set wins). NULL for flags that
    // predate condition sets — readers synthesize a single set from the legacy
    // `targeting`+`rollout` columns above (which the write layer keeps coherent
    // from `conditionSets[0]`).
    conditionSets: jsonb("condition_sets").$type<FlagConditionSet[]>(),
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
