import { type JourneyGraph, journeyGraphSchema } from "@hogsend/core";
import {
  type Database,
  emailSends,
  journeyConfigs,
  journeyLogs,
  journeyStates,
} from "@hogsend/db";
import { getTemplateNames } from "@hogsend/email";
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
import { buildJourneyGraph } from "../../journeys/graph/build-graph.js";
import {
  getRuntimeSpecMeta,
  getRuntimeSpecStore,
} from "../../journeys/spec/runtime-spec-store.js";
import { getJourneySpec } from "../../journeys/spec/spec-registry.js";
import { specToGraph } from "../../journeys/spec/spec-to-graph.js";
import { ingestEvent } from "../../lib/ingestion.js";

/**
 * Per-process cache of the built {@link JourneyGraph}. A journey's `runSource`
 * (and its `meta`) is static for the life of the process, so the AST extraction
 * only needs to run once per journey id. Keyed by journey id.
 */
const journeyGraphCache = new Map<string, JourneyGraph>();

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

const graphRoute = createRoute({
  method: "get",
  path: "/{id}/graph",
  tags: ["Admin — Journeys"],
  summary: "Journey visual workflow graph with per-node live/failed metrics",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            graph: journeyGraphSchema,
            metrics: z.object({
              enrolled: z.number(),
              terminals: z.object({
                completed: z.number(),
                failed: z.number(),
                exited: z.number(),
              }),
              // Keyed by graph node id. `live` = people currently sitting at
              // that node (status active/waiting), `failed` = instances whose
              // last durable node was this one when they failed. `templateKey`
              // is the resolved email template key for `send` nodes (for the
              // Studio side-panel preview) — present only when resolvable.
              // `templatePath` is that template component's source file (for the
              // Studio "open in editor" affordance) — present only in dev where
              // the registry carries source paths.
              nodes: z.record(
                z.string(),
                z.object({
                  live: z.number(),
                  failed: z.number(),
                  templateKey: z.string().optional(),
                  templatePath: z.string().optional(),
                }),
              ),
            }),
          }),
        },
      },
      description: "Journey graph (IR) plus retroactive per-node metrics",
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

    // Boot-time journeys PLUS runtime-added DB specs (created via the admin
    // API after boot — in the runtime store, not the registry). Store is
    // refreshed lazily by ingest; refresh here too so a just-created journey
    // lists immediately even on a quiet instance.
    const { db: storeDb } = c.get("container");
    await getRuntimeSpecStore()
      .refreshIfStale(storeDb, Date.now(), 5000)
      .catch(() => {});
    const registered = registry.getAll();
    const runtimeOnly = getRuntimeSpecStore()
      .all()
      .filter((s) => !registry.has(s.spec.id))
      .map((s) => ({ id: s.spec.id, ...s.spec.meta }));
    const allJourneys = [...registered, ...runtimeOnly];

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

    const meta = registry.get(id) ?? getRuntimeSpecMeta(id);
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

    const meta = registry.get(id) ?? getRuntimeSpecMeta(id);
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

    if (!registry.has(id) && !getRuntimeSpecMeta(id)) {
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

    const meta = registry.get(id) ?? getRuntimeSpecMeta(id);
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
        // Studio "Enroll" action (admin manual enrollment).
        source: "studio",
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

    if (!registry.has(id) && !getRuntimeSpecMeta(id)) {
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
  })
  .openapi(graphRoute, async (c) => {
    const { db, registry, journeySources, journeySourceLocations, templates } =
      c.get("container");
    const { id } = c.req.valid("param");

    const meta = registry.get(id) ?? getRuntimeSpecMeta(id);
    if (!meta) {
      return c.json({ error: "Journey not found" }, 404);
    }

    // Build (and cache) the IR — runSource is static per process, so a repeat
    // request re-uses the parse rather than re-walking the AST. The captured
    // call-site (also static per process) is baked into the cached graph.
    // Runtime-added/edited DB specs render fresh each request (their spec can
    // change between requests via the admin API — the per-process cache below
    // is only correct for boot-static journeys, whose sources never change).
    const runtimeSpec = getRuntimeSpecStore().getById(id)?.spec;
    let graph = runtimeSpec
      ? specToGraph(runtimeSpec)
      : journeyGraphCache.get(id);
    if (!graph) {
      // Spec journeys (JSON/YAML-defined) render straight from their spec —
      // full fidelity, no parsing, never degraded. Their `runSource` is the
      // interpreter's own source, which the AST walk must never see.
      const spec = getJourneySpec(id);
      graph = spec
        ? specToGraph(spec)
        : buildJourneyGraph({ runSource: journeySources.get(id), meta });
      const source = journeySourceLocations.get(id);
      if (source) graph.source = source;
      journeyGraphCache.set(id, graph);
    }

    // One grouped query gives us BOTH per-node live/failed AND the status
    // totals for enrolled + terminals (sum across all node ids per status).
    const perNode = await db
      .select({
        nodeId: journeyStates.currentNodeId,
        status: journeyStates.status,
        count: count(),
      })
      .from(journeyStates)
      .where(
        and(eq(journeyStates.journeyId, id), isNull(journeyStates.deletedAt)),
      )
      .groupBy(journeyStates.currentNodeId, journeyStates.status);

    // Default every graph node to zero, then overlay the observed counts. Only
    // start/sleep/wait/checkpoint node ids ever appear as `current_node_id`;
    // instantaneous nodes (send/trigger/capture/connector) correctly stay 0.
    const nodeMetrics: Record<
      string,
      {
        live: number;
        failed: number;
        templateKey?: string;
        templatePath?: string;
      }
    > = {};
    for (const node of graph.nodes) {
      nodeMetrics[node.id] = { live: 0, failed: 0 };
    }

    const statusTotals: Record<string, number> = {};
    for (const row of perNode) {
      const n = Number(row.count);
      statusTotals[row.status] = (statusTotals[row.status] ?? 0) + n;
      const nodeId = row.nodeId;
      if (!nodeId) continue;
      const entry = nodeMetrics[nodeId] ?? { live: 0, failed: 0 };
      if (row.status === "active" || row.status === "waiting") {
        entry.live += n;
      } else if (row.status === "failed") {
        entry.failed += n;
      }
      nodeMetrics[nodeId] = entry;
    }

    const enrolled = Object.values(statusTotals).reduce((a, b) => a + b, 0);

    // Resolve a real email template key per `send` node for the Studio
    // side-panel preview. The preview only needs the registry key (it renders
    // the React Email component — no send data), so STATIC resolution is the
    // primary mechanism and a never-sent journey still previews. Priority:
    //   (1) literal `meta.template` — already the registry key.
    //   (2) STATIC exact: the node's `subtitle` is the Templates const name for
    //       member-expr sends (`FEEDBACK_NPS_SURVEY`); lowercase + `_`→`-`
    //       (`feedback-nps-survey`) and use it IFF that key is in the registry.
    //   (2b) STATIC prefix: else the single LONGEST registry key that is a
    //        segment-prefix of the kebab'd const name (`activation-nudge-series`
    //        → `activation-nudge`). Only when that longest prefix is unique — a
    //        wrong preview is worse than none, so an ambiguous tie stays unresolved.
    //   (3) journey_logs rows (action='send') whose `to_node_id` is this send
    //       node's site id (`send:<site>`), reading `detail.template` — site-
    //       keyed, so two sends of one template on different branches stay
    //       distinct.
    //   (4) observed email_sends template keys (join via journeyStateId) mapped
    //       onto still-unresolved send nodes in source order.
    // The resolved key rides on `metrics.nodes[id].templateKey` (NOT the cached
    // graph, which stays immutable + DB-independent).
    const sendNodes = graph.nodes.filter((node) => node.type === "send");
    if (sendNodes.length > 0) {
      const sendIds = new Set(sendNodes.map((node) => node.id));
      const setTemplate = (nodeId: string, key: string) => {
        const entry = nodeMetrics[nodeId] ?? { live: 0, failed: 0 };
        if (!entry.templateKey) {
          entry.templateKey = key;
          // Best-effort source path (dev-only; see `withSources`) for the
          // Studio "open template in editor" affordance.
          const def = (templates as Record<string, { sourcePath?: string }>)[
            key
          ];
          if (def?.sourcePath) entry.templatePath = def.sourcePath;
        }
        nodeMetrics[nodeId] = entry;
      };

      // (1) literal templates already carry the real key in the IR.
      for (const node of sendNodes) {
        if (node.meta?.template) setTemplate(node.id, node.meta.template);
      }

      // (2/2b) static const-name → registry key (no runtime data needed):
      // exact kebab match, else the unique longest segment-prefix key.
      const registryKeys = getTemplateNames(templates) as string[];
      const registeredKeys = new Set<string>(registryKeys);
      const resolveStatic = (constName: string): string | undefined => {
        const kebab = constName.toLowerCase().replace(/_/g, "-");
        if (registeredKeys.has(kebab)) return kebab;
        // Longest registry key that is a segment-prefix of the kebab'd name.
        let best: string | undefined;
        let bestLen = -1;
        let ambiguous = false;
        for (const key of registryKeys) {
          if (!kebab.startsWith(`${key}-`)) continue;
          if (key.length > bestLen) {
            best = key;
            bestLen = key.length;
            ambiguous = false;
          } else if (key.length === bestLen) {
            ambiguous = true;
          }
        }
        return ambiguous ? undefined : best;
      };
      for (const node of sendNodes) {
        if (nodeMetrics[node.id]?.templateKey || !node.subtitle) continue;
        const key = resolveStatic(node.subtitle);
        if (key) setTemplate(node.id, key);
      }

      // (3) journey_logs site-join (only if something is still unresolved).
      if (sendNodes.some((node) => !nodeMetrics[node.id]?.templateKey)) {
        const logRows = await db
          .select({
            toNodeId: journeyLogs.toNodeId,
            template: sql<string | null>`${journeyLogs.detail} ->> 'template'`,
          })
          .from(journeyLogs)
          .innerJoin(
            journeyStates,
            eq(journeyLogs.journeyStateId, journeyStates.id),
          )
          .where(
            and(
              eq(journeyStates.journeyId, id),
              isNull(journeyStates.deletedAt),
              eq(journeyLogs.action, "send"),
            ),
          );
        for (const row of logRows) {
          const nodeId = row.toNodeId;
          if (!nodeId || !row.template || !sendIds.has(nodeId)) continue;
          setTemplate(nodeId, row.template);
        }
      }

      // (4) email_sends fallback, mapped in source order.
      const unresolved = sendNodes.filter(
        (node) => !nodeMetrics[node.id]?.templateKey,
      );
      if (unresolved.length > 0) {
        const observedRows = await db
          .select({
            templateKey: emailSends.templateKey,
            firstSeen: sql<string | null>`min(${emailSends.createdAt})`,
          })
          .from(emailSends)
          .innerJoin(
            journeyStates,
            eq(emailSends.journeyStateId, journeyStates.id),
          )
          .where(
            and(
              eq(journeyStates.journeyId, id),
              isNull(journeyStates.deletedAt),
              isNotNull(emailSends.templateKey),
            ),
          )
          .groupBy(emailSends.templateKey);
        const observed = observedRows
          .filter((r): r is { templateKey: string; firstSeen: string | null } =>
            Boolean(r.templateKey),
          )
          .sort((a, b) => (a.firstSeen ?? "").localeCompare(b.firstSeen ?? ""))
          .map((r) => r.templateKey);
        unresolved.forEach((node, i) => {
          const key = observed[i];
          if (key) setTemplate(node.id, key);
        });
      }
    }

    return c.json(
      {
        graph,
        metrics: {
          enrolled,
          terminals: {
            completed: statusTotals.completed ?? 0,
            failed: statusTotals.failed ?? 0,
            exited: statusTotals.exited ?? 0,
          },
          nodes: nodeMetrics,
        },
      },
      200,
    );
  });
