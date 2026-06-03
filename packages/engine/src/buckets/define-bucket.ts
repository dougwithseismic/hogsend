import { type CriteriaBuilder, criteriaBuilder } from "@hogsend/core";
import type { BucketMeta, ConditionEval } from "@hogsend/core/types";
import type { hatchet } from "../lib/hatchet.js";

/**
 * `criteria` may be authored two ways:
 *  - declaratively, as a `ConditionEval` data tree, or
 *  - with the fluent builder, as `(b) => b.all(b.prop("plan").eq("trial"), ...)`.
 * The builder form runs ONCE here and returns a `ConditionEval`, so everything
 * downstream (registry indexes, schema validation, reconcile cron, Studio) only
 * ever sees the canonical declarative data.
 */
export type CriteriaInput =
  | ConditionEval
  | ((b: CriteriaBuilder) => ConditionEval);

/** `BucketMeta` as authored — `criteria` accepts the builder function too. */
export type BucketMetaInput = Omit<BucketMeta, "criteria"> & {
  criteria?: CriteriaInput;
};

export interface DefinedBucket {
  meta: BucketMeta;
  /**
   * The only task a bucket ever holds is the opt-in per-user fast-expiry timer,
   * which is a DURABLE task (it `ctx.sleepFor`s — Section 6.5), so the type MUST
   * be the durableTask return type, mirroring
   * `DefinedJourney.task = ReturnType<typeof hatchet.durableTask>`
   * (define-journey.ts:34) — NOT `hatchet.task`. The common case is
   * declarative-only (no task), like webhookSources; the engine-wide
   * `bucketReconcileTask` handles time-based leaves regardless.
   */
  task?: ReturnType<typeof hatchet.durableTask>;
}

export function defineBucket(options: {
  meta: BucketMetaInput;
}): DefinedBucket {
  // The ONLY transform defineBucket performs is resolving a builder-function
  // `criteria` to its `ConditionEval` (a one-shot, definition-time call). It does
  // NOT validate or build any task — `bucketMetaSchema.parse` still happens at
  // BucketRegistry.register, and the fast-expiry durableTask is synthesized later
  // by selectBucketTasks (Section 9.4). A declarative `criteria` passes straight
  // through unchanged, so existing buckets are unaffected.
  const { criteria, ...rest } = options.meta;
  const meta: BucketMeta = {
    ...rest,
    criteria:
      typeof criteria === "function" ? criteria(criteriaBuilder) : criteria,
  };
  return { meta };
}
