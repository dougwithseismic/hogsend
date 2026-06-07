import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { ingestEvent } from "../../lib/ingestion.js";
import { applyListMembership } from "../../lib/preferences.js";

const errorSchema = z.object({ error: z.string() });

const eventRequestSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
  userId: z.string().min(1).optional(),
  eventProperties: z.record(z.string(), z.unknown()).optional(),
  contactProperties: z.record(z.string(), z.unknown()).optional(),
  lists: z.record(z.string(), z.boolean()).optional(),
  idempotencyKey: z.string().optional(),
  timestamp: z.string().datetime().optional(),
});

const eventResponseSchema = z.object({
  stored: z.boolean(),
  exits: z.array(
    z.object({
      journeyId: z.string(),
      stateId: z.string(),
      exited: z.boolean(),
    }),
  ),
});

const eventRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Events"],
  summary: "Ingest an event",
  description:
    "Stores the event (with eventProperties), merges contactProperties onto the contact, pushes to Hatchet for journey routing, processes exit conditions, and optionally writes list membership. The `Idempotency-Key` header takes precedence over the body field.",
  request: {
    body: {
      content: {
        "application/json": { schema: eventRequestSchema },
      },
    },
  },
  responses: {
    202: {
      content: {
        "application/json": { schema: eventResponseSchema },
      },
      description: "Event accepted and dispatched",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Missing recipient or unmanageable list membership",
    },
  },
});

export const eventsRouter = new OpenAPIHono<AppEnv>().openapi(
  eventRoute,
  async (c) => {
    const { db, registry, hatchet, logger } = c.get("container");
    const body = c.req.valid("json");

    if (!body.email && !body.userId) {
      return c.json({ error: "email or userId is required" }, 400);
    }

    // The `Idempotency-Key` header wins over the body field (§2.5).
    const headerKey = c.req.header("idempotency-key");
    const idempotencyKey = headerKey ?? body.idempotencyKey;

    const result = await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event: body.name,
        userId: body.userId,
        userEmail: body.email,
        eventProperties: body.eventProperties ?? {},
        contactProperties: body.contactProperties,
        idempotencyKey,
      },
    });

    // Lists applied AFTER ingest so the contact exists (§2.5 lists ordering).
    // `applyListMembership` writes `email_preferences` independently of the
    // contacts row, so it doesn't race the resolve. Requires a resolvable email.
    if (body.lists && Object.keys(body.lists).length > 0) {
      try {
        await applyListMembership({
          db,
          userId: body.userId,
          email: body.email,
          lists: body.lists,
        });
      } catch (err) {
        return c.json(
          {
            error:
              err instanceof Error
                ? err.message
                : "Failed to apply list membership",
          },
          400,
        );
      }
    }

    return c.json(result, 202);
  },
);
