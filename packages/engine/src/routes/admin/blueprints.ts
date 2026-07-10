/**
 * Admin routes for Journey Blueprints (spec §9) — the HTTP surface of the
 * blueprint service layer (`lib/blueprints.ts`), which owns the CRUD +
 * lifecycle logic AND the save-time sandbox boundary (spec §8): a graph is
 * NEVER written to `journey_blueprints` without passing
 * `validateBlueprintGraphForSave`. The agent tools
 * (`mcp/blueprint-tools.ts`, spec §9) wrap the SAME service functions — no
 * parallel auth or storage path; this file only maps service results to
 * HTTP statuses.
 *
 * Auth/rate-limit/audit come from the parent `adminRouter` middleware stack.
 *
 * Result → status mapping (uniform across handlers):
 *  - `invalid_graph` → 422 with the structured `BlueprintValidationIssue[]`
 *    verbatim (never a caught exception message)
 *  - `not_found` → 404, `conflict`/`promoted`/`in_flight` → 409
 *
 * A graph-changing update is REJECTED (`in_flight` → 409) while the
 * blueprint has any active/waiting `journeyStates` rows — Hatchet's durable
 * sleep/wait primitives are matched positionally on replay, so changing the
 * node sequence out from under a suspended run can desync its replay
 * journal. Code journeys don't have this hazard (their `run()` is immutable
 * compiled code); a blueprint's graph is a mutable row, so this is an
 * explicit gate, enforced in the service layer (`lib/blueprints.ts`), not
 * an implicit guarantee. Wait for enrollments to drain (or disable and let
 * them finish) before editing a live graph.
 */
import { type JourneyGraph, journeyGraphSchema } from "@hogsend/core";
import { journeyBlueprints, journeyStates } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import {
  blueprintCreateBaseSchema,
  blueprintGraphInputSchema,
  blueprintPatchFieldsSchema,
  blueprintSourceSchema,
  blueprintStatusSchema,
  createBlueprint,
  disableBlueprint,
  enableBlueprint,
  findBlueprintRow,
  serializeBlueprint,
  serializedBlueprintSchema,
  updateBlueprint,
  validateBlueprintGraphForSave,
} from "../../lib/blueprints.js";
import { errorSchema, paginationQuerySchema } from "../../lib/schemas.js";
import { serializeState, stateSchema } from "./journeys.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const createBodySchema = blueprintCreateBaseSchema.extend({
  source: blueprintSourceSchema,
});

// Partial update (shared field shapes from the service layer). The routes add
// the "at least one field" refinement on the whole body.
const patchBodySchema = blueprintPatchFieldsSchema.refine(
  (body) => Object.values(body).some((v) => v !== undefined),
  { message: "PATCH body must set at least one field" },
);

const validationIssueSchema = z.object({
  nodeId: z.string().optional(),
  edgeId: z.string().optional(),
  path: z.array(z.union([z.string(), z.number()])),
  code: z.string(),
  message: z.string(),
});

/** 422 body for any write rejected by graph validation. */
const invalidGraphSchema = z.object({
  error: z.string(),
  issues: z.array(validationIssueSchema),
});

/** The dry-run validate report — 200 either way (a failed validation is a
 * successful validation CALL; this is the agent's iterate-in-a-loop surface). */
const validationReportSchema = z.object({
  valid: z.boolean(),
  issues: z.array(validationIssueSchema),
});

const countsSchema = z.object({
  active: z.number(),
  waiting: z.number(),
  completed: z.number(),
  failed: z.number(),
  exited: z.number(),
});

// Row serialization is FLAT (column names verbatim: triggerEvent,
// triggerWhere, …) so a GET → edit → PATCH loop round-trips 1:1 with the
// write bodies above — shape + serializer live in the service layer,
// shared with the agent tools.
const blueprintSchema = serializedBlueprintSchema;

// List rows omit the graph blob (fetch one / the graph route carry it).
const blueprintListItemSchema = blueprintSchema
  .omit({ graph: true })
  .extend({ counts: countsSchema });

const blueprintDetailSchema = blueprintSchema.extend({
  counts: countsSchema,
  recentStates: z.array(stateSchema),
});

