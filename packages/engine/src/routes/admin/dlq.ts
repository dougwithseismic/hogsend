import { deadLetterQueue } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, count, desc, eq } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { errorSchema } from "../../lib/schemas.js";

const dlqEntrySchema = z.object({
  id: z.string(),
  source: z.string(),
  sourceId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  error: z.string(),
  retryCount: z.number(),
  status: z.string(),
  retriedAt: z.string().nullable(),
  createdAt: z.string(),
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Dead Letter Queue"],
  summary: "List dead letter queue entries",
  request: {
    query: z.object({
      limit: z.coerce.number().min(1).max(100).default(50),
      offset: z.coerce.number().min(0).default(0),
      source: z.string().optional(),
      status: z.enum(["pending", "retried", "discarded"]).optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            entries: z.array(dlqEntrySchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
      description: "Paginated DLQ entries",
    },
  },
});

const retryRoute = createRoute({
  method: "post",
  path: "/{id}/retry",
  tags: ["Admin — Dead Letter Queue"],
  summary: "Retry a dead letter queue entry",
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ retried: z.boolean() }),
        },
      },
      description: "DLQ entry marked for retry",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "DLQ entry not found",
    },
    409: {
      content: { "application/json": { schema: errorSchema } },
      description: "DLQ entry not in pending state",
    },
  },
});

const discardRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Admin — Dead Letter Queue"],
  summary: "Discard a dead letter queue entry",
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ discarded: z.boolean() }),
        },
      },
      description: "DLQ entry discarded",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "DLQ entry not found",
    },
  },
});

function serializeEntry(row: typeof deadLetterQueue.$inferSelect) {
  return {
    id: row.id,
    source: row.source,
    sourceId: row.sourceId,
    payload: row.payload as Record<string, unknown>,
    error: row.error,
    retryCount: row.retryCount,
    status: row.status,
    retriedAt: row.retriedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export const dlqRouter = new OpenAPIHono<AppEnv>()
  .openapi(listRoute, async (c) => {
    const { db } = c.get("container");
    const { limit, offset, source, status } = c.req.valid("query");

    const conditions = [];
    if (source) {
      conditions.push(eq(deadLetterQueue.source, source));
    }
    if (status) {
      conditions.push(eq(deadLetterQueue.status, status));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(deadLetterQueue)
        .where(where)
        .orderBy(desc(deadLetterQueue.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(deadLetterQueue).where(where),
    ]);

    return c.json(
      {
        entries: rows.map(serializeEntry),
        total: totalRows[0]?.count ?? 0,
        limit,
        offset,
      },
      200,
    );
  })
  .openapi(retryRoute, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");

    const rows = await db
      .select()
      .from(deadLetterQueue)
      .where(eq(deadLetterQueue.id, id))
      .limit(1);

    const entry = rows[0];
    if (!entry) {
      return c.json({ error: "DLQ entry not found" }, 404);
    }

    if (entry.status !== "pending") {
      return c.json({ error: "Entry is not in pending state" }, 409);
    }

    await db
      .update(deadLetterQueue)
      .set({
        status: "retried",
        retryCount: entry.retryCount + 1,
        retriedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(deadLetterQueue.id, id));

    return c.json({ retried: true }, 200);
  })
  .openapi(discardRoute, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");

    const rows = await db
      .select()
      .from(deadLetterQueue)
      .where(eq(deadLetterQueue.id, id))
      .limit(1);

    if (!rows[0]) {
      return c.json({ error: "DLQ entry not found" }, 404);
    }

    await db
      .update(deadLetterQueue)
      .set({ status: "discarded", updatedAt: new Date() })
      .where(eq(deadLetterQueue.id, id));

    return c.json({ discarded: true }, 200);
  });
