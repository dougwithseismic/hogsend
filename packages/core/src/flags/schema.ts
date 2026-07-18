import { z } from "zod";
import { propertyConditionSchema } from "../schemas/journey.schema.js";

/** The two shapes a flag can serve. */
export const flagTypeSchema = z.enum(["boolean", "multivariate"]);

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
 * table-level default and may be omitted. `targeting` reuses the shared
 * PropertyCondition vocabulary (@hogsend/core) — do NOT invent a new condition
 * type. `rollout` is clamped to 0-100 (integer percent).
 */
export const flagCreateSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  type: flagTypeSchema,
  variants: z.array(flagVariantSchema).optional(),
  defaultValue: z.unknown().optional(),
  targeting: z.array(propertyConditionSchema).optional(),
  rollout: z.number().int().min(0).max(100).optional(),
});

/**
 * Admin UPDATE input — every field optional (toggle `enabled`, edit
 * targeting/rollout/variants, etc.). `key` is immutable and deliberately
 * omitted. `archivedAt` is not settable here — archive is a distinct route.
 */
export const flagUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  type: flagTypeSchema.optional(),
  variants: z.array(flagVariantSchema).optional(),
  defaultValue: z.unknown().optional(),
  targeting: z.array(propertyConditionSchema).optional(),
  rollout: z.number().int().min(0).max(100).optional(),
});

export type FlagCreateInput = z.infer<typeof flagCreateSchema>;
export type FlagUpdateInput = z.infer<typeof flagUpdateSchema>;
