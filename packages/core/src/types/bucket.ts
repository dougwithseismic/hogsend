import type { DurationObject } from "../duration.js";
import type { ConditionEval } from "./conditions.js";

export interface BucketMeta {
  id: string;
  name: string;
  description?: string;
  /** Static load-time flag (guard #1), mirrors JourneyMeta.enabled. */
  enabled: boolean;

  /**
   * Discriminator, declared NOW for forward-compat even though "manual" ships in
   * Phase 4. "dynamic" (default) = membership auto-recomputed from `criteria`;
   * "manual" = membership mutated only by explicit API/import, NO criteria,
   * skipped by checkBucketMembership and the reconcile cron (early-continue, the
   * Laudspeaker pattern). Declaring it up front keeps Phase 4 genuinely additive
   * — no breaking change to BucketMeta later. Default "dynamic".
   *
   * v1: kind:"manual" is REJECTED at registration time (bucketMetaSchema parse)
   * because nothing populates a manual bucket yet — it would be a silent no-op.
   * The value stays on the enum for forward-compat; use kind:"dynamic" with
   * `criteria` until full manual membership ships.
   */
  kind?: "dynamic" | "manual";

  /**
   * Membership predicate — the existing 4-type condition engine
   * (packages/core/src/conditions/evaluate.ts). Inclusion AND exclusion come
   * for free via neq / not_exists / not_opened and event check:"not_exists".
   * REQUIRED for kind:"dynamic" (omit/empty for kind:"manual"). Dynamic buckets
   * MUST contain at least one positive condition (validated; pure-negation
   * buckets are degenerate/unbounded — the Customer.io rule). The
   * at-least-one-positive refine applies to dynamic buckets only.
   * NOTE: criteria MUST NOT reference a reserved `bucket:*` event name in any
   * EventCondition.eventName (rejected at registration — see 4.2), so transition
   * rows can never satisfy a bucket predicate.
   */
  criteria?: ConditionEval;

  /**
   * Re-entry policy for EMITTED join events (maps onto checkEntryLimit
   * semantics). "once" = emit bucket:entered once ever; "once_per_period" =
   * re-emit only after a prior leave + period elapses; "unlimited" = always.
   * Default "unlimited".
   */
  entryLimit?: "once" | "once_per_period" | "unlimited";
  entryPeriod?: DurationObject;

  /**
   * Anti-flap: suppress bucket:left until membership has existed at least this
   * long (debounce). Guards journeys from re-enroll spam on oscillation.
   */
  minDwell?: DurationObject;

  /**
   * Maximum dwell — an UNCONDITIONAL membership TTL. `maxDwell` after the user
   * joined, the reconcile cron force-leaves them REGARDLESS of whether the
   * criteria still match (contrast `within`, which is criteria-driven, and
   * `minDwell`, which is a floor). Use it for time-boxed membership: "in this
   * bucket for exactly N days, then out".
   *
   * Re-entry after a maxDwell exit is governed by `entryLimit` (per-bucket): pair
   * with `entryLimit:"once"` / `"once_per_period"` for a HARD time-box (they stay
   * out / cool off), or leave the default `"unlimited"` for a PERIODIC FLUSH
   * (they re-join on their next qualifying event). Independent of `within` and
   * `fastExpiry`; if `minDwell` is also set it must be <= `maxDwell` (validated).
   * Enforced by the reconcile cron, so the exit lands within the reconcile
   * cadence (default 5m), not to-the-second.
   */
  maxDwell?: DurationObject;

  /**
   * Reconciliation knobs.
   * timeBased: criteria contain an event `within` window a clock can expire —
   *   the ONLY kind the cron sweep touches (candidate narrowing). Inferred from
   *   a criteria walk if omitted; an explicit value overrides.
   * reconcileEvery: advisory cadence surfaced in Studio (the single engine-wide
   *   cron sweeps all time-based buckets; per-bucket cadence is informational).
   * reconcileJoins: also re-evaluate JOINS in the sweep. Tri-state:
   *   `false` = hard OFF (cost-bounding override, even for absence buckets);
   *   `true` = explicit ON; `undefined` = INFERRED — ON only for absence-shaped
   *   criteria (a windowed `not_exists` leg, the sole shape a clock can JOIN, so
   *   went-dormant works with no extra config), OFF otherwise (the real-time
   *   path already catches positive joins on event arrival; keep the sweep
   *   O(active members)).
   * fastExpiry: opt-in per-user durable timer for sub-second absence-leave on
   *   latency-critical buckets (Approach A graft). The cron remains the
   *   authoritative backstop. Default false.
   */
  timeBased?: boolean;
  reconcileEvery?: DurationObject;
  reconcileJoins?: boolean;
  fastExpiry?: boolean;

  /**
   * PostHog person-property sync (Section 12). Off by default. When set, on
   * join/leave the engine $set/$unset a boolean person property keyed by
   * `postHogPropertyKey` (default `hogsend_bucket_<id>`).
   */
  syncToPostHog?: boolean;
  postHogPropertyKey?: string;
}
