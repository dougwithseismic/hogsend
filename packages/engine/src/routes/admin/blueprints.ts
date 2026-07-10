/**
 * Admin routes for Journey Blueprints (spec §9) — the CRUD + lifecycle surface
 * for journeys authored as DATA and executed by the generic interpreter task.
 * This is the save-time sandbox boundary of the whole feature (spec §8): a
 * graph is NEVER written to `journey_blueprints` without passing
 * {@link validateBlueprintGraphForSave} — `validateBlueprintGraph` (field
 * shapes + structural checks, @hogsend/core) layered with the engine-side
 * registry checks core cannot do (template keys, connector actions).
 *
 * Auth/rate-limit/audit come from the parent `adminRouter` middleware stack.
 * The MCP tools (spec §9, later phase) are thin wrappers over these routes —
 * no parallel auth or storage path.
 *
 * Conventions:
 *  - the blueprint id IS the graph's `journeyId` (one id, one namespace —
 *    `journeyStates.journeyId` points at it, same as a code journey's meta.id)
 *  - `version` bumps on any PATCH that includes `graph` (metadata-only edits
 *    don't bump; we deliberately don't deep-diff — jsonb normalizes key
 *    order, so equality checks would be unreliable, and a spurious bump is
 *    harmless)
 *  - a graph edit is REJECTED (409) while the blueprint has any active/
 *    waiting `journeyStates` rows — Hatchet's durable sleep/wait primitives
 *    are matched positionally on replay, so changing the node sequence out
 *    from under a suspended run can desync its replay journal. Code
 *    journeys don't have this hazard (their `run()` is immutable compiled
 *    code); a blueprint's graph is a mutable row, so this is an explicit
 *    gate rather than an implicit guarantee. Wait for enrollments to drain
 *    (or disable and let them finish) before editing a live graph
 *  - status transitions go through /enable + /disable (PATCH cannot set
 *    status) so enabling always re-runs validation against the CURRENT
 *    registries — a template unregistered since save is caught here, not at
 *    2am mid-run
 *  - invalid graphs are rejected 422 with the structured
 *    `BlueprintValidationIssue[]` verbatim (never a caught exception message)
 */
import {
  type BlueprintGraph,
  type BlueprintValidationIssue,
  type BlueprintValidationResult,
  blueprintGraphSchema,
  type JourneyGraph,
  journeyGraphSchema,
  validateBlueprintGraph,
} from "@hogsend/core";
import { propertyConditionSchema } from "@hogsend/core/schemas";
import { journeyBlueprints, journeyStates } from "@hogsend/db";
import { getTemplateNames } from "@hogsend/email";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import type { HogsendClient } from "../../container.js";
import { errorSchema, paginationQuerySchema } from "../../lib/schemas.js";
import { serializeState, stateSchema } from "./journeys.js";

type BlueprintRow = typeof journeyBlueprints.$inferSelect;
/** The opaque jsonb type of the `graph` column (db cannot import core). */
type BlueprintGraphColumn = BlueprintRow["graph"];

// ---------------------------------------------------------------------------
// Save-time validation — core checks + engine registry checks
// ---------------------------------------------------------------------------

type RegistryContainer = Pick<
  HogsendClient,
  "templates" | "connectorActionRegistry"
>;

/**
 * The engine-side half of the save-time sandbox (spec §8): every node input
 * is checked against a KNOWN registry, so a `send` of a template that isn't
 * registered (or a connector action that doesn't exist) fails at save time
 * with a structured issue, not at run time. @hogsend/core cannot do these —
 * the registries live in the container.
 */
function findRegistryIssues(
  graph: BlueprintGraph,
  container: RegistryContainer,
): BlueprintValidationIssue[] {
  const issues: BlueprintValidationIssue[] = [];
  const templateKeys = new Set<string>(getTemplateNames(container.templates));
  graph.nodes.forEach((node, index) => {
    if (node.type === "send" && !templateKeys.has(node.meta.template)) {
      issues.push({
        nodeId: node.id,
        path: ["nodes", index, "meta", "template"],
        code: "unknown_template",
        message: `node "${node.id}": "${node.meta.template}" is not a registered template key`,
      });
    }
    if (node.type === "connector") {
      const { connectorId, action } = node.meta;
      if (!container.connectorActionRegistry.get(connectorId, action)) {
        issues.push({
          nodeId: node.id,
          path: ["nodes", index, "meta", "connectorId"],
          code: "unknown_connector_action",
          message: `node "${node.id}": no connector action "${connectorId}:${action}" is registered`,
        });
      }
    }
  });
  return issues;
}