const emptyCounts = {
  active: 0,
  waiting: 0,
  completed: 0,
  failed: 0,
  exited: 0,
};

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listRouteDef = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Blueprints"],
  summary: "List journey blueprints",
  request: {
    query: paginationQuerySchema.extend({
      status: blueprintStatusSchema.optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            blueprints: z.array(blueprintListItemSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
      description: "Paginated blueprint list with per-blueprint state counts",
    },
  },
});

const createRouteDef = createRoute({
  method: "post",
  path: "/",
  tags: ["Admin — Blueprints"],
  summary: "Create a journey blueprint",
  description:
    "The blueprint id is the graph's `journeyId`. The graph is validated " +
    "(`validateBlueprintGraph` + template/connector registry checks) before " +
    "anything is written — an invalid graph is never saved. Defaults to " +
    '`status: "draft"`; pass `status: "enabled"` to go live immediately ' +
    "(spec §10 — no forced staging step).",
  request: {
    body: {
      content: { "application/json": { schema: createBodySchema } },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: z.object({ blueprint: blueprintSchema }),
        },
      },
      description: "Blueprint created",
    },
    409: {
      content: { "application/json": { schema: errorSchema } },
      description:
        "Blueprint id already exists, or collides with a registered code journey",
    },
    422: {
      content: { "application/json": { schema: invalidGraphSchema } },
      description: "Graph failed validation — structured issues included",
    },
  },
});

const validateRouteDef = createRoute({
  method: "post",
  path: "/validate",
  tags: ["Admin — Blueprints"],
  summary: "Validate a blueprint graph (dry-run, no write, no id required)",
  description:
    "The iterate-in-a-loop call for an authoring agent: validates an " +
    "arbitrary graph body through the exact checks create/PATCH/enable run " +
    "(schema + structure + template/connector registries) and returns the " +
    "structured issue list. Always 200 — `valid: false` is a successful " +
    "validation call, not an error.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ graph: blueprintGraphInputSchema }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: validationReportSchema } },
      description: "Validation report",
    },
  },
});

const getRouteDef = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Admin — Blueprints"],
  summary: "Get blueprint detail",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ blueprint: blueprintDetailSchema }),
        },
      },
      description: "Blueprint detail with counts and recent states",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Blueprint not found",
    },
  },
});

const patchRouteDef = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Admin — Blueprints"],
  summary: "Update a journey blueprint",
  description:
    "Partial update. A `graph` change is re-validated the same way create " +
    "is and bumps `version` by 1 — but is rejected (409) while the " +
    "blueprint has any active/waiting enrollment, since a graph edit can " +
    "desync Hatchet's replay journal for a run suspended mid-graph. " +
    "Metadata-only edits do not bump and are never blocked. Status " +
    "transitions go through /enable and /disable, not PATCH.",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { "application/json": { schema: patchBodySchema } },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ blueprint: blueprintSchema }),
        },
      },
      description: "Blueprint updated",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Blueprint not found",
    },
    409: {
      content: { "application/json": { schema: errorSchema } },
      description:
        "Graph change rejected — the blueprint has active/waiting enrollments",
    },
    422: {
      content: { "application/json": { schema: invalidGraphSchema } },
      description:
        "Graph failed validation, or its journeyId does not match the blueprint id",
    },
  },
});

const validateByIdRouteDef = createRoute({
  method: "post",
  path: "/{id}/validate",
  tags: ["Admin — Blueprints"],
  summary: "Re-validate a saved blueprint's stored graph (dry-run, no write)",
  description:
    "Runs the STORED graph through the current validation + registry checks. " +
    "Useful after registry drift (e.g. a template was unregistered since " +
    "save). To validate a graph that is not saved yet, use POST /validate.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: validationReportSchema } },
      description: "Validation report for the stored graph",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Blueprint not found",
    },
  },
});

const enableRouteDef = createRoute({
  method: "post",
  path: "/{id}/enable",
  tags: ["Admin — Blueprints"],
  summary: "Enable a blueprint (new events start enrolling)",
  description:
    "Re-validates the stored graph against the CURRENT registries first — " +
    "a blueprint whose template/connector vanished since save cannot go " +
    "live. Idempotent when already enabled.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ blueprint: blueprintSchema }),
        },
      },
      description: "Blueprint enabled",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Blueprint not found",
    },
    409: {
      content: { "application/json": { schema: errorSchema } },
      description:
        "Blueprint was promoted to code — the code journey is the source of truth",
    },
    422: {
      content: { "application/json": { schema: invalidGraphSchema } },
      description: "Stored graph no longer passes validation",
    },
  },
});

