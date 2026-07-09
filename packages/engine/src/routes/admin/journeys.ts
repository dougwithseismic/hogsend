import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type JourneyGraph, metaToGraph, renderMermaid } from "@hogsend/core";
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

/**
 * Read the build-time journey-graph manifest emitted by
 * `hogsend journeys graph --all`. Cached by file mtime so regenerating the
 * manifest takes effect without a process restart. Returns the map of
 * journeyId -> rich graph, or null if no manifest is present (the route then
 * falls back to the metadata skeleton).
 *
 * Failures (missing file, transient read error, corrupt JSON) are NOT cached:
 * a one-off I/O hiccup mustn't permanently suppress the graph. The next
 * request re-reads. On a missing file we skip the stat entirely (the common
 * "no manifest generated yet" case).
 */
interface GraphManifest {
  map: Map<string, JourneyGraph>;
  /** ISO timestamp the manifest was generated at (null for old manifests). */
  generatedAt: string | null;
}
let manifestCache: ({ mtimeMs: number } & GraphManifest) | undefined;
function loadGraphManifest(): GraphManifest | null {
  const manifestPath =
    process.env.HOGSEND_GRAPH_MANIFEST ??
    resolve(process.cwd(), ".hogsend", "journeys.graph.json");
  try {
    if (!existsSync(manifestPath)) return null;
    const stat = statSync(manifestPath);
    // Fresh cache hit — same mtime, return the parsed manifest.
    if (manifestCache && manifestCache.mtimeMs === stat.mtimeMs) {
      return manifestCache;
    }
    const raw = readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as {
      generatedAt?: string;
      journeys?: JourneyGraph[];
    };
    const map = new Map<string, JourneyGraph>();
    for (const g of parsed.journeys ?? []) map.set(g.journeyId, g);
    manifestCache = {
      mtimeMs: stat.mtimeMs,
      map,
      generatedAt: parsed.generatedAt ?? null,
    };
    return manifestCache;
  } catch (err) {
    // Do NOT cache the failure — a transient error or a corrupt file being
    // repaired should recover on the next request, not require a restart.
    console.warn(
      "[hogsend] journey graph manifest unreadable:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Detect whether a rich graph's authored source has changed since the manifest
 * was generated. Only possible when the source `.ts` is present on disk (dev;
 * prod images ship without source — the check quietly reports fresh there,
 * which is correct because the image's manifest was generated from the same
 * commit at build time). Returns a human reason, or null when not stale.
 */
function detectStale(graph: JourneyGraph): string | null {
  if (!graph.sourceFile || !graph.sourceHash) return null;
  try {
    const abs = resolve(process.cwd(), graph.sourceFile);
    if (!existsSync(abs)) return null;
    const hash = createHash("sha256")
      .update(readFileSync(abs, "utf8"))
      .digest("hex");
    if (hash !== graph.sourceHash) {
      return `${graph.sourceFile} changed since this graph was generated — rerun \`hogsend journeys graph --all\``;
    }
    return null;
  } catch {
    return null;
  }
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

// Schemas mirroring @hogsend/core's JourneyGraph shape, so the OpenAPI spec
// documents the real structure (not an opaque record). The route returns a
// JourneyGraph; these make it introspectable for clients.
const graphNodeSchema = z.object({
  id: z.string(),
  kind: z.string(),
  label: z.string(),
  detail: z.string().optional(),
  // Email nodes: authored ref (`Templates.X`) + resolved key (`churn-…`).
  templateRef: z.string().optional(),
  templateKey: z.string().optional(),
  sourceLine: z.number().optional(),
  countKey: z.string().optional(),
});
const graphEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
  kind: z.string().optional(),
});
const graphSchema = z.object({
  journeyId: z.string(),
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
  sourceLevel: z.enum(["rich", "metadata"]),
  disclaimer: z.string().optional(),
  sourceFile: z.string().optional(),
  sourceHash: z.string().optional(),
});

const graphRoute = createRoute({
  method: "get",
  path: "/{id}/graph",
  tags: ["Admin — Journeys"],
  summary: "Get journey control-flow graph (Mermaid + structured)",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            mermaid: z.string(),
            graph: graphSchema,
            sourceLevel: z.enum(["rich", "metadata"]),
            // When the rich graph came from the build-time manifest: its
            // generation timestamp, and whether the authored source has
            // drifted since (checkable only where source is on disk).
            generatedAt: z.string().nullable(),
            stale: z.boolean(),
            staleReason: z.string().nullable(),
            counts: z.object({
              perNode: z.record(z.string(), z.number()),
              funnel: z.object({
                enrolled: z.number(),
                emailSent: z.number(),
                emailOpened: z.number(),
                emailClicked: z.number(),
                completed: z.number(),
                failed: z.number(),
                exited: z.number(),
              }),
            }),
          }),
        },
      },
      description:
        "Journey control-flow graph as Mermaid text + structured nodes/edges, with live counts overlaid where available.",
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
      // Filter by currentNodeId — powers the Studio flow canvas's "who is
      // parked at this node" side panel. Matches the graph node's countKey.
      node: z.string().optional(),
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
    const { limit, offset, status, userId, node } = c.req.valid("query");

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
    if (node) {
      conditions.push(eq(journeyStates.currentNodeId, node));
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
  })
  // NOTE: registered AFTER getRoute `/{id}`, but Hono matches `/{id}/graph`
  // by static-suffix specificity regardless of registration order — do not
  // reorder these without confirming the graph path still resolves.
  .openapi(graphRoute, async (c) => {
    const { db, registry } = c.get("container");
    const { id } = c.req.valid("param");

    const meta = registry.get(id);
    if (!meta) {
      return c.json({ error: "Journey not found" }, 404);
    }

    // Resolve the graph: prefer the build-time rich manifest; fall back to the
    // metadata skeleton (trigger -> body placeholder -> exits -> end).
    const manifest = loadGraphManifest();
    const rich = manifest?.map.get(id);
    const graph: JourneyGraph = rich ?? metaToGraph(meta);
    const staleReason = rich ? detectStale(rich) : null;

    // Live counts. The funnel endpoint returns flat aggregates; we also group
    // Per-node live counts: group `journeyStates` by `currentNodeId` so nodes
    // can carry counts. The join contract (mirrored by the CLI extractor's
    // `countKey`) is:
    //   - checkpoint label (e.g. "scored-9")  — from `ctx.checkpoint("…")`
    //   - wait label OR `wait-event:<event>`  — from `ctx.waitForEvent`
    //   - literal "start"                      — set at journey creation
    // The CLI extractor sets each node's `countKey` to match these exactly;
    // the Studio joins `perNode[countKey]`. Nodes without a countKey (sleeps,
    // emails) show no badge by design.
    const [statusCounts, nodeCounts, emailAgg] = await Promise.all([
      db
        .select({ status: journeyStates.status, count: count() })
        .from(journeyStates)
        .where(
          and(eq(journeyStates.journeyId, id), isNull(journeyStates.deletedAt)),
        )
        .groupBy(journeyStates.status),
      db
        .select({ node: journeyStates.currentNodeId, count: count() })
        .from(journeyStates)
        .where(
          and(
            eq(journeyStates.journeyId, id),
            isNull(journeyStates.deletedAt),
            sql`${journeyStates.currentNodeId} <> ''`,
          ),
        )
        .groupBy(journeyStates.currentNodeId),
      db
        .select({
          sent: sql<number>`count(*) filter (where ${emailSends.sentAt} is not null)`,
          opened: sql<number>`count(*) filter (where ${emailSends.openedAt} is not null)`,
          clicked: sql<number>`count(*) filter (where ${emailSends.clickedAt} is not null)`,
        })
        .from(emailSends)
        .innerJoin(
          journeyStates,
          eq(emailSends.journeyStateId, journeyStates.id),
        )
        .where(
          and(eq(journeyStates.journeyId, id), isNull(journeyStates.deletedAt)),
        ),
    ]);

    const statusMap: Record<string, number> = {};
    let enrolled = 0;
    for (const row of statusCounts) {
      statusMap[row.status] = row.count;
      enrolled += row.count;
    }
    const perNode: Record<string, number> = {};
    for (const row of nodeCounts) {
      perNode[row.node] = Number(row.count);
    }
    const funnel = {
      enrolled,
      emailSent: Number(emailAgg[0]?.sent ?? 0),
      emailOpened: Number(emailAgg[0]?.opened ?? 0),
      emailClicked: Number(emailAgg[0]?.clicked ?? 0),
      completed: statusMap.completed ?? 0,
      failed: statusMap.failed ?? 0,
      exited: statusMap.exited ?? 0,
    };

    return c.json(
      {
        mermaid: renderMermaid(graph),
        graph,
        sourceLevel: graph.sourceLevel,
        generatedAt: rich ? (manifest?.generatedAt ?? null) : null,
        stale: staleReason !== null,
        staleReason,
        counts: { perNode, funnel },
      },
      200,
    );
  });
