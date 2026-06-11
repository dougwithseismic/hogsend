import type { CriteriaBuilder } from "../conditions/builder.js";
import type { DurationObject } from "../duration.js";
import type { PropertyCondition } from "./conditions.js";

/**
 * The builder surface available to a journey `where` function — property
 * terminals only. Trigger/exit conditions evaluate against the TRIGGERING
 * event's properties; counts, windows, and engagement belong in bucket
 * criteria or `ctx.history`, not here.
 */
export type JourneyWhereBuilder = Pick<CriteriaBuilder, "prop">;

/**
 * Authoring form of `trigger.where` / `exitOn[].where`: the stored data form
 * (`PropertyCondition[]`), or a builder function resolved ONCE at
 * `defineJourney` time into the byte-identical POJOs —
 * `where: (b) => b.prop("score").lte(6)`. The function never executes
 * per-user, so conditions stay introspectable data everywhere downstream
 * (registry, admin routes, Studio).
 */
export type JourneyWhere =
  | PropertyCondition[]
  | ((b: JourneyWhereBuilder) => PropertyCondition | PropertyCondition[]);

/**
 * What `defineJourney` ACCEPTS. The stored {@link JourneyMeta} (registry,
 * schema, HTTP) keeps plain `PropertyCondition[]` — only the authoring
 * surface widens.
 */
export interface JourneyMetaInput
  extends Omit<JourneyMeta, "trigger" | "exitOn"> {
  trigger: {
    event: string;
    where?: JourneyWhere;
  };
  exitOn?: Array<{
    event: string;
    where?: JourneyWhere;
  }>;
}

export interface JourneyMeta {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;

  trigger: {
    event: string;
    where?: PropertyCondition[];
  };

  entryLimit: "once" | "once_per_period" | "unlimited";
  entryPeriod?: DurationObject;

  exitOn?: Array<{
    event: string;
    where?: PropertyCondition[];
  }>;

  suppress: DurationObject;

  // Bucket-reaction tagging (set by buildBucketReaction). Generated reactions
  // carry these so the worker's dwell-cron lookup and Studio bucket-detail
  // grouping can discover owned reactions by sourceBucketId.
  sourceBucketId?: string;
  reactionKind?: "enter" | "leave" | "dwell";
  dwellSchedule?: { label: string; after?: number; every?: number };
}

export interface JourneyUser {
  id: string;
  email: string;
  properties: Record<string, string | number | boolean | null>;
  stateId: string;
  journeyId: string;
  journeyName: string;
}