const disableRouteDef = createRoute({
  method: "post",
  path: "/{id}/disable",
  tags: ["Admin — Blueprints"],
  summary: "Disable a blueprint (stops new enrollments)",
  description:
    "New enrollments stop on the next event; in-flight runs keep going " +
    "(spec §12 — matches how code journeys behave when enabled flips off). " +
    "Idempotent when already disabled.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ blueprint: blueprintSchema }),
        },
      },
      description: "Blueprint disabled",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Blueprint not found",
    },
  },
});

// Byte-identical response shape to GET /v1/admin/journeys/{id}/graph — the
// SAME Studio flow-view component renders either without modification
// (spec §3/§9). `templateKey` needs no resolution cascade here: a blueprint
// send node always carries the literal registry key.
const graphRouteDef = createRoute({
  method: "get",
  path: "/{id}/graph",
  tags: ["Admin — Blueprints"],
  summary: "Blueprint visual workflow graph with per-node live/failed metrics",
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
      description: "Blueprint graph (IR) plus retroactive per-node metrics",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Blueprint not found",
    },
  },
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// Registered statement-per-route rather than as one `.openapi()` chain: the
// chain form accumulates every route's request/response schema into the
// router's generic type, and this router is type-checked inside every
// consumer's DTS build (tsup noExternal) — nine routes of accumulated zod
// generics OOM the DTS worker. Statement form discards each call's return
// type while keeping per-handler type safety. The router is mounted
// internally by the adminRouter, never consumed via hono/client, so no
// client-side type info is lost.
export const blueprintsRouter = new OpenAPIHono<AppEnv>();

blueprintsRouter.openapi(listRouteDef, async (c) => {
  const { db } = c.get("container");
  const { limit, offset, status } = c.req.valid("query");

  const where = status ? eq(journeyBlueprints.status, status) : undefined;

  const [rows, totalRows] = await Promise.all([
    db
      .select()
      .from(journeyBlueprints)
      .where(where)
      .orderBy(desc(journeyBlueprints.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: count() }).from(journeyBlueprints).where(where),
  ]);

  const ids = rows.map((row) => row.id);
  const statusCounts =
    ids.length > 0
      ? await db
          .select({
            journeyId: journeyStates.journeyId,
            status: journeyStates.status,
            count: count(),
          })
          .from(journeyStates)
          .where(
            and(
              inArray(journeyStates.journeyId, ids),
              isNull(journeyStates.deletedAt),
            ),
          )
          .groupBy(journeyStates.journeyId, journeyStates.status)
      : [];

  const countsMap = new Map<string, typeof emptyCounts>();
  for (const row of statusCounts) {
    const existing = countsMap.get(row.journeyId) ?? { ...emptyCounts };
    existing[row.status as keyof typeof emptyCounts] = row.count;
    countsMap.set(row.journeyId, existing);
  }

  return c.json(
    {
      blueprints: rows.map((row) => {
        const { graph: _graph, ...rest } = serializeBlueprint(row);
        return { ...rest, counts: countsMap.get(row.id) ?? { ...emptyCounts } };
      }),
      total: totalRows[0]?.count ?? 0,
      limit,
      offset,
    },
    200,
  );
});

blueprintsRouter.openapi(createRouteDef, async (c) => {
  const container = c.get("container");
  const body = c.req.valid("json");

  const result = await createBlueprint({ container, input: body });
  if (!result.ok) {
    if (result.code === "invalid_graph") {
      return c.json({ error: result.error, issues: result.issues }, 422);
    }
    return c.json({ error: result.error }, 409);
  }
  return c.json({ blueprint: serializeBlueprint(result.blueprint) }, 201);
});

blueprintsRouter.openapi(validateRouteDef, async (c) => {
  const container = c.get("container");
  const { graph } = c.req.valid("json");

  const result = validateBlueprintGraphForSave(graph, container);
  return c.json(
    result.valid
      ? { valid: true, issues: [] }
      : { valid: false, issues: result.issues },
    200,
  );
});

