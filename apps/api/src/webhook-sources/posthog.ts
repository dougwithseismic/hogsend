import { defineWebhookSource } from "@hogsend/engine";
import { z } from "zod";

const posthogEventSchema = z.object({
  uuid: z.string().optional(),
  event: z.string(),
  distinct_id: z.string(),
  timestamp: z.string().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  url: z.string().optional(),
});

const posthogPersonSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  url: z.string().optional(),
  properties: z
    .object({
      email: z.string().optional(),
    })
    .catchall(z.unknown())
    .optional(),
});

const posthogWebhookSchema = z.object({
  event: posthogEventSchema,
  person: posthogPersonSchema.optional(),
  groups: z.record(z.string(), z.unknown()).optional(),
  project: z.record(z.string(), z.unknown()).optional(),
});

export const posthogSource = defineWebhookSource({
  meta: {
    id: "posthog",
    name: "PostHog",
    description:
      "Receives events from PostHog webhook destinations and workflow batch triggers.",
  },
  auth: {
    header: "x-posthog-webhook-secret",
    envKey: "POSTHOG_WEBHOOK_SECRET",
    type: "match",
  },
  schema: posthogWebhookSchema,
  async transform(payload) {
    const eventName = payload.event.event;
    const userId = payload.event.distinct_id;
    const rawEmail = payload.person?.properties?.email;
    const userEmail = typeof rawEmail === "string" ? rawEmail : "";

    const properties: Record<string, unknown> = {
      ...payload.event.properties,
      ...payload.person?.properties,
    };

    if (payload.event.uuid) {
      properties._posthogEventId = payload.event.uuid;
    }

    return { event: eventName, userId, userEmail, properties };
  },
});
