import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../app.js";
import { ingestEvent } from "../lib/ingestion.js";

const ingestRequestSchema = z.object({
  event: z.string().min(1),
  userId: z.string().min(1),
  userEmail: z.string().email().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().optional(),
  timestamp: z.string().datetime().optional(),
});

const ingestResponseSchema = z.object({
  stored: z.boolean(),
  exits: z.array(
    z.object({
      journeyId: z.string(),
      stateId: z.string(),
      exited: z.boolean(),
    }),
  ),
});

const ingestRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Ingestion"],
  summary: "Ingest an event",
  description:
    "Receives events from direct API calls. Stores the event, pushes it to Hatchet for journey routing, and processes exit conditions.",
  request: {
    body: {
      content: {
        "application/json": { schema: ingestRequestSchema },
      },
    },
  },
  responses: {
    202: {
      content: {
        "application/json": { schema: ingestResponseSchema },
      },
      description: "Event accepted and dispatched",
    },
  },
});

export const ingestRouter = new OpenAPIHono<AppEnv>().openapi(
  ingestRoute,
  async (c) => {
    const body = c.req.valid("json");
    const { db, registry, hatchet, logger } = c.get("container");

    const result = await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event: body.event,
        userId: body.userId,
        userEmail: body.userEmail ?? "",
        properties: body.properties ?? {},
        idempotencyKey: body.idempotencyKey,
      },
    });

    return c.json(result, 202);
  },
);
