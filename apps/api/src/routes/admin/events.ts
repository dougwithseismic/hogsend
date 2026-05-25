import { userEvents } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, count, desc, eq, gte, lte } from "drizzle-orm";
import type { AppEnv } from "../../app.js";

const eventSchema = z.object({
  id: z.string(),
  userId: z.string(),
  event: z.string(),
  properties: z.record(z.string(), z.unknown()).nullable(),
  occurredAt: z.string(),
});

const errorSchema = z.object({ error: z.string() });

function serializeEvent(row: typeof userEvents.$inferSelect) {
  return {
    id: row.id,
    userId: row.userId,
    event: row.event,
    properties: (row.properties ?? null) as Record<string, unknown> | null,
    occurredAt: row.occurredAt.toISOString(),
  };
}

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Events"],
  summary: "List events",
  request: {
    query: z.object({
      limit: z.coerce.number().min(1).max(100).default(50),
      offset: z.coerce.number().min(0).default(0),
      userId: z.string().optional(),
      event: z.string().optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            events: z.array(eventSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
      description: "Paginated event list",
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Admin — Events"],
  summary: "Get event detail",
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ event: eventSchema }),
        },
      },
      description: "Event detail",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Event not found",
    },
  },
});

export const eventsRouter = new OpenAPIHono<AppEnv>()
  .openapi(listRoute, async (c) => {
    const { db } = c.get("container");
    const { limit, offset, userId, event, from, to } = c.req.valid("query");

    const conditions = [];
    if (userId) conditions.push(eq(userEvents.userId, userId));
    if (event) conditions.push(eq(userEvents.event, event));
    if (from) conditions.push(gte(userEvents.occurredAt, new Date(from)));
    if (to) conditions.push(lte(userEvents.occurredAt, new Date(to)));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(userEvents)
        .where(where)
        .orderBy(desc(userEvents.occurredAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(userEvents).where(where),
    ]);

    return c.json(
      {
        events: rows.map(serializeEvent),
        total: totalRows[0]?.count ?? 0,
        limit,
        offset,
      },
      200,
    );
  })
  .openapi(getRoute, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");

    const rows = await db
      .select()
      .from(userEvents)
      .where(eq(userEvents.id, id))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return c.json({ error: "Event not found" }, 404);
    }

    return c.json({ event: serializeEvent(row) }, 200);
  });