/**
 * Full save-time validation: `validateBlueprintGraph` (field shapes +
 * structural checks) plus the registry checks above. Used by create, PATCH
 * (when `graph` is present), enable (re-check against CURRENT registries),
 * and both validate endpoints — one validation story for every write path.
 *
 * When the graph parses field-wise but fails STRUCTURALLY, the registry
 * issues are still appended to the report — an iterating agent gets the whole
 * "what's wrong" list in one round instead of discovering the unknown
 * template only after fixing the cycle.
 */
export function validateBlueprintGraphForSave(
  graph: unknown,
  container: RegistryContainer,
): BlueprintValidationResult {
  const result = validateBlueprintGraph(graph);
  if (result.valid) {
    const issues = findRegistryIssues(result.graph, container);
    if (issues.length > 0) return { valid: false, issues };
    return result;
  }
  // Structural failure: the field shapes may still have parsed, in which case
  // the send/connector nodes are inspectable — report registry problems too.
  const parsed = blueprintGraphSchema.safeParse(graph);
  if (!parsed.success) return result;
  return {
    valid: false,
    issues: [
      ...result.issues,
      ...findRegistryIssues(
        parsed.data as unknown as BlueprintGraph,
        container,
      ),
    ],
  };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Execution-tier duration INPUT: strict keys so `{ days: 3 }` is rejected
 * loudly instead of becoming a silent zero (`durationToMs` ignores unknown
 * keys). Empty `{}` is allowed — for `suppress` it means "disabled", same
 * contract as JourneyMeta.suppress.
 */
const durationInputSchema = z.strictObject({
  hours: z.number().nonnegative().optional(),
  minutes: z.number().nonnegative().optional(),
  seconds: z.number().nonnegative().optional(),
});

const exitOnInputSchema = z.array(
  z.object({
    event: z.string().min(1),
    where: z.array(propertyConditionSchema).optional(),
  }),
);

const statusEnum = z.enum(["draft", "enabled", "disabled"]);
const entryLimitEnum = z.enum(["once", "once_per_period", "unlimited"]);
const sourceEnum = z.enum(["mcp", "studio", "api"]);

// The graph is accepted as `unknown` and validated in the handler via
// validateBlueprintGraphForSave — so a malformed graph ALWAYS yields the
// structured 422 issue list, never zod-openapi's generic 400.
const graphInputSchema = z.unknown();

const createBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  /**
   * Defaults to "draft"; a caller MAY create directly enabled (spec §10 —
   * post-hoc oversight, no forced staging step). "disabled" makes no sense
   * at creation and is rejected.
   */
  status: z.enum(["draft", "enabled"]).default("draft"),
  triggerEvent: z.string().min(1),
  triggerWhere: z.array(propertyConditionSchema).optional(),
  entryLimit: entryLimitEnum,
  entryPeriod: durationInputSchema.optional(),
  exitOn: exitOnInputSchema.optional(),
  suppress: durationInputSchema,
  graph: graphInputSchema,
  source: sourceEnum,
  createdBy: z.string().min(1).optional(),
});

// Partial update. `status` is deliberately absent — transitions go through
// /enable + /disable so enabling always re-validates. `source`/`createdBy`
// are provenance and immutable. Nullable fields accept null to clear.
const patchBodySchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    triggerEvent: z.string().min(1).optional(),
    triggerWhere: z.array(propertyConditionSchema).nullable().optional(),
    entryLimit: entryLimitEnum.optional(),
    entryPeriod: durationInputSchema.nullable().optional(),
    exitOn: exitOnInputSchema.nullable().optional(),
    suppress: durationInputSchema.optional(),
    graph: graphInputSchema.optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: "PATCH body must set at least one field",
  });

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
// write bodies above. Stored jsonb is echoed loosely (the strict shapes were
// enforced at write time).
const blueprintSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: statusEnum,
  version: z.number(),
  triggerEvent: z.string(),
  triggerWhere: z.array(z.record(z.string(), z.unknown())).nullable(),
  entryLimit: entryLimitEnum,
  entryPeriod: z.record(z.string(), z.number()).nullable(),
  exitOn: z
    .array(
      z.object({
        event: z.string(),
        where: z.array(z.record(z.string(), z.unknown())).optional(),
      }),
    )
    .nullable(),
  suppress: z.record(z.string(), z.number()),
  graph: journeyGraphSchema,
  source: sourceEnum,
  createdBy: z.string().nullable(),
  promotedAt: z.string().nullable(),
  promotedToJourneyId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// List rows omit the graph blob (fetch one / the graph route carry it).
