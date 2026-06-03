import { z } from "zod";
import type {
  CompositeCondition,
  ConditionEval,
  EmailEngagementCondition,
  EventCondition,
  PropertyCondition,
} from "../types/conditions.js";
import { conditionEvalSchema } from "./journey.schema.js";

const durationObjectSchema = z.object({
  hours: z.number().optional(),
  minutes: z.number().optional(),
  seconds: z.number().optional(),
});

/**
 * Walk a ConditionEval tree, yielding every leaf node (property / event /
 * email_engagement). Composites recurse into their `conditions` array. Mirrors
 * the pure discriminated-union walks in core/conditions.
 */
function* walkConditions(
  condition: ConditionEval,
): Generator<PropertyCondition | EventCondition | EmailEngagementCondition> {
  if (condition.type === "composite") {
    for (const child of (condition as CompositeCondition).conditions) {
      yield* walkConditions(child);
    }
    return;
  }
  yield condition;
}

/**
 * A leaf condition is "negative" when satisfying the bucket means the absence /
 * inequality of data. A dynamic bucket whose every leaf is negative is
 * degenerate/unbounded (the Customer.io rule), so at least one positive leaf is
 * required.
 *
 * Exception: a TIME-BOUNDED behavioral absence — `event` `not_exists` with a
 * `within` window ("did NOT do X in the last N") — is the canonical
 * dormancy/churn predicate (e.g. the `went-dormant` bucket and the whole
 * cron-reconcile leave path exist for it). It is bounded by its window, so it
 * is NOT degenerate and counts as a legitimate anchor. Only an UNBOUNDED
 * absence (`not_exists` with no `within`) matches nearly everyone and is
 * treated as a pure-negation leaf.
 */
function isNegativeLeaf(
  leaf: PropertyCondition | EventCondition | EmailEngagementCondition,
): boolean {
  switch (leaf.type) {
    case "property":
      return leaf.operator === "neq" || leaf.operator === "not_exists";
    case "event":
      return leaf.check === "not_exists" && leaf.within === undefined;
    case "email_engagement":
      return leaf.check === "not_opened" || leaf.check === "not_clicked";
    default:
      return false;
  }
}

export const bucketMetaSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    enabled: z.boolean(),

    kind: z.enum(["dynamic", "manual"]).optional(),

    criteria: conditionEvalSchema.optional(),

    reentry: z.enum(["once", "once_per_period", "unlimited"]).optional(),
    reentryPeriod: durationObjectSchema.optional(),

    minDwell: durationObjectSchema.optional(),

    timeBased: z.boolean().optional(),
    reconcileEvery: durationObjectSchema.optional(),
    reconcileJoins: z.boolean().optional(),
    fastExpiry: z.boolean().optional(),

    syncToPostHog: z.boolean().optional(),
    postHogPropertyKey: z.string().optional(),
  })
  .superRefine((meta, ctx) => {
    const kind = meta.kind ?? "dynamic";
    const criteria = meta.criteria as ConditionEval | undefined;

    // Rule 4: kind/criteria coherence. Manual buckets skip rules 1–3.
    if (kind === "manual") {
      if (criteria !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["criteria"],
          message: 'kind:"manual" buckets must not declare `criteria`.',
        });
      }
      return;
    }

    // kind:"dynamic" (or omitted) REQUIRES a non-empty criteria.
    if (criteria === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["criteria"],
        message: 'kind:"dynamic" buckets require a non-empty `criteria`.',
      });
      return;
    }

    const leaves = Array.from(walkConditions(criteria));

    // Rule 1: at-least-one-positive-condition (dynamic buckets only).
    if (leaves.length > 0 && leaves.every(isNegativeLeaf)) {
      ctx.addIssue({
        code: "custom",
        path: ["criteria"],
        message:
          "Dynamic buckets must contain at least one positive condition; " +
          "pure-negation criteria are degenerate/unbounded.",
      });
    }

    for (const leaf of leaves) {
      // Rule 2: reserved-prefix rejection on EventCondition.eventName.
      if (leaf.type === "event" && leaf.eventName.startsWith("bucket:")) {
        ctx.addIssue({
          code: "custom",
          path: ["criteria"],
          message:
            "criteria must not reference a reserved `bucket:*` event name " +
            `(found "${leaf.eventName}").`,
        });
      }

      // Rule 3: email_engagement forbidden anywhere in v1.
      if (leaf.type === "email_engagement") {
        ctx.addIssue({
          code: "custom",
          path: ["criteria"],
          message:
            "email_engagement conditions are not allowed in bucket criteria " +
            "in v1.",
        });
      }
    }
  });
