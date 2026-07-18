import { z } from "zod";
import {
  emailEngagementConditionSchema,
  eventConditionSchema,
  propertyConditionSchema,
} from "../schemas/journey.schema.js";
import type { ConditionSet, FlagTargeting } from "./types.js";

/** The two shapes a flag can serve. */
export const flagTypeSchema = z.enum(["boolean", "multivariate"]);

/** Snapshot-backed membership leaf (`bucket_memberships`). */
export const bucketConditionSchema = z.object({
  type: z.literal("bucket"),
  bucketId: z.string().min(1),
  negate: z.boolean().optional(),
});

/** Snapshot-backed journey-state leaf (`journey_states`). */
export const journeyConditionSchema = z.object({
  type: z.literal("journey"),
  journeyId: z.string().min(1),
  state: z.enum(["active", "completed"]),
  negate: z.boolean().optional(),
});

/** Snapshot-backed CRM deal leaf (`deals` projection). */
export const dealConditionSchema = z.object({
  type: z.literal("deal"),
  predicate: z.enum(["won", "open", "stage"]),
  stage: z.string().min(1).optional(),
  negate: z.boolean().optional(),
});

/**
 * One node of a flag's targeting tree. Leaves are the PURE snapshot-backed set
 * (`property`/`bucket`/`journey`/`deal`) plus the SERVER-ONLY scan set
 * (`event`/`email_engagement`, resolved only on the secret-key evaluate path),
 * or an AND/OR COMPOSITE of further nodes. `.meta({ id })` gives the recursive
 * schema a stable ref so OpenAPI/JSON-Schema generators emit a `$ref` instead of
 * unrolling the composite→conditions cycle forever.
 */
export const flagTargetingNodeSchema: z.ZodType<FlagTargeting> = z
  .lazy(() =>
    z.discriminatedUnion("type", [
      propertyConditionSchema,
      bucketConditionSchema,
      journeyConditionSchema,
      dealConditionSchema,
      eventConditionSchema,
      emailEngagementConditionSchema,
      z.object({
        type: z.literal("composite"),
        operator: z.enum(["and", "or"]),
        conditions: z.array(flagTargetingNodeSchema),
      }),
    ]),
  )
  .meta({ id: "FlagTargetingNode" });

/**
 * A flag's targeting accepts BOTH shapes on create/update:
 *   1. the legacy bare `PropertyCondition[]` (implicit AND; `[]` = everyone), and
 *   2. the Phase-1 condition TREE (a property leaf or an AND/OR composite).
 * Either way the leaves must be PROPERTY conditions — other condition types are
 * rejected with a clear discriminator message.
 */
export const flagTargetingSchema = z.union([
  z.array(propertyConditionSchema),
  flagTargetingNodeSchema,
]);

/**
 * One ordered targeting rule of a flag: a `targeting` tree plus its own
 * `rollout` percent (0-100). The evaluator walks a flag's condition sets IN
 * ORDER and the FIRST match (targeting true AND per-set rollout admits the
 * contact) wins.
 */
export const flagConditionSetSchema: z.ZodType<ConditionSet> = z.object({
  description: z.string().optional(),
  targeting: flagTargetingSchema,
  rollout: z.number().int().min(0).max(100),
});

/**
 * One multivariate arm. `value` is `z.unknown()` (any JSON is a valid served
 * value); `weight` is a non-negative number (relative — the engine normalizes
 * by the cumulative sum).
 */
export const flagVariantSchema = z.object({
  key: z.string().min(1),
  value: z.unknown(),
  weight: z.number().min(0),
});

/**
 * Admin CREATE input. `key`/`name`/`type` are required; everything else has a
 * table-level default and may be omitted. `targeting` accepts BOTH the legacy
 * `PropertyCondition[]` array (implicit AND) and the Phase-1 condition tree (a
 * property leaf or an AND/OR composite of property leaves) — see
 * {@link flagTargetingSchema}. `rollout` is clamped to 0-100 (integer percent).
 */
export const flagCreateSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  type: flagTypeSchema,
  variants: z.array(flagVariantSchema).optional(),
  defaultValue: z.unknown().optional(),
  targeting: flagTargetingSchema.optional(),
  rollout: z.number().int().min(0).max(100).optional(),
  /**
   * Ordered targeting rules (first matching set wins). When present it takes
   * precedence over the legacy `targeting`+`rollout` pair; the write layer keeps
   * the legacy columns coherent from `conditionSets[0]`.
   */
  conditionSets: z.array(flagConditionSetSchema).optional(),
});

/**
 * Admin UPDATE input — every field optional (toggle `enabled`, edit
 * key/targeting/rollout/variants, etc.). `key` is editable (it must stay unique
 * among live flags; the route returns 409 on a collision) — changing it
 * re-points the readers that evaluate this flag by key. `archivedAt` is not
 * settable here — archive is a distinct route.
 */
export const flagUpdateSchema = z.object({
  key: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  type: flagTypeSchema.optional(),
  variants: z.array(flagVariantSchema).optional(),
  defaultValue: z.unknown().optional(),
  targeting: flagTargetingSchema.optional(),
  rollout: z.number().int().min(0).max(100).optional(),
  conditionSets: z.array(flagConditionSetSchema).optional(),
});

export type FlagCreateInput = z.infer<typeof flagCreateSchema>;
export type FlagUpdateInput = z.infer<typeof flagUpdateSchema>;
