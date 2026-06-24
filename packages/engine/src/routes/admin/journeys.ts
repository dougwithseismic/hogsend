import {
  type Database,
  emailSends,
  journeyConfigs,
  journeyLogs,
  journeyStates,
} from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { ingestEvent } from "../../lib/ingestion.js";

const journeySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  enabled: z.boolean(),
  trigger: z.object({
    event: z.string(),
  }),
  entryLimit: z.enum(["once", "once_per_period", "unlimited"]),
  counts: z.object({
    active: z.number(),
    waiting: z.number(),
    completed: z.number(),
    failed: z.number(),
    exited: z.number(),
  }),
});

const stateSchema = z.object({
  id: z.string(),
  userId: z.string(),
  userEmail: z.string(),
  journeyId: z.string(),
  currentNodeId: z.string(),
  status: z.string(),
  hatchetRunId: z.string().nullable(),
  context: z.record(z.string(), z.unknown()),
  errorMessage: z.string().nullable(),
  entryCount: z.number(),
  completedAt: z.string().nullable(),
  exitedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const errorSchema = z.object({ error: z.string() });

function serializeState(row: typeof journeyStates.$inferSelect) {
  return {
    ...row,
    context: (row.context ?? {}) as Record<string, unknown>,
    completedAt: row.completedAt?.toISOString() ?? null,
    exitedAt: row.exitedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeLog(row: typeof journeyLogs.$inferSelect) {
  return {
    id: row.id,
    fromNodeId: row.fromNodeId,
    toNodeId: row.toNodeId,
    action: row.action,
    detail: (row.detail ?? null) as Record<string, unknown> | null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function fetchState(db: Database, journeyId: string, stateId: string) {
  return db
    .select()
    .from(journeyStates)
    .where(
      and(
        eq(journeyStates.id, stateId),
        eq(journeyStates.journeyId, journeyId),
        isNull(journeyStates.deletedAt),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

const emptyCounts = {
  active: 0,
  waiting: 0,
  completed: 0,
  failed: 0,
  exited: 0,
};

// --- Route definitions ---

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Journeys"],
  summary: "List all journeys",
  request: {
    query: z.object({
      limit: z.coerce.number().min(1).max(100).default(50),
      offset: z.coerce.number().min(0).default(0),
      enabled: z.enum(["true", "false"]).optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            journeys: z.array(journeySchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
      description: "Paginated journey list",
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Admin — Journeys"],
  summary: "Get journey detail",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            journey: journeySchema.extend({
              trigger: z.object({
                event: z.string(),
                where: z.array(z.record(z.string(), z.unknown())).optional(),
              }),
              exitOn: z
                .array(
                  z.object({
                    event: z.string(),
                    where: z
                      .array(z.record(z.string(), z.unknown()))
                      .optional(),
                  }),
                )
                .optional(),
              suppress: z.record(z.string(), z.number()),
              recentStates: z.array(stateSchema),
            }),
          }),
        },
      },
      description: "Journey detail with counts and recent states",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Journey not found",
    },
  },
});

const patchRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Admin — Journeys"],
  summary: "Enable or disable a journey",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ enabled: z.boolean() }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            journey: z.object({
              id: z.string(),
              name: z.string(),
              enabled: z.boolean(),
              updatedAt: z.string(),
            }),
          }),
        },
      },
      description: "Journey updated",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Journey not found",
    },
  },
});

const listStatesRoute = createRoute({
  method: "get",
  path: "/{id}/states",
  tags: ["Admin — Journeys"],
  summary: "List journey instances",
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      limit: z.coerce.number().min(1).max(100).default(50),
      offset: z.coerce.number().min(0).default(0),
      status: z
        .enum(["active", "waiting", "completed", "failed", "exited"])
        .optional(),
      userId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            states: z.array(stateSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
      description: "Paginated journey states",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Journey not found",
    },
  },
});

