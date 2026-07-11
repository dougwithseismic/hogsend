import { z } from "zod";
import type { ConditionEval } from "../types/conditions.js";

export const propertyConditionSchema = z.object({
  type: z.literal("property"),
  property: z.string(),
  operator: z.enum([
    "eq",
    "neq",
    "gt",
    "gte",
    "lt",
    "lte",
    "exists",
    "not_exists",
    "contains",
  ]),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

/**
 * The `within` rolling-window duration on an event condition. Strict keys and
 * at-least-one-key when present: `durationToMs` ignores unknown keys, so a
 * loose `{ days: 7 }` (no such key) or an explicit `{}` would silently become a
 * 0ms window — the condition then evaluates against an empty time range and the
 * branch never fires. `within` omitted entirely stays fine (no window). Kept as
 * a field-level schema (not applied to `eventConditionSchema` itself) so the
 * schema stays a plain object usable as a `discriminatedUnion` member.
 */
const eventWithinSchema = z
  .strictObject({
    hours: z.number().optional(),
    minutes: z.number().optional(),
    seconds: z.number().optional(),
  })
  .refine(
    (d) =>
      d.hours !== undefined ||
      d.minutes !== undefined ||
      d.seconds !== undefined,
    { message: "within must set at least one of hours/minutes/seconds" },
  );

export const eventConditionSchema = z.object({
  type: z.literal("event"),
  eventName: z.string(),
  check: z.enum(["exists", "not_exists", "count"]),
  operator: z.enum(["gt", "gte", "lt", "lte", "eq"]).optional(),
  value: z.number().optional(),
  within: eventWithinSchema.optional(),
});

export const emailEngagementConditionSchema = z.object({
  type: z.literal("email_engagement"),
  templateKey: z.string(),
  check: z.enum(["opened", "clicked", "not_opened", "not_clicked"]),
});

// Typed to the real condition vocabulary (a strict subset of `ConditionEval`:
// `channel_identity` has no schema member — parse fails loudly on it, see
// bucket.schema.ts). The annotation is what lets downstream schemas
// (journey-graph decision nodes, bucket criteria) infer `ConditionEval`
// instead of `unknown`.
//
// `.meta({ id })` gives the RECURSIVE schema a stable ref id: OpenAPI/JSON
// Schema generators emit `$ref: ConditionEval` on re-encounter instead of
// unrolling the composite→conditions cycle forever (stack overflow). The
// self-references inside the lazy getter resolve to this final (meta'd)
// binding, so the ref actually breaks the cycle.
export const conditionEvalSchema: z.ZodType<ConditionEval> = z
  .lazy(() =>
    z.discriminatedUnion("type", [
      propertyConditionSchema,
      eventConditionSchema,
      emailEngagementConditionSchema,
      z.object({
        type: z.literal("composite"),
        operator: z.enum(["and", "or"]),
        conditions: z.array(conditionEvalSchema),
      }),
    ]),
  )
  .meta({ id: "ConditionEval" });

export const journeyMetaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean(),

  trigger: z.object({
    event: z.string().min(1),
    where: z.array(propertyConditionSchema).optional(),
  }),

  entryLimit: z.enum(["once", "once_per_period", "unlimited"]),
  entryPeriod: z
    .object({
      hours: z.number().optional(),
      minutes: z.number().optional(),
      seconds: z.number().optional(),
    })
    .optional(),

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

  // Bucket-reaction tagging. journeyMetaSchema.parse runs inside
  // JourneyRegistry.register and STRIPS unknown keys, so these MUST be declared
  // here or the dwell-cron lookup + Studio grouping silently break.
  sourceBucketId: z.string().optional(),
  reactionKind: z.enum(["enter", "leave", "dwell"]).optional(),
  dwellSchedule: z
    .object({
      label: z.string(),
      after: z.number().optional(),
      every: z.number().optional(),
    })
    .optional(),
});
