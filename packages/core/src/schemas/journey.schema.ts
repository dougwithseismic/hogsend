import { z } from "zod";

const propertyConditionSchema = z.object({
  type: z.literal("property"),
  source: z.enum(["posthog", "context"]),
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

const eventConditionSchema = z.object({
  type: z.literal("event"),
  eventName: z.string(),
  check: z.enum(["exists", "not_exists", "count"]),
  operator: z.enum(["gt", "gte", "lt", "lte", "eq"]).optional(),
  value: z.number().optional(),
  withinHours: z.number().positive().optional(),
});

const emailEngagementConditionSchema = z.object({
  type: z.literal("email_engagement"),
  templateKey: z.string(),
  check: z.enum(["opened", "clicked", "not_opened", "not_clicked"]),
});

const conditionEvalSchema: z.ZodType<unknown> = z.lazy(() =>
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

const sendEmailActionSchema = z.object({
  type: z.literal("send_email"),
  templateKey: z.string(),
  subject: z.string(),
  category: z.string().optional(),
});

const fireEventActionSchema = z.object({
  type: z.literal("fire_event"),
  eventName: z.string(),
  properties: z.record(z.string(), z.unknown()).optional(),
});

const webhookActionSchema = z.object({
  type: z.literal("webhook"),
  url: z.url(),
  method: z.enum(["POST", "PUT"]).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.record(z.string(), z.unknown()).optional(),
});

const enrollJourneyActionSchema = z.object({
  type: z.literal("enroll_journey"),
  journeyId: z.string(),
});

const journeyActionSchema = z.discriminatedUnion("type", [
  sendEmailActionSchema,
  fireEventActionSchema,
  webhookActionSchema,
  enrollJourneyActionSchema,
]);

const actionNodeSchema = z.object({
  type: z.literal("action"),
  id: z.string(),
  action: journeyActionSchema,
  next: z.string().nullable(),
});

const waitNodeSchema = z.object({
  type: z.literal("wait"),
  id: z.string(),
  hours: z.number().positive(),
  next: z.string(),
});

const conditionNodeSchema = z.object({
  type: z.literal("condition"),
  id: z.string(),
  eval: conditionEvalSchema,
  onTrue: z.string(),
  onFalse: z.string(),
});

const journeyNodeSchema = z.discriminatedUnion("type", [
  actionNodeSchema,
  waitNodeSchema,
  conditionNodeSchema,
]);

export const journeyDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean(),

  trigger: z.object({
    event: z.string().min(1),
    where: z.array(propertyConditionSchema).optional(),
  }),

  entryLimit: z.enum(["once", "once_per_period", "unlimited"]),
  entryPeriodHours: z.number().positive().optional(),

  exitOn: z
    .array(
      z.object({
        event: z.string().min(1),
        where: z.array(propertyConditionSchema).optional(),
      }),
    )
    .optional(),

  suppressHours: z.number().min(0),
  entryNode: z.string().min(1),
  nodes: z.record(z.string(), journeyNodeSchema),
});