const getStateRoute = createRoute({
  method: "get",
  path: "/{id}/states/{stateId}",
  tags: ["Admin — Journeys"],
  summary: "Get journey instance detail with logs",
  request: {
    params: z.object({
      id: z.string(),
      stateId: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            state: stateSchema,
            logs: z.array(
              z.object({
                id: z.string(),
                fromNodeId: z.string().nullable(),
                toNodeId: z.string().nullable(),
                action: z.string(),
                detail: z.record(z.string(), z.unknown()).nullable(),
                createdAt: z.string(),
              }),
            ),
          }),
        },
      },
      description: "Journey instance with logs",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "State not found",
    },
  },
});

const cancelStateRoute = createRoute({
  method: "delete",
  path: "/{id}/states/{stateId}",
  tags: ["Admin — Journeys"],
  summary: "Cancel a journey instance",
  request: {
    params: z.object({
      id: z.string(),
      stateId: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            state: z.object({
              id: z.string(),
              status: z.literal("exited"),
              exitedAt: z.string(),
            }),
            hatchetCancelled: z.boolean(),
          }),
        },
      },
      description: "Journey instance cancelled",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "State not found",
    },
    409: {
      content: { "application/json": { schema: errorSchema } },
      description: "State already in terminal status",
    },
  },
});

const enrollRoute = createRoute({
  method: "post",
  path: "/{id}/enroll",
  tags: ["Admin — Journeys"],
  summary: "Manually enroll a user in a journey",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            userId: z.string().min(1),
            userEmail: z.string().email(),
            properties: z.record(z.string(), z.unknown()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    202: {
      content: {
        "application/json": {
          schema: z.object({
            enrolled: z.boolean(),
            event: z.string(),
            userId: z.string(),
          }),
        },
      },
      description: "Enrollment event dispatched",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Journey not found",
    },
  },
});

// --- Handlers ---

const templatesRoute = createRoute({
  method: "get",
  path: "/{id}/templates",
  tags: ["Admin — Journeys"],
  summary: "Email templates this journey has sent (observed from email_sends)",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            templates: z.array(
              z.object({
                templateKey: z.string(),
                sent: z.number(),
                opened: z.number(),
                clicked: z.number(),
                lastSentAt: z.string().nullable(),
              }),
            ),
          }),
        },
      },
      description:
        "Distinct templates sent within this journey, with engagement counts",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Journey not found",
    },
  },
});

