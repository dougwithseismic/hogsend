import { z } from "zod";
import { propertyConditionSchema } from "../schemas/journey.schema.js";
import type { FlagTargeting } from "./types.js";

/** The two shapes a flag can serve. */
export const flagTypeSchema = z.enum(["boolean", "multivariate"]);

/**
 * One node of a flag's targeting tree: a PROPERTY leaf or an AND/OR COMPOSITE of
 * further nodes. Phase-1 flags target on PROPERTY leaves only — any other leaf
 * `type` (event/email_engagement/…) fails the discriminated union with a clear
 * "Expected 'property' | 'composite'" message. `.meta({ id })` gives the
 * recursive schema a stable ref so OpenAPI/JSON-Schema generators emit a `$ref`
 * instead of unrolling the composite→conditions cycle forever.
 */
export const flagTargetingNodeSchema: z.ZodType<FlagTargeting> = z
  .lazy(() =>
    z.discriminatedUnion("type", [
      propertyConditionSchema,
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
});

export type FlagCreateInput = z.infer<typeof flagCreateSchema>;
export type FlagUpdateInput = z.infer<typeof flagUpdateSchema>;