const blueprintListItemSchema = blueprintSchema
  .omit({ graph: true })
  .extend({ counts: countsSchema });

const blueprintDetailSchema = blueprintSchema.extend({
  counts: countsSchema,
  recentStates: z.array(stateSchema),
});

function serializeBlueprint(
  row: BlueprintRow,
): z.infer<typeof blueprintSchema> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    version: row.version,
    triggerEvent: row.triggerEvent,
    triggerWhere: row.triggerWhere ?? null,
    entryLimit: row.entryLimit,
    entryPeriod: (row.entryPeriod ?? null) as Record<string, number> | null,
    exitOn: row.exitOn ?? null,
    suppress: row.suppress as Record<string, number>,
    graph: row.graph as unknown as JourneyGraph,
    source: row.source,
    createdBy: row.createdBy,
    promotedAt: row.promotedAt?.toISOString() ?? null,
    promotedToJourneyId: row.promotedToJourneyId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

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
      status: statusEnum.optional(),
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
          schema: z.object({ graph: graphInputSchema }),
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

async function fetchBlueprint(
  db: HogsendClient["db"],
  id: string,
): Promise<BlueprintRow | null> {
  const rows = await db
    .select()
    .from(journeyBlueprints)
    .where(eq(journeyBlueprints.id, id))
    .limit(1);
  return rows[0] ?? null;
}

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
  const { db, registry } = container;
  const body = c.req.valid("json");

  const result = validateBlueprintGraphForSave(body.graph, container);
  if (!result.valid) {
    return c.json(
      { error: "Blueprint graph failed validation", issues: result.issues },
      422,
    );
  }

  // The graph's journeyId IS the blueprint id — one id, one namespace.
  //
  // KNOWN GAP (documented, not fixed): this only guards the direction where
  // a blueprint is created AFTER a colliding code journey is already
  // registered. The reverse — deploying a NEW code journey whose id matches
  // an EXISTING blueprint's id — isn't guarded anywhere; both would then
  // share journeyStates.journeyId, and exit-condition resolution favors the
  // registered code journey. Closing this needs a boot-time cross-check
  // against journey_blueprints, deliberately left for when this actually
  // bites someone rather than adding DB-dependent boot machinery now.
  const id = result.graph.journeyId;
  if (registry.has(id)) {
    return c.json(
      {
        error: `"${id}" is a registered code journey — blueprint ids share the journey id namespace`,
      },
      409,
    );
  }

  // onConflictDoNothing + returning: the empty result IS the duplicate
  // check, atomically (no read-then-insert race).
  const inserted = await db
    .insert(journeyBlueprints)
    .values({
      id,
      name: body.name,
      description: body.description ?? null,
      status: body.status,
      triggerEvent: body.triggerEvent,
      triggerWhere: body.triggerWhere ?? null,
      entryLimit: body.entryLimit,
      entryPeriod: body.entryPeriod ?? null,
      exitOn: body.exitOn ?? null,
      suppress: body.suppress,
      graph: result.graph as unknown as BlueprintGraphColumn,
      source: body.source,
      createdBy: body.createdBy ?? null,
    })
    .onConflictDoNothing({ target: journeyBlueprints.id })
    .returning();

  const row = inserted[0];
  if (!row) {
    return c.json({ error: `Blueprint "${id}" already exists` }, 409);
  }
  return c.json({ blueprint: serializeBlueprint(row) }, 201);
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

  const row = await fetchBlueprint(db, id);
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
  const { db } = container;
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const existing = await fetchBlueprint(db, id);
  if (!existing) {
    return c.json({ error: "Blueprint not found" }, 404);
  }

  let validatedGraph: BlueprintGraph | undefined;
  if (body.graph !== undefined) {
    const result = validateBlueprintGraphForSave(body.graph, container);
    if (!result.valid) {
      return c.json(
        { error: "Blueprint graph failed validation", issues: result.issues },
        422,
      );
    }
    if (result.graph.journeyId !== id) {
      return c.json(
        {
          error: "Graph journeyId does not match the blueprint id",
          issues: [
            {
              path: ["journeyId"],
              code: "journey_id_mismatch",
              message: `graph.journeyId "${result.graph.journeyId}" must match the blueprint id "${id}" — the id is immutable`,
            },
          ],
        },
        422,
      );
    }
    validatedGraph = result.graph;

    // Graph edits are unsafe while a run is suspended mid-graph (positional
    // replay journal, see module header) — block it outright rather than
    // relying on a version pin that can't actually protect a resume.
    const [inFlight] = await db
      .select({ count: count() })
      .from(journeyStates)
      .where(
        and(
          eq(journeyStates.journeyId, id),
          isNull(journeyStates.deletedAt),
          inArray(journeyStates.status, ["active", "waiting"]),
        ),
      );
    if (inFlight && inFlight.count > 0) {
      return c.json(
        {
          error: `Cannot edit this blueprint's graph while ${inFlight.count} enrollment(s) are active or waiting — editing a live graph can desync Hatchet's replay journal for an in-flight run. Wait for enrollments to drain, or disable the blueprint and let them finish, before editing the graph.`,
        },
        409,
      );
    }
  }

  const set: Partial<typeof journeyBlueprints.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (body.name !== undefined) set.name = body.name;
  if (body.description !== undefined) set.description = body.description;
  if (body.triggerEvent !== undefined) set.triggerEvent = body.triggerEvent;
  if (body.triggerWhere !== undefined) set.triggerWhere = body.triggerWhere;
  if (body.entryLimit !== undefined) set.entryLimit = body.entryLimit;
  if (body.entryPeriod !== undefined) set.entryPeriod = body.entryPeriod;
  if (body.exitOn !== undefined) set.exitOn = body.exitOn;
  if (body.suppress !== undefined) set.suppress = body.suppress;
  if (validatedGraph !== undefined) {
    set.graph = validatedGraph as unknown as BlueprintGraphColumn;
    // Version bump rule: any PATCH carrying `graph` bumps (documented in
    // the module header). Safe to bump unconditionally here — the in-flight
    // check above already rejected this request if any run could observe
    // the change mid-flight.
    set.version = existing.version + 1;
  }

  const updated = await db
    .update(journeyBlueprints)
    .set(set)
    .where(eq(journeyBlueprints.id, id))
    .returning();

  const row = updated[0];
  if (!row) {
    return c.json({ error: "Blueprint not found" }, 404);
  }
  return c.json({ blueprint: serializeBlueprint(row) }, 200);
});