export const journeysRouter = new OpenAPIHono<AppEnv>()
  .openapi(listRoute, async (c) => {
    const { db, registry } = c.get("container");
    const { limit, offset, enabled } = c.req.valid("query");

    const allJourneys = registry.getAll();

    const journeyIds = allJourneys.map((j) => j.id);

    const [configs, statusCounts] = await Promise.all([
      journeyIds.length > 0
        ? db
            .select()
            .from(journeyConfigs)
            .where(inArray(journeyConfigs.journeyId, journeyIds))
        : Promise.resolve([]),
      journeyIds.length > 0
        ? db
            .select({
              journeyId: journeyStates.journeyId,
              status: journeyStates.status,
              count: count(),
            })
            .from(journeyStates)
            .where(
              and(
                inArray(journeyStates.journeyId, journeyIds),
                isNull(journeyStates.deletedAt),
              ),
            )
            .groupBy(journeyStates.journeyId, journeyStates.status)
        : Promise.resolve([]),
    ]);

    const configMap = new Map(configs.map((c) => [c.journeyId, c.enabled]));
    const countsMap = new Map<string, typeof emptyCounts>();
    for (const row of statusCounts) {
      const existing = countsMap.get(row.journeyId) ?? { ...emptyCounts };
      existing[row.status as keyof typeof emptyCounts] = row.count;
      countsMap.set(row.journeyId, existing);
    }

    const result = allJourneys.map((j) => {
      const dbEnabled = configMap.get(j.id);
      const effectiveEnabled = dbEnabled !== undefined ? dbEnabled : j.enabled;
      return {
        id: j.id,
        name: j.name,
        description: j.description,
        enabled: effectiveEnabled,
        trigger: { event: j.trigger.event },
        entryLimit: j.entryLimit,
        counts: countsMap.get(j.id) ?? { ...emptyCounts },
      };
    });

    const filtered =
      enabled !== undefined
        ? result.filter((j) => j.enabled === (enabled === "true"))
        : result;

    const total = filtered.length;
    const paged = filtered.slice(offset, offset + limit);

    return c.json({ journeys: paged, total, limit, offset }, 200);
  })
  .openapi(getRoute, async (c) => {
    const { db, registry } = c.get("container");
    const { id } = c.req.valid("param");

    const meta = registry.get(id);
    if (!meta) {
      return c.json({ error: "Journey not found" }, 404);
    }

    const [configs, statusCounts, recentRows] = await Promise.all([
      db
        .select()
        .from(journeyConfigs)
        .where(eq(journeyConfigs.journeyId, id))
        .limit(1),
      db
        .select({
          status: journeyStates.status,
          count: count(),
        })
        .from(journeyStates)
        .where(
          and(eq(journeyStates.journeyId, id), isNull(journeyStates.deletedAt)),
        )
        .groupBy(journeyStates.status),
      db
        .select()
        .from(journeyStates)
        .where(
          and(eq(journeyStates.journeyId, id), isNull(journeyStates.deletedAt)),
        )
        .orderBy(desc(journeyStates.updatedAt))
        .limit(10),
    ]);

    const dbEnabled = configs[0]?.enabled;
    const effectiveEnabled = dbEnabled !== undefined ? dbEnabled : meta.enabled;

    const counts = { ...emptyCounts };
    for (const row of statusCounts) {
      counts[row.status as keyof typeof emptyCounts] = row.count;
    }

    return c.json(
      {
        journey: {
          id: meta.id,
          name: meta.name,
          description: meta.description,
          enabled: effectiveEnabled,
          trigger: {
            event: meta.trigger.event,
            where: meta.trigger.where as Record<string, unknown>[] | undefined,
          },
          entryLimit: meta.entryLimit,
          exitOn: meta.exitOn?.map((e) => ({
            event: e.event,
            where: e.where as Record<string, unknown>[] | undefined,
          })),
          suppress: meta.suppress as Record<string, number>,
          counts,
          recentStates: recentRows.map(serializeState),
        },
      },
      200,
    );
  })
  .openapi(patchRoute, async (c) => {
    const { db, registry } = c.get("container");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const meta = registry.get(id);
    if (!meta) {
      return c.json({ error: "Journey not found" }, 404);
    }

    const [config] = await db
      .insert(journeyConfigs)
      .values({ journeyId: id, enabled: body.enabled })
      .onConflictDoUpdate({
        target: [journeyConfigs.journeyId],
        set: { enabled: body.enabled, updatedAt: new Date() },
      })
      .returning();

    if (!config) {
      throw new Error("Failed to upsert journey config");
    }

    return c.json(
      {
        journey: {
          id: meta.id,
          name: meta.name,
          enabled: config.enabled,
          updatedAt: config.updatedAt.toISOString(),
        },
      },
      200,
    );
  })
  .openapi(listStatesRoute, async (c) => {
    const { db, registry } = c.get("container");
    const { id } = c.req.valid("param");
    const { limit, offset, status, userId } = c.req.valid("query");

    if (!registry.has(id)) {
      return c.json({ error: "Journey not found" }, 404);
    }

    const conditions = [
      eq(journeyStates.journeyId, id),
      isNull(journeyStates.deletedAt),
    ];
    if (status) {
      conditions.push(eq(journeyStates.status, status));
    }
    if (userId) {
      conditions.push(eq(journeyStates.userId, userId));
    }

    const where = and(...conditions);

    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(journeyStates)
        .where(where)
        .orderBy(desc(journeyStates.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(journeyStates).where(where),
    ]);

    return c.json(
      {
        states: rows.map(serializeState),
        total: totalRows[0]?.count ?? 0,
        limit,
        offset,
      },
      200,
    );
  })
  .openapi(getStateRoute, async (c) => {
    const { db } = c.get("container");
    const { id, stateId } = c.req.valid("param");

    const state = await fetchState(db, id, stateId);
    if (!state) {
      return c.json({ error: "State not found" }, 404);
    }

    const logs = await db
      .select()
      .from(journeyLogs)
      .where(eq(journeyLogs.journeyStateId, stateId))
      .orderBy(journeyLogs.createdAt);

    return c.json(
      {
        state: serializeState(state),
        logs: logs.map(serializeLog),
      },
      200,
    );
  })
  .openapi(cancelStateRoute, async (c) => {
    const { db, hatchet } = c.get("container");
    const { id, stateId } = c.req.valid("param");

    const state = await fetchState(db, id, stateId);
    if (!state) {
      return c.json({ error: "State not found" }, 404);
    }

    if (!["active", "waiting"].includes(state.status)) {
      return c.json(
        {
          error: `Cannot cancel journey in '${state.status}' status`,
        },
        409,
      );
    }

    const exitedAt = new Date();

    await db
      .update(journeyStates)
      .set({
        status: "exited",
        exitedAt,
        updatedAt: exitedAt,
      })
      .where(eq(journeyStates.id, stateId));

    let hatchetCancelled = false;
    if (state.hatchetRunId) {
      try {
        await hatchet.runs.cancel({ ids: [state.hatchetRunId] });
        hatchetCancelled = true;
      } catch {
        // Best-effort: run may have already finished
      }
    }

    return c.json(
      {
        state: {
          id: stateId,
          status: "exited" as const,
          exitedAt: exitedAt.toISOString(),
        },
        hatchetCancelled,
      },
      200,
    );
  })
  .openapi(enrollRoute, async (c) => {
    const { db, registry, hatchet, logger } = c.get("container");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const meta = registry.get(id);
    if (!meta) {
      return c.json({ error: "Journey not found" }, 404);
    }

    await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event: meta.trigger.event,
        userId: body.userId,
        userEmail: body.userEmail,
        // Public request field stays `properties` (decision #14); it maps to
        // the event-property bag of the IngestEvent (D2 split).
        eventProperties: body.properties ?? {},
      },
    });

    return c.json(
      {
        enrolled: true,
        event: meta.trigger.event,
        userId: body.userId,
      },
      202,
    );
  })
  .openapi(templatesRoute, async (c) => {
    const { db, registry } = c.get("container");
    const { id } = c.req.valid("param");

    if (!registry.has(id)) {
      return c.json({ error: "Journey not found" }, 404);
    }

    // Observed-from-sends: the templates a journey actually sent, routed via
    // emailSends.journeyStateId → journeyStates.journeyId (no journeyId on
    // emailSends). NULL templateKeys (ad-hoc HTML sends) are excluded.
    const rows = await db
      .select({
        templateKey: emailSends.templateKey,
        sent: sql<number>`count(*) filter (where ${emailSends.sentAt} is not null)`,
        opened: sql<number>`count(*) filter (where ${emailSends.openedAt} is not null)`,
        clicked: sql<number>`count(*) filter (where ${emailSends.clickedAt} is not null)`,
        lastSentAt: sql<string | null>`max(${emailSends.sentAt})`,
      })
      .from(emailSends)
      .innerJoin(journeyStates, eq(emailSends.journeyStateId, journeyStates.id))
      .where(
        and(
          eq(journeyStates.journeyId, id),
          isNull(journeyStates.deletedAt),
          isNotNull(emailSends.templateKey),
        ),
      )
      .groupBy(emailSends.templateKey)
      .orderBy(desc(sql`count(*)`));

    return c.json(
      {
        templates: rows.map((r) => ({
          // isNotNull guarantees a string at runtime; satisfy the type too.
          templateKey: r.templateKey ?? "",
          sent: Number(r.sent),
          opened: Number(r.opened),
          clicked: Number(r.clicked),
          lastSentAt: r.lastSentAt
            ? new Date(r.lastSentAt).toISOString()
            : null,
        })),
      },
      200,
    );
  });
