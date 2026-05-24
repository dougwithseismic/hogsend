import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { ingestEvent } from "../../lib/ingestion.js";

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

const posthogResponseSchema = z.object({
  ok: z.boolean(),
  event: z.string(),
  userId: z.string(),
  exits: z
    .array(
      z.object({
        journeyId: z.string(),
        stateId: z.string(),
        exited: z.boolean(),
      }),
    )
    .optional(),
});

const posthogWebhookRoute = createRoute({
  method: "post",
  path: "/posthog",
  tags: ["Webhooks"],
  summary: "PostHog webhook receiver",
  description:
    "Receives events from PostHog webhook destinations. Transforms the PostHog payload into internal events, pushes to Hatchet for journey routing, and processes exit conditions.",
  request: {
    body: {
      content: {
        "application/json": { schema: posthogWebhookSchema },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: posthogResponseSchema },
      },
      description: "Webhook processed",
    },
    401: {
      description: "Invalid webhook secret",
    },
  },
});

export const posthogWebhookRouter = new OpenAPIHono<AppEnv>().openapi(
  posthogWebhookRoute,
  async (c) => {
    const { db, registry, hatchet, logger, env } = c.get("container");

    if (env.POSTHOG_WEBHOOK_SECRET) {
      const provided =
        c.req.header("x-posthog-webhook-secret") ??
        c.req.header("authorization")?.replace("Bearer ", "");

      if (provided !== env.POSTHOG_WEBHOOK_SECRET) {
        return c.json({ error: "Invalid webhook secret" }, 401) as never;
      }
    }

    const body = c.req.valid("json");

    const eventName = body.event.event;
    const userId = body.event.distinct_id;
    const userEmail = body.person?.properties?.email ?? "";
    const properties: Record<string, unknown> = {
      ...body.event.properties,
      ...body.person?.properties,
    };

    if (body.event.uuid) {
      properties._posthogEventId = body.event.uuid;
    }

    logger.info("PostHog webhook received", {
      event: eventName,
      userId,
      hasEmail: !!userEmail,
    });

    const result = await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event: eventName,
        userId,
        userEmail: typeof userEmail === "string" ? userEmail : "",
        properties,
      },
    });

    return c.json(
      {
        ok: true,
        event: eventName,
        userId,
        exits: result.exits,
      },
      200,
    );
  },
);
