import { z } from "zod";

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

export const eventConditionSchema = z.object({
  type: z.literal("event"),
  eventName: z.string(),
  check: z.enum(["exists", "not_exists", "count"]),
  operator: z.enum(["gt", "gte", "lt", "lte", "eq"]).optional(),
  value: z.number().optional(),
  within: z
    .object({
      hours: z.number().optional(),
      minutes: z.number().optional(),
      seconds: z.number().optional(),
    })
    .optional(),
});

export const emailEngagementConditionSchema = z.object({
  type: z.literal("email_engagement"),
  templateKey: z.string(),
  check: z.enum(["opened", "clicked", "not_opened", "not_clicked"]),
});

export const conditionEvalSchema: z.ZodType<unknown> = z.lazy(() =>
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
);

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
