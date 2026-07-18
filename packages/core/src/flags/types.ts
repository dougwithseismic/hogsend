import type {
  EmailEngagementCondition,
  EventCondition,
  PropertyCondition,
} from "../types/conditions.js";

/**
 * A leaf asserting the contact is (or, with `negate`, is NOT) an ACTIVE member
 * of a `bucket` — evaluated PURELY from the targeting snapshot's live-membership
 * set (`bucket_memberships` where `status='active'`). No per-flag DB query.
 */
export interface BucketCondition {
  type: "bucket";
  bucketId: string;
  negate?: boolean;
}

/**
 * A leaf asserting the contact's state in a `journey`. `state:"active"` matches a
 * live enrollment (`journey_states.status` IN `active`/`waiting`);
 * `state:"completed"` matches any completed run. Evaluated PURELY from the
 * snapshot; `negate` flips the answer.
 */
export interface JourneyCondition {
  type: "journey";
  journeyId: string;
  state: "active" | "completed";
  negate?: boolean;
}

/**
 * A leaf asserting the contact's CRM `deal` posture, evaluated PURELY from the
 * snapshot's projected deals:
 *   - `won`   — has a sold deal
 *   - `open`  — has a deal that is neither sold nor lost
 *   - `stage` — has a deal whose canonical stage equals `stage`
 * `negate` flips the answer.
 */
export interface DealCondition {
  type: "deal";
  predicate: "won" | "open" | "stage";
  stage?: string;
  negate?: boolean;
}

/**
 * A composite (AND/OR) node of a flag's targeting tree. Its children are
 * themselves {@link FlagTargeting} nodes, so groups nest arbitrarily.
 */
export interface FlagTargetingComposite {
  type: "composite";
  operator: "and" | "or";
  conditions: FlagTargeting[];
}

/**
 * A flag's targeting condition tree. Leaves are:
 *   - PURE (snapshot-backed, DB-free per evaluation): `property`, `bucket`,
 *     `journey`, `deal` — safe on the browser `GET /v1/flags` hot path.
 *   - SERVER-ONLY (unbounded scan): `event`, `email_engagement` — resolved ONLY
 *     on the secret-key `POST /v1/flags/evaluate` path; they short-circuit to
 *     `false` on the browser path.
 * A COMPOSITE folds AND/OR over further nodes.
 *
 * BACK-COMPAT: the stored shape was a bare `PropertyCondition[]` (implicit AND,
 * incl. `[]` = matches everyone). Readers accept BOTH — a bare array is treated
 * as `{ type: "composite", operator: "and", conditions: [...] }`.
 */
export type FlagTargeting =
  | PropertyCondition
  | BucketCondition
  | JourneyCondition
  | DealCondition
  | EventCondition
  | EmailEngagementCondition
  | FlagTargetingComposite;

/**
 * One ordered targeting rule of a flag: a `targeting` tree plus its own
 * `rollout` percent. The evaluator walks a flag's condition sets IN ORDER; the
 * FIRST set whose targeting matches AND whose per-set rollout bucket admits the
 * contact turns the flag ON (see the engine's `evaluateFlag`). An optional
 * `description` documents the rule for Studio.
 */
export interface ConditionSet {
  description?: string;
  /**
   * The rule's targeting tree. Accepts the legacy bare `PropertyCondition[]`
   * (implicit AND) alongside the tree form, mirroring a flag's own `targeting`.
   */
  targeting: FlagTargeting | PropertyCondition[];
  rollout: number;
}

/** The two shapes a flag can serve. */
export type FlagType = "boolean" | "multivariate";

/**
 * One multivariate arm of a flag: a keyed value served to a slice of the
 * rollout, sized by `weight` (weights are relative; the engine picks by
 * cumulative weight over a deterministic unit-hash of contactKey+flagKey).
 */
export interface FlagVariant {
  key: string;
  value: unknown;
  weight: number;
}

/**
 * The portable domain shape of a native, DB-backed feature flag. Evaluation is
 * STICKY by construction (a deterministic hash of contactKey+flagKey), so there
 * is no per-user assignment. Hand-written and decoupled from the drizzle row so
 * SDK consumers don't take a DB dependency — kept in sync with the `flags`
 * table (`@hogsend/db`).
 */
export interface FlagDefinition {
  id: string;
  /** The stable string identifier a client evaluates against. */
  key: string;
  name: string;
  description: string | null;
  /** Master switch: a disabled flag always serves `defaultValue`. */
  enabled: boolean;
  type: FlagType;
  /** Multivariate arms. Empty for a boolean flag. */
  variants: FlagVariant[];
  /**
   * Served when the flag is disabled, targeting fails, or the contact is not in
   * the rollout slice. For a boolean flag this is `false`.
   */
  defaultValue: unknown;
  /**
   * Legacy single targeting predicate (empty means everyone matches). Kept for
   * back-compat; `conditionSets` is the richer ordered form.
   */
  targeting: PropertyCondition[];
  /** Percent (0-100) of the targeted audience eligible for a non-default value. */
  rollout: number;
  /**
   * Ordered targeting rules (first matching set wins). Synthesized from
   * `targeting`+`rollout` when a flag predates condition sets.
   */
  conditionSets: ConditionSet[];
  /** Provenance seam for deferred provider sync — "native" today. */
  origin: string;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