blueprintsRouter.openapi(validateByIdRouteDef, async (c) => {
  const container = c.get("container");
  const { id } = c.req.valid("param");

  const row = await fetchBlueprint(container.db, id);
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
  const { db } = container;
  const { id } = c.req.valid("param");

  const existing = await fetchBlueprint(db, id);
  if (!existing) {
    return c.json({ error: "Blueprint not found" }, 404);
  }
  if (existing.promotedAt) {
    return c.json(
      {
        error: `Blueprint "${id}" was promoted to code (${existing.promotedToJourneyId ?? "unknown journey"}) — the code journey is the source of truth; it cannot be re-enabled`,
      },
      409,
    );
  }

  // Enabling is the moment a graph goes live, so re-validate against the
  // CURRENT registries — a template/connector unregistered since save is
  // caught here instead of failing runs at dispatch time.
  const result = validateBlueprintGraphForSave(existing.graph, container);
  if (!result.valid) {
    return c.json(
      {
        error:
          "Stored graph no longer passes validation — fix it before enabling",
        issues: result.issues,
      },
      422,
    );
  }

  const updated = await db
    .update(journeyBlueprints)
    .set({ status: "enabled", updatedAt: new Date() })
    .where(eq(journeyBlueprints.id, id))
    .returning();

  const row = updated[0];
  if (!row) {
    return c.json({ error: "Blueprint not found" }, 404);
  }
  return c.json({ blueprint: serializeBlueprint(row) }, 200);
});

blueprintsRouter.openapi(disableRouteDef, async (c) => {
  const { db } = c.get("container");
  const { id } = c.req.valid("param");

  const updated = await db
    .update(journeyBlueprints)
    .set({ status: "disabled", updatedAt: new Date() })
    .where(eq(journeyBlueprints.id, id))
    .returning();

  const row = updated[0];
  if (!row) {
    return c.json({ error: "Blueprint not found" }, 404);
  }
  return c.json({ blueprint: serializeBlueprint(row) }, 200);
});

blueprintsRouter.openapi(graphRouteDef, async (c) => {
  const { db, templates } = c.get("container");
  const { id } = c.req.valid("param");

  const row = await fetchBlueprint(db, id);
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
