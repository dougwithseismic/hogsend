import { z } from "zod";
import {
  eventConditionSchema,
  propertyConditionSchema,
} from "../schemas/journey.schema.js";
import type { JourneySpec, JourneyStep, SpecCondition } from "./types.js";

/**
 * Zod for {@link JourneySpec}. Shape-only validation lives here; referential
 * checks that need surrounding context (step-id uniqueness, `wait_result.of`
 * ordering, template keys against the registry) live in the engine's loader —
 * they produce better errors with the registry in hand.
 */

const durationSchema = z
  .object({
    hours: z.number().int().nonnegative().optional(),
    minutes: z.number().int().nonnegative().optional(),
    seconds: z.number().int().nonnegative().optional(),
  })
  .refine(
    (d) => (d.hours ?? 0) + (d.minutes ?? 0) + (d.seconds ?? 0) > 0,
    "duration must be > 0 (use hours/minutes/seconds; days(n) = { hours: n * 24 })",
  );

const waitResultConditionSchema = z.object({
  type: z.literal("wait_result"),
  of: z.string().min(1),
  fired: z.boolean(),
});

export const specConditionSchema: z.ZodType<SpecCondition> = z.lazy(() =>
  z.union([
    propertyConditionSchema,
    eventConditionSchema,
    waitResultConditionSchema,
    z.object({
      type: z.literal("composite"),
      operator: z.enum(["and", "or"]),
      conditions: z.array(specConditionSchema).min(1),
    }),
  ]),
);

// Reserved graph node ids the interpreter/graph layer always emit — a step may
// not claim one, or it collides with the synthetic `start`/terminal nodes and
// corrupts the `/graph` metric join by `currentNodeId`.
const RESERVED_STEP_IDS = new Set([
  "start",
  "end-completed",
  "end-exited",
  "end-failed",
]);

const stepId = z
  .string()
  .min(1)
  .max(120)
  .regex(
    /^[a-z0-9][a-z0-9_-]*$/i,
    "step ids are [a-zA-Z0-9_-] and start alphanumeric (they become durable labels)",
  )
  .refine(
    (id) => !RESERVED_STEP_IDS.has(id),
    "step id is reserved (start / end-completed / end-exited / end-failed collide with terminal graph nodes)",
  );

export const journeyStepSchema: z.ZodType<JourneyStep> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      id: stepId,
      type: z.literal("send_email"),
      template: z.string().min(1),
      subject: z.string().min(1),
      props: z.record(z.string(), z.unknown()).optional(),
    }),
    z.object({
      id: stepId,
      type: z.literal("sleep"),
      duration: durationSchema,
    }),
    z.object({
      id: stepId,
      type: z.literal("sleep_until"),
      at: z.string().datetime({ offset: true }),
    }),
    z.object({
      id: stepId,
      type: z.literal("wait_for_event"),
      event: z.string().min(1),
      timeout: durationSchema,
      lookback: durationSchema.optional(),
    }),
    z.object({
      id: stepId,
      type: z.literal("branch"),
      if: specConditionSchema,
      yes: z.array(journeyStepSchema),
      no: z.array(journeyStepSchema).optional(),
    }),
    z.object({
      id: stepId,
      type: z.literal("checkpoint"),
    }),
    z.object({
      id: stepId,
      type: z.literal("trigger_event"),
      event: z.string().min(1),
      properties: z.record(z.string(), z.unknown()).optional(),
    }),
    z.object({
      id: stepId,
      type: z.literal("end"),
    }),
  ]),
) as z.ZodType<JourneyStep>;

/**
 * `meta` reuses the fields of `journeyMetaSchema` minus `id` (the spec carries
 * the id at the top level) and minus the bucket-reaction tags (spec journeys
 * are never bucket reactions).
 */
const specMetaSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean(),
  trigger: z.object({
    event: z.string().min(1),
    where: z.array(propertyConditionSchema).optional(),
  }),
  entryLimit: z.enum(["once", "once_per_period", "unlimited"]),
  entryPeriod: durationSchema.optional(),
  exitOn: z
    .array(
      z.object({
        event: z.string().min(1),
        where: z.array(propertyConditionSchema).optional(),
      }),
    )
    .optional(),
  suppress: z.object({
    hours: z.number().optional(),
    minutes: z.number().optional(),
    seconds: z.number().optional(),
  }),
});

export const journeySpecSchema: z.ZodType<JourneySpec> = z.object({
  specVersion: z.literal(1),
  id: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9_-]*$/i),
  meta: specMetaSchema,
  steps: z.array(journeyStepSchema),
}) as z.ZodType<JourneySpec>;

/** Cheap structural sniff — "is this object shaped like a spec, not a DefinedJourney?" */
export function isJourneySpec(value: unknown): value is JourneySpec {
  return (
    typeof value === "object" &&
    value !== null &&
    "specVersion" in value &&
    "steps" in value &&
    !("task" in value)
  );
}
