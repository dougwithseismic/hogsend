import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../../app.js";
import { applyListMembership } from "../../lib/preferences.js";
import { getListRegistry } from "../../lists/registry-singleton.js";

const errorSchema = z.object({ error: z.string() });

const bodySchema = z.object({
  email: z.string().optional(),
  userId: z.string().optional(),
});

const subscribeRoute = createRoute({
  method: "post",
  path: "/{id}/subscribe",
  tags: ["Lists"],
  summary: "Subscribe a contact to a list",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: bodySchema } },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            list: z.string(),
            subscribed: z.literal(true),
          }),
        },
      },
      description: "Contact subscribed",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Missing recipient or no resolvable email",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Unknown list id",
    },
  },
});

const unsubscribeRoute = createRoute({
  method: "post",
  path: "/{id}/unsubscribe",
  tags: ["Lists"],
  summary: "Unsubscribe a contact from a list",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: bodySchema } },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            list: z.string(),
            subscribed: z.literal(false),
          }),
        },
      },
      description: "Contact unsubscribed",
    },
    400: {
      content: { "application/json": { schema: errorSchema } },
      description: "Missing recipient or no resolvable email",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Unknown list id",
    },
  },
});

export const listSubscribeRouter = new OpenAPIHono<AppEnv>()
  .openapi(subscribeRoute, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");
    const { email, userId } = c.req.valid("json");

    if (!getListRegistry().has(id)) {
      return c.json({ error: `Unknown list: ${id}` }, 404);
    }

    if (!email && !userId) {
      return c.json({ error: "email or userId is required" }, 400);
    }

    try {
      await applyListMembership({ db, userId, email, lists: { [id]: true } });
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

    return c.json({ list: id, subscribed: true as const }, 200);
  })
  .openapi(unsubscribeRoute, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");
    const { email, userId } = c.req.valid("json");

    if (!getListRegistry().has(id)) {
      return c.json({ error: `Unknown list: ${id}` }, 404);
    }

    if (!email && !userId) {
      return c.json({ error: "email or userId is required" }, 400);
    }

    try {
      await applyListMembership({ db, userId, email, lists: { [id]: false } });
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

    return c.json({ list: id, subscribed: false as const }, 200);
  });
