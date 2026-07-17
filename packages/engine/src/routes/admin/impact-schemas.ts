import { z } from "@hono/zod-openapi";

/**
 * Shared wire schemas for the lift/impact admin surfaces (impact
 * experiments D4.2) — hoisted once so the journeys router (/lift, phase
 * 2a) and the /impact + /overview routers (phase 2b) import the SAME
 * shapes, never ad-hoc duplicates. Frozen as the Studio contract at the
 * end of phase 2b.
 */

/** LiftVerdict on the wire — matches lib/lift-stats.ts:86-95 exactly. */
export const liftVerdictSchema = z.object({
  liftPercent: z.number().nullable(),
  winProbability: z.number().nullable(),
  suppressed: z.boolean(),
  smallSample: z.boolean(),
});

export const countsSchema = z.object({
  contacts: z.number(),
  converters: z.number(),
  rate: z.number(),
});

/** Counts + per-currency value (never summed across currencies). */
export const cohortSchema = countsSchema.extend({
  value: z.array(
    z.object({ currency: z.string().nullable(), value: z.number() }),
  ),
});

/**
 * Where an effective definitionId came from: explicit query param, the
 * journey's meta.goal, or neither (any-conversion scope). Hoisted so /lift
 * (2a) and /impact + the Studio mirror (2b/3a) share one source enum.
 */
export const definitionSourceSchema = z.enum(["query", "goal", "none"]);
export type DefinitionSource = z.infer<typeof definitionSourceSchema>;