blueprintsRouter.openapi(getRouteDef, async (c) => {
  const { db } = c.get("container");
  const { id } = c.req.valid("param");

  const row = await findBlueprintRow({ db, id });
  if (!row) {
    return c.json({ error: "Blueprint not found" }, 404);
  }

  const [statusCounts, recentRows] = await Promise.all([
    db
      .select({ status: journeyStates.status, count: count() })
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

  const counts = { ...emptyCounts };
  for (const statusRow of statusCounts) {
    counts[statusRow.status as keyof typeof emptyCounts] = statusRow.count;
  }

  return c.json(
    {
      blueprint: {
        ...serializeBlueprint(row),
        counts,
        recentStates: recentRows.map(serializeState),
      },
    },
    200,
  );
});

blueprintsRouter.openapi(patchRouteDef, async (c) => {
  const container = c.get("container");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const result = await updateBlueprint({ container, id, patch: body });
  if (!result.ok) {
    if (result.code === "invalid_graph") {
      return c.json({ error: result.error, issues: result.issues }, 422);
    }
    if (result.code === "in_flight") {
      return c.json({ error: result.error }, 409);
    }
    return c.json({ error: result.error }, 404);
  }
  return c.json({ blueprint: serializeBlueprint(result.blueprint) }, 200);
});

blueprintsRouter.openapi(validateByIdRouteDef, async (c) => {
  const container = c.get("container");
  const { id } = c.req.valid("param");

  const row = await findBlueprintRow({ db: container.db, id });
  if (!row) {
    return c.json({ error: "Blueprint not found" }, 404);
  }

  const result = validateBlueprintGraphForSave(row.graph, container);
  return c.json(
    result.valid
      ? { valid: true, issues: [] }
      : { valid: false, issues: result.issues },
    200,
  );
});

blueprintsRouter.openapi(enableRouteDef, async (c) => {
  const container = c.get("container");
  const { id } = c.req.valid("param");

  const result = await enableBlueprint({ container, id });
  if (!result.ok) {
    if (result.code === "invalid_graph") {
      return c.json({ error: result.error, issues: result.issues }, 422);
    }
    if (result.code === "promoted") {
      return c.json({ error: result.error }, 409);
    }
    return c.json({ error: result.error }, 404);
  }
  return c.json({ blueprint: serializeBlueprint(result.blueprint) }, 200);
});

blueprintsRouter.openapi(disableRouteDef, async (c) => {
  const container = c.get("container");
  const { id } = c.req.valid("param");

  const result = await disableBlueprint({ container, id });
  if (!result.ok) {
    return c.json({ error: result.error }, 404);
  }
  return c.json({ blueprint: serializeBlueprint(result.blueprint) }, 200);
});

blueprintsRouter.openapi(graphRouteDef, async (c) => {
  const { db, templates } = c.get("container");
  const { id } = c.req.valid("param");

  const row = await findBlueprintRow({ db, id });
  if (!row) {
    return c.json({ error: "Blueprint not found" }, 404);
  }

  const graph = row.graph as unknown as JourneyGraph;

  // Same grouped query as the code-journey graph route: per-node live/failed
  // AND the status totals in one pass. A blueprint enrollment is a normal
  // journey_states row with journeyId = the blueprint id.
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
  for (const perNodeRow of perNode) {
    const n = Number(perNodeRow.count);
    statusTotals[perNodeRow.status] =
      (statusTotals[perNodeRow.status] ?? 0) + n;
    const nodeId = perNodeRow.nodeId;
    if (!nodeId) continue;
    const entry = nodeMetrics[nodeId] ?? { live: 0, failed: 0 };
    if (perNodeRow.status === "active" || perNodeRow.status === "waiting") {
      entry.live += n;
    } else if (perNodeRow.status === "failed") {
      entry.failed += n;
    }
    nodeMetrics[nodeId] = entry;
  }

  const enrolled = Object.values(statusTotals).reduce((a, b) => a + b, 0);

  // Send-node template resolution is trivial here (unlike the code-journey
  // route's 4-step cascade): a blueprint send node ALWAYS carries the
  // literal registry key — blueprintGraphSchema requires it.
  for (const node of graph.nodes) {
    if (node.type !== "send") continue;
    const key = node.meta?.template;
    if (!key) continue;
    const entry = nodeMetrics[node.id] ?? { live: 0, failed: 0 };
    entry.templateKey = key;
    const def = (templates as Record<string, { sourcePath?: string }>)[key];
    if (def?.sourcePath) entry.templatePath = def.sourcePath;
    nodeMetrics[node.id] = entry;
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
