import { alertHistory, alertRules } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, count, desc, eq, gte, lte } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { errorSchema } from "../../lib/schemas.js";

const alertRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  threshold: z.record(z.string(), z.number()),
  channel: z.string(),
  channelConfig: z.record(z.string(), z.string()),
  enabled: z.boolean(),
  cooldownMinutes: z.number(),
  lastFiredAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const alertHistorySchema = z.object({
  id: z.string(),
  alertRuleId: z.string(),
  payload: z.record(z.string(), z.unknown()).nullable(),
  deliveryStatus: z.string(),
  error: z.string().nullable(),
  createdAt: z.string(),
});

const listRulesRoute = createRoute({
  method: "get",
  path: "/rules",
  tags: ["Admin — Alerts"],
  summary: "List alert rules",
  request: {
    query: z.object({
      limit: z.coerce.number().min(1).max(100).default(50),
      offset: z.coerce.number().min(0).default(0),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            rules: z.array(alertRuleSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
      description: "Paginated alert rules list",
    },
  },
});

const createRuleRoute = createRoute({
  method: "post",
  path: "/rules",
  tags: ["Admin — Alerts"],
  summary: "Create an alert rule",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            type: z.enum([
              "bounce_rate_exceeded",
              "journey_failure_spike",
              "delivery_issue",
              "high_complaint_rate",
            ]),
            threshold: z.record(z.string(), z.number()),
            channel: z.enum(["webhook", "slack", "email"]),
            channelConfig: z.record(z.string(), z.string()),
            cooldownMinutes: z.number().min(1).default(60),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: z.object({ rule: alertRuleSchema }),
        },
      },
      description: "Alert rule created",
    },
  },
});

const updateRuleRoute = createRoute({
  method: "patch",
  path: "/rules/{id}",
  tags: ["Admin — Alerts"],
  summary: "Update an alert rule",
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().optional(),
            threshold: z.record(z.string(), z.number()).optional(),
            channelConfig: z.record(z.string(), z.string()).optional(),
            enabled: z.boolean().optional(),
            cooldownMinutes: z.number().min(1).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ rule: alertRuleSchema }),
        },
      },
      description: "Alert rule updated",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Alert rule not found",
    },
  },
});

const deleteRuleRoute = createRoute({
  method: "delete",
  path: "/rules/{id}",
  tags: ["Admin — Alerts"],
  summary: "Delete an alert rule",
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ deleted: z.boolean() }),
        },
      },
      description: "Alert rule deleted",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Alert rule not found",
    },
  },
});

const listHistoryRoute = createRoute({
  method: "get",
  path: "/history",
  tags: ["Admin — Alerts"],
  summary: "List alert history",
  request: {
    query: z.object({
      limit: z.coerce.number().min(1).max(100).default(50),
      offset: z.coerce.number().min(0).default(0),
      ruleId: z.string().uuid().optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            history: z.array(alertHistorySchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
      description: "Paginated alert history",
    },
  },
});

function serializeRule(row: typeof alertRules.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    threshold: row.threshold as Record<string, number>,
    channel: row.channel,
    channelConfig: row.channelConfig as Record<string, string>,
    enabled: row.enabled,
    cooldownMinutes: row.cooldownMinutes,
    lastFiredAt: row.lastFiredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const alertsRouter = new OpenAPIHono<AppEnv>()
  .openapi(listRulesRoute, async (c) => {
    const { db } = c.get("container");
    const { limit, offset } = c.req.valid("query");

    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(alertRules)
        .orderBy(desc(alertRules.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(alertRules),
    ]);

    return c.json(
      {
        rules: rows.map(serializeRule),
        total: totalRows[0]?.count ?? 0,
        limit,
        offset,
      },
      200,
    );
  })
  .openapi(createRuleRoute, async (c) => {
    const { db } = c.get("container");
    const body = c.req.valid("json");

    const [created] = await db
      .insert(alertRules)
      .values({
        name: body.name,
        type: body.type,
        threshold: body.threshold,
        channel: body.channel,
        channelConfig: body.channelConfig,
        cooldownMinutes: body.cooldownMinutes,
      })
      .returning();

    if (!created) throw new Error("Failed to create alert rule");

    return c.json({ rule: serializeRule(created) }, 201);
  })
  .openapi(updateRuleRoute, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const rows = await db
      .select()
      .from(alertRules)
      .where(eq(alertRules.id, id))
      .limit(1);

    if (!rows[0]) {
      return c.json({ error: "Alert rule not found" }, 404);
    }

    const [updated] = await db
      .update(alertRules)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.threshold !== undefined ? { threshold: body.threshold } : {}),
        ...(body.channelConfig !== undefined
          ? { channelConfig: body.channelConfig }
          : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.cooldownMinutes !== undefined
          ? { cooldownMinutes: body.cooldownMinutes }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(alertRules.id, id))
      .returning();

    if (!updated) throw new Error("Failed to update alert rule");

    return c.json({ rule: serializeRule(updated) }, 200);
  })
  .openapi(deleteRuleRoute, async (c) => {
    const { db } = c.get("container");
    const { id } = c.req.valid("param");

    const rows = await db
      .select()
      .from(alertRules)
      .where(eq(alertRules.id, id))
      .limit(1);

    if (!rows[0]) {
      return c.json({ error: "Alert rule not found" }, 404);
    }

    await db.delete(alertRules).where(eq(alertRules.id, id));

    return c.json({ deleted: true }, 200);
  })
  .openapi(listHistoryRoute, async (c) => {
    const { db } = c.get("container");
    const { limit, offset, ruleId, from, to } = c.req.valid("query");

    const conditions = [];
    if (ruleId) {
      conditions.push(eq(alertHistory.alertRuleId, ruleId));
    }
    if (from) {
      conditions.push(gte(alertHistory.createdAt, new Date(from)));
    }
    if (to) {
      conditions.push(lte(alertHistory.createdAt, new Date(to)));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(alertHistory)
        .where(where)
        .orderBy(desc(alertHistory.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(alertHistory).where(where),
    ]);

    return c.json(
      {
        history: rows.map((row) => ({
          id: row.id,
          alertRuleId: row.alertRuleId,
          payload: (row.payload ?? null) as Record<string, unknown> | null,
          deliveryStatus: row.deliveryStatus,
          error: row.error,
          createdAt: row.createdAt.toISOString(),
        })),
        total: totalRows[0]?.count ?? 0,
        limit,
        offset,
      },
      200,
    );
  });
