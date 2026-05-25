import { auditLogs } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, count, desc, eq, gte, lte } from "drizzle-orm";
import type { AppEnv } from "../../app.js";

const auditLogSchema = z.object({
  id: z.string(),
  actor: z.string(),
  actorKeyId: z.string().nullable(),
  action: z.string(),
  resource: z.string(),
  resourceId: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()).nullable(),
  ipAddress: z.string().nullable(),
  createdAt: z.string(),
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Audit"],
  summary: "List audit logs",
  request: {
    query: z.object({
      limit: z.coerce.number().min(1).max(100).default(50),
      offset: z.coerce.number().min(0).default(0),
      actor: z.string().optional(),
      resource: z.string().optional(),
      action: z.string().optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            logs: z.array(auditLogSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
      description: "Paginated audit log list",
    },
  },
});

function serializeLog(row: typeof auditLogs.$inferSelect) {
  return {
    id: row.id,
    actor: row.actor,
    actorKeyId: row.actorKeyId,
    action: row.action,
    resource: row.resource,
    resourceId: row.resourceId,
    detail: (row.detail ?? null) as Record<string, unknown> | null,
    ipAddress: row.ipAddress,
    createdAt: row.createdAt.toISOString(),
  };
}

export const auditLogsRouter = new OpenAPIHono<AppEnv>().openapi(
  listRoute,
  async (c) => {
    const { db } = c.get("container");
    const { limit, offset, actor, resource, action, from, to } =
      c.req.valid("query");

    const conditions = [];
    if (actor) conditions.push(eq(auditLogs.actor, actor));
    if (resource) conditions.push(eq(auditLogs.resource, resource));
    if (action) conditions.push(eq(auditLogs.action, action));
    if (from) conditions.push(gte(auditLogs.createdAt, new Date(from)));
    if (to) conditions.push(lte(auditLogs.createdAt, new Date(to)));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(auditLogs)
        .where(where)
        .orderBy(desc(auditLogs.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(auditLogs).where(where),
    ]);

    return c.json(
      {
        logs: rows.map(serializeLog),
        total: totalRows[0]?.count ?? 0,
        limit,
        offset,
      },
      200,
    );
  },
);
