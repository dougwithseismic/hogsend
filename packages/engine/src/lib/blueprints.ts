/**
 * Journey Blueprint service layer — the ONE write path for
 * `journey_blueprints`, shared verbatim by the admin routes
 * (`routes/admin/blueprints.ts`) and the agent-facing tools
 * (`mcp/blueprint-tools.ts`). Spec §9's "the MCP tool is a thin wrapper over
 * these — no parallel auth or storage path" is enforced structurally: both
 * surfaces call these functions in-process, so there is nothing to drift.
 *
 * This module is the save-time sandbox boundary of the whole feature
 * (spec §8): a graph is NEVER written without passing
 * {@link validateBlueprintGraphForSave} — `validateBlueprintGraph` (field
 * shapes + structural checks, @hogsend/core) layered with the engine-side
 * registry checks core cannot do (template keys, connector actions).
 *
 * Conventions (shared by both surfaces):
 *  - the blueprint id IS the graph's `journeyId` (one id, one namespace —
 *    `journeyStates.journeyId` points at it, same as a code journey's meta.id)
 *  - `version` bumps on any update that includes `graph` (metadata-only edits
 *    don't bump; we deliberately don't deep-diff — jsonb normalizes key order,
 *    so equality checks would be unreliable, and a spurious bump is harmless)
 *  - a graph-changing update is REJECTED (`in_flight` failure) while the
 *    blueprint has any active/waiting `journeyStates` rows — Hatchet's
 *    durable sleep/wait primitives are matched positionally on replay, so
 *    changing the node sequence out from under a suspended run can desync
 *    its replay journal. Code journeys don't have this hazard (their
 *    `run()` is immutable compiled code); a blueprint's graph is a mutable
 *    row, so this is an explicit gate, not an implicit guarantee
 *  - enabling always re-runs validation against the CURRENT registries — a
 *    template unregistered since save is caught here, not at 2am mid-run
 *  - expected failures are result objects (discriminated on `ok`/`code`)
 *    carrying the structured `BlueprintValidationIssue[]` verbatim — never a
 *    caught exception's `.message`
 */
import {
  type BlueprintGraph,
  type BlueprintValidationIssue,
  type BlueprintValidationResult,
  blueprintGraphSchema,
  isReservedEventName,
  type JourneyGraph,
  journeyGraphSchema,
  RESERVED_EVENT_NAMESPACES,
  validateBlueprintGraph,
} from "@hogsend/core";
import { propertyConditionSchema } from "@hogsend/core/schemas";
import { journeyBlueprints, journeyStates } from "@hogsend/db";
import { getTemplateNames } from "@hogsend/email";
import { z } from "@hono/zod-openapi";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import type { HogsendClient } from "../container.js";
import { blueprintGraphLock } from "./blueprint-lock.js";

export type BlueprintRow = typeof journeyBlueprints.$inferSelect;
/** The opaque jsonb type of the `graph` column (db cannot import core). */
type BlueprintGraphColumn = BlueprintRow["graph"];

/** What graph validation needs from the container. */
export type BlueprintRegistryContainer = Pick<
  HogsendClient,
  "templates" | "connectorActionRegistry"
>;

/** What the write operations need from the container. */
export type BlueprintServiceContainer = Pick<
  HogsendClient,
  "db" | "registry" | "templates" | "connectorActionRegistry"
>;

// ---------------------------------------------------------------------------
// Save-time validation — core checks + engine registry checks
// ---------------------------------------------------------------------------

/**
 * The engine-side half of the save-time sandbox (spec §8): every node input
 * is checked against a KNOWN registry, so a `send` of a template that isn't
 * registered (or a connector action that doesn't exist) fails at save time
 * with a structured issue, not at run time. @hogsend/core cannot do these —
 * the registries live in the container.
 */
function findRegistryIssues(
  graph: BlueprintGraph,
  container: BlueprintRegistryContainer,
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
    // Reserved namespaces (email./journey./bucket./contact., dot or colon)
    // are engine-emitted — a trigger node forging one would feed synthetic
    // engine events through the full ingest pipeline. Same rule the semantic
    // link send path enforces; the interpreter re-throws as defense-in-depth.
    if (node.type === "trigger" && isReservedEventName(node.meta.event)) {
      issues.push({
        nodeId: node.id,
        path: ["nodes", index, "meta", "event"],
        code: "reserved_event",
        message: `node "${node.id}": event "${node.meta.event}" uses a reserved namespace (${RESERVED_EVENT_NAMESPACES.join("/")}) — engine-emitted events cannot be forged by a blueprint`,
      });
    }
  });
  return issues;
}

/** The structured `invalid_graph` failure for a reserved trigger EVENT (the
 * blueprint-record field, not a graph node) — shared by create and update. */
function reservedTriggerEventFailure(
  triggerEvent: string,
): BlueprintInvalidGraphFailure {
  return {
    ok: false,
    code: "invalid_graph",
    error: "triggerEvent uses a reserved event namespace",
    issues: [
      {
        path: ["triggerEvent"],
        code: "reserved_event",
        message: `triggerEvent "${triggerEvent}" uses a reserved namespace (${RESERVED_EVENT_NAMESPACES.join("/")}) — engine-emitted events cannot trigger a blueprint`,
      },
    ],
  };
}

/**
 * Full save-time validation: `validateBlueprintGraph` (field shapes +
 * structural checks) plus the registry checks above. Used by create, update
 * (when `graph` is present), enable (re-check against CURRENT registries),
 * and every validate surface — one validation story for every write path.
 *
 * When the graph parses field-wise but fails STRUCTURALLY, the registry
 * issues are still appended to the report — an iterating agent gets the whole
 * "what's wrong" list in one round instead of discovering the unknown
 * template only after fixing the cycle.
 */
export function validateBlueprintGraphForSave(
  graph: unknown,
  container: BlueprintRegistryContainer,
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
// Shared input schemas — one source of truth for admin routes AND tools
// ---------------------------------------------------------------------------

/**
 * Execution-tier duration INPUT: strict keys so `{ days: 3 }` is rejected
 * loudly instead of becoming a silent zero (`durationToMs` ignores unknown
 * keys). Empty `{}` is allowed — for `suppress` it means "disabled", same
 * contract as JourneyMeta.suppress.
 */
export const blueprintDurationInputSchema = z.strictObject({
  hours: z.number().nonnegative().optional(),
  minutes: z.number().nonnegative().optional(),
  seconds: z.number().nonnegative().optional(),
});

/**
 * `entryPeriod` variant: at least one key required (same refine as core's
 * graph-node `blueprintDurationSchema`). An empty `{}` would make
 * `durationToMs({}) === 0`, silently turning `once_per_period` into
 * `unlimited` — the one place a zero-length duration is a footgun, not a
 * "disabled" contract. Omitting `entryPeriod` entirely stays legal:
 * `checkEntryLimit` defaults an undefined period to 24h.
 */
export const blueprintEntryPeriodInputSchema =
  blueprintDurationInputSchema.refine(
    (d) =>
      d.hours !== undefined ||
      d.minutes !== undefined ||
      d.seconds !== undefined,
    { message: "entryPeriod must set at least one of hours/minutes/seconds" },
  );

export const blueprintExitOnInputSchema = z.array(
  z.object({
    event: z.string().min(1),
    where: z.array(propertyConditionSchema).optional(),
  }),
);

export const blueprintStatusSchema = z.enum(["draft", "enabled", "disabled"]);
export const blueprintEntryLimitSchema = z.enum([
  "once",
  "once_per_period",
  "unlimited",
]);
export const blueprintSourceSchema = z.enum(["mcp", "studio", "api"]);

// The graph is accepted as `unknown` and validated by
// validateBlueprintGraphForSave — so a malformed graph ALWAYS yields the
// structured issue list, never a schema layer's generic error.
export const blueprintGraphInputSchema = z.unknown();

/**
 * The create payload MINUS `source` — provenance is stamped by the surface
 * (the admin route takes it from the request body; the agent tools hard-code
 * `"mcp"`), never trusted to mean the same thing across surfaces.
 */
export const blueprintCreateBaseSchema = z.object({
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
  entryLimit: blueprintEntryLimitSchema,
  entryPeriod: blueprintEntryPeriodInputSchema.optional(),
  exitOn: blueprintExitOnInputSchema.optional(),
  suppress: blueprintDurationInputSchema,
  graph: blueprintGraphInputSchema,
  createdBy: z.string().min(1).optional(),
});

/**
 * Partial-update fields. `status` is deliberately absent — transitions go
 * through enable/disable so enabling always re-validates. `source`/`createdBy`
 * are provenance and immutable. Nullable fields accept null to clear.
 * Callers layer their own "at least one field" refinement on top (the routes
 * on the body, the tools excluding `id`).
 */
export const blueprintPatchFieldsSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  triggerEvent: z.string().min(1).optional(),
  triggerWhere: z.array(propertyConditionSchema).nullable().optional(),
  entryLimit: blueprintEntryLimitSchema.optional(),
  entryPeriod: blueprintEntryPeriodInputSchema.nullable().optional(),
  exitOn: blueprintExitOnInputSchema.nullable().optional(),
  suppress: blueprintDurationInputSchema.optional(),
  graph: blueprintGraphInputSchema.optional(),
});

export type CreateBlueprintInput = z.infer<typeof blueprintCreateBaseSchema> & {
  source: z.infer<typeof blueprintSourceSchema>;
};
export type UpdateBlueprintPatch = z.infer<typeof blueprintPatchFieldsSchema>;

// ---------------------------------------------------------------------------
// Serialization — flat row shape shared by routes and tools
// ---------------------------------------------------------------------------

// Row serialization is FLAT (column names verbatim: triggerEvent,
// triggerWhere, …) so a read → edit → update loop round-trips 1:1 with the
// write inputs above. Stored jsonb is echoed loosely (the strict shapes were
// enforced at write time).
export const serializedBlueprintSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: blueprintStatusSchema,
  version: z.number(),
  triggerEvent: z.string(),
  triggerWhere: z.array(z.record(z.string(), z.unknown())).nullable(),
  entryLimit: blueprintEntryLimitSchema,
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
  source: blueprintSourceSchema,
  createdBy: z.string().nullable(),
  promotedAt: z.string().nullable(),
  promotedToJourneyId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type SerializedBlueprint = z.infer<typeof serializedBlueprintSchema>;

export function serializeBlueprint(row: BlueprintRow): SerializedBlueprint {
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

// ---------------------------------------------------------------------------
// Operations — precise per-operation result unions
// ---------------------------------------------------------------------------

export type BlueprintInvalidGraphFailure = {
  ok: false;
  code: "invalid_graph";
  error: string;
  issues: BlueprintValidationIssue[];
};
export type BlueprintNotFoundFailure = {
  ok: false;
  code: "not_found";
  error: string;
};

export type CreateBlueprintResult =
  | { ok: true; blueprint: BlueprintRow }
  | { ok: false; code: "conflict"; error: string }
  | BlueprintInvalidGraphFailure;

export type BlueprintPromotedFailure = {
  ok: false;
  code: "promoted";
  error: string;
};

/**
 * Optimistic-concurrency loss: a concurrent graph edit committed a version bump
 * between this caller reading the row and its guarded update — retryable (re-read
 * and re-apply the edit onto the new version). Maps to 409, like `in_flight`.
 */
export type BlueprintVersionConflictFailure = {
  ok: false;
  code: "version_conflict";
  error: string;
};

export type UpdateBlueprintResult =
  | { ok: true; blueprint: BlueprintRow }
  | BlueprintNotFoundFailure
  | BlueprintInvalidGraphFailure
  | { ok: false; code: "in_flight"; error: string }
  | BlueprintVersionConflictFailure
  | BlueprintPromotedFailure;

export type EnableBlueprintResult =
  | { ok: true; blueprint: BlueprintRow }
  | BlueprintNotFoundFailure
  | BlueprintPromotedFailure
  | BlueprintInvalidGraphFailure;

export type DisableBlueprintResult =
  | { ok: true; blueprint: BlueprintRow }
  | BlueprintNotFoundFailure;

export type PromoteBlueprintResult =
  | { ok: true; blueprint: BlueprintRow }
  | BlueprintNotFoundFailure
  | { ok: false; code: "already_promoted"; error: string };

export async function findBlueprintRow(opts: {
  db: HogsendClient["db"];
  id: string;
}): Promise<BlueprintRow | null> {
  const rows = await opts.db
    .select()
    .from(journeyBlueprints)
    .where(eq(journeyBlueprints.id, opts.id))
    .limit(1);
  return rows[0] ?? null;
}

function notFound(id: string): BlueprintNotFoundFailure {
  return { ok: false, code: "not_found", error: `Blueprint "${id}" not found` };
}

/** Shared "already promoted" description for enable's and promote's errors. */
function describePromotion(
  existing: Pick<BlueprintRow, "promotedAt" | "promotedToJourneyId">,
): string {
  const target = existing.promotedToJourneyId ?? "unknown journey";
  const when = existing.promotedAt?.toISOString() ?? "unknown date";
  return `promoted to code journey "${target}" on ${when}`;
}

/**
 * Create a blueprint. The graph is validated (schema + structure +
 * template/connector registries) before anything is written — an invalid
 * graph is never saved. The blueprint id is the graph's `journeyId`.
 */
export async function createBlueprint(opts: {
  container: BlueprintServiceContainer;
  input: CreateBlueprintInput;
}): Promise<CreateBlueprintResult> {
  const { container, input } = opts;

  if (isReservedEventName(input.triggerEvent)) {
    return reservedTriggerEventFailure(input.triggerEvent);
  }

  const result = validateBlueprintGraphForSave(input.graph, container);
  if (!result.valid) {
    return {
      ok: false,
      code: "invalid_graph",
      error: "Blueprint graph failed validation",
      issues: result.issues,
    };
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
  if (container.registry.has(id)) {
    return {
      ok: false,
      code: "conflict",
      error: `"${id}" is a registered code journey — blueprint ids share the journey id namespace`,
    };
  }

  // onConflictDoNothing + returning: the empty result IS the duplicate
  // check, atomically (no read-then-insert race).
  const inserted = await container.db
    .insert(journeyBlueprints)
    .values({
      id,
      name: input.name,
      description: input.description ?? null,
      status: input.status,
      triggerEvent: input.triggerEvent,
      triggerWhere: input.triggerWhere ?? null,
      entryLimit: input.entryLimit,
      entryPeriod: input.entryPeriod ?? null,
      exitOn: input.exitOn ?? null,
      suppress: input.suppress,
      graph: result.graph as unknown as BlueprintGraphColumn,
      source: input.source,
      createdBy: input.createdBy ?? null,
    })
    .onConflictDoNothing({ target: journeyBlueprints.id })
    .returning();

  const row = inserted[0];
  if (!row) {
    return {
      ok: false,
      code: "conflict",
      error: `Blueprint "${id}" already exists`,
    };
  }
  return { ok: true, blueprint: row };
}

/**
 * Partial update. A `graph` change is re-validated the same way create is and
 * bumps `version` by 1 (in-flight runs stay pinned to the version they enrolled
 * under, spec §12). The graph write runs in a transaction under a
 * blueprint-keyed advisory lock so its in-flight count + update is atomic
 * against a concurrent enrollment insert (which takes the same lock) and is
 * guarded on the version read (`version_conflict` on a concurrent edit) and on
 * `promotedAt IS NULL` (`promoted` on a concurrent promote). Metadata-only edits
 * do not bump, need no lock, and are never blocked. Status transitions go
 * through enable/disable, not here.
 */
export async function updateBlueprint(opts: {
  container: BlueprintServiceContainer;
  id: string;
  patch: UpdateBlueprintPatch;
}): Promise<UpdateBlueprintResult> {
  const { container, id, patch } = opts;

  if (
    patch.triggerEvent !== undefined &&
    isReservedEventName(patch.triggerEvent)
  ) {
    return reservedTriggerEventFailure(patch.triggerEvent);
  }

  const existing = await findBlueprintRow({ db: container.db, id });
  if (!existing) return notFound(id);
  if (existing.promotedAt) {
    return {
      ok: false,
      code: "promoted",
      error: `Blueprint "${id}" was ${describePromotion(existing)} — it is frozen and cannot be edited`,
    };
  }

  let validatedGraph: BlueprintGraph | undefined;
  if (patch.graph !== undefined) {
    const result = validateBlueprintGraphForSave(patch.graph, container);
    if (!result.valid) {
      return {
        ok: false,
        code: "invalid_graph",
        error: "Blueprint graph failed validation",
        issues: result.issues,
      };
    }
    if (result.graph.journeyId !== id) {
      return {
        ok: false,
        code: "invalid_graph",
        error: "Graph journeyId does not match the blueprint id",
        issues: [
          {
            path: ["journeyId"],
            code: "journey_id_mismatch",
            message: `graph.journeyId "${result.graph.journeyId}" must match the blueprint id "${id}" — the id is immutable`,
          },
        ],
      };
    }
    validatedGraph = result.graph;
  }

  const set: Partial<typeof journeyBlueprints.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.triggerEvent !== undefined) set.triggerEvent = patch.triggerEvent;
  if (patch.triggerWhere !== undefined) set.triggerWhere = patch.triggerWhere;
  if (patch.entryLimit !== undefined) set.entryLimit = patch.entryLimit;
  if (patch.entryPeriod !== undefined) set.entryPeriod = patch.entryPeriod;
  if (patch.exitOn !== undefined) set.exitOn = patch.exitOn;
  if (patch.suppress !== undefined) set.suppress = patch.suppress;

  // Metadata-only edit: no graph, no version bump, no in-flight hazard (the
  // node sequence is untouched, so no suspended run can desync). One guarded
  // update on `promotedAt IS NULL` closes the promote race the early check
  // above cannot (registry validation / reads happen in between).
  if (validatedGraph === undefined) {
    const updated = await container.db
      .update(journeyBlueprints)
      .set(set)
      .where(
        and(eq(journeyBlueprints.id, id), isNull(journeyBlueprints.promotedAt)),
      )
      .returning();
    const row = updated[0];
    if (row) return { ok: true, blueprint: row };
    const raced = await findBlueprintRow({ db: container.db, id });
    if (!raced) return notFound(id);
    return {
      ok: false,
      code: "promoted",
      error: `Blueprint "${id}" was ${describePromotion(raced)} — it is frozen and cannot be edited`,
    };
  }

  // Graph edit. Two hazards, both closed inside one transaction under a
  // blueprint-keyed advisory lock (the enrollment insert path takes the SAME
  // lock — blueprint-lock.ts):
  //  1. in-flight: a run must not become active/waiting BETWEEN the count and
  //     the write, or a graph edit lands under a just-started run and desyncs
  //     its positional Hatchet replay journal. The lock serializes the
  //     count+update against enrollment inserts, so the count is authoritative.
  //  2. lost update: two concurrent graph edits serialize on the lock, and the
  //     `version = existing.version` predicate makes the loser (whose read
  //     predates the winner's bump) match zero rows and return
  //     `version_conflict` instead of overwriting the winner's graph.
  // The `promotedAt IS NULL` predicate additionally closes the promote race.
  set.graph = validatedGraph as unknown as BlueprintGraphColumn;
  set.version = existing.version + 1;

  return container.db.transaction(async (tx) => {
    await tx.execute(blueprintGraphLock(id));

    const [inFlight] = await tx
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
      return {
        ok: false,
        code: "in_flight",
        error: `Cannot edit this blueprint's graph while ${inFlight.count} enrollment(s) are active or waiting — editing a live graph can desync Hatchet's replay journal for an in-flight run. Wait for enrollments to drain, or disable the blueprint and let them finish, before editing the graph.`,
      };
    }

    const updated = await tx
      .update(journeyBlueprints)
      .set(set)
      .where(
        and(
          eq(journeyBlueprints.id, id),
          isNull(journeyBlueprints.promotedAt),
          eq(journeyBlueprints.version, existing.version),
        ),
      )
      .returning();
    const row = updated[0];
    if (row) return { ok: true, blueprint: row };

    // Zero rows: blueprints are never hard-deleted, so the id still exists —
    // the guard that failed is `promotedAt` (a concurrent promote) or `version`
    // (a concurrent graph edit committed its bump). Re-read inside the txn
    // (READ COMMITTED sees the committed winner) to return the precise code.
    const [raced] = await tx
      .select()
      .from(journeyBlueprints)
      .where(eq(journeyBlueprints.id, id))
      .limit(1);
    if (!raced) return notFound(id);
    if (raced.promotedAt) {
      return {
        ok: false,
        code: "promoted",
        error: `Blueprint "${id}" was ${describePromotion(raced)} — it is frozen and cannot be edited`,
      };
    }
    return {
      ok: false,
      code: "version_conflict",
      error: `Blueprint "${id}" changed under you (version ${existing.version} → ${raced.version}) — re-read it and re-apply your edit onto the current graph.`,
    };
  });
}

/**
 * Enable — the moment a graph goes live, so the stored graph is re-validated
 * against the CURRENT registries first (a blueprint whose template/connector
 * vanished since save cannot go live). Idempotent when already enabled. A
 * promoted blueprint cannot be re-enabled — the code journey is the source
 * of truth (spec §11).
 */
export async function enableBlueprint(opts: {
  container: BlueprintServiceContainer;
  id: string;
}): Promise<EnableBlueprintResult> {
  const { container, id } = opts;

  const existing = await findBlueprintRow({ db: container.db, id });
  if (!existing) return notFound(id);
  if (existing.promotedAt) {
    return {
      ok: false,
      code: "promoted",
      error: `Blueprint "${id}" was ${describePromotion(existing)} — the code journey is the source of truth; it cannot be re-enabled`,
    };
  }

  const result = validateBlueprintGraphForSave(existing.graph, container);
  if (!result.valid) {
    return {
      ok: false,
      code: "invalid_graph",
      error:
        "Stored graph no longer passes validation — fix it before enabling",
      issues: result.issues,
    };
  }

  // Guarded on promotedAt IS NULL to close the window between the check
  // above and this write — a concurrent promote can land while
  // validateBlueprintGraphForSave is awaited, and without this guard the
  // blind UPDATE below would silently re-enable a blueprint that just got
  // promoted, leaving status="enabled" alongside promotedAt/
  // promotedToJourneyId set.
  const updated = await container.db
    .update(journeyBlueprints)
    .set({ status: "enabled", updatedAt: new Date() })
    .where(
      and(eq(journeyBlueprints.id, id), isNull(journeyBlueprints.promotedAt)),
    )
    .returning();

  const row = updated[0];
  if (row) return { ok: true, blueprint: row };

  const raced = await findBlueprintRow({ db: container.db, id });
  if (!raced) return notFound(id);
  return {
    ok: false,
    code: "promoted",
    error: `Blueprint "${id}" was ${describePromotion(raced)} — the code journey is the source of truth; it cannot be re-enabled`,
  };
}

/**
 * Disable — new enrollments stop on the next event; in-flight runs keep
 * going (spec §12 — matches how code journeys behave when enabled flips
 * off). Idempotent when already disabled.
 */
export async function disableBlueprint(opts: {
  container: BlueprintServiceContainer;
  id: string;
}): Promise<DisableBlueprintResult> {
  const { container, id } = opts;

  const updated = await container.db
    .update(journeyBlueprints)
    .set({ status: "disabled", updatedAt: new Date() })
    .where(eq(journeyBlueprints.id, id))
    .returning();

  const row = updated[0];
  if (!row) return notFound(id);
  return { ok: true, blueprint: row };
}

/**
 * Promote — record that a generated code journey is now the source of truth
 * for this blueprint (spec §11). Stamps `promotedAt`/`promotedToJourneyId`
 * and disables the blueprint in one update; `enableBlueprint` refuses a
 * promoted blueprint from then on. This is ONLY the DB state transition —
 * codegen (blueprint → `defineJourney()` file) lives in the CLI, not here.
 * NOT idempotent: a second promote is `already_promoted` (the caller decides
 * whether that's fine or a mistake — the first promotion's target stands).
 */
export async function promoteBlueprint(opts: {
  container: BlueprintServiceContainer;
  id: string;
  journeyId: string;
}): Promise<PromoteBlueprintResult> {
  const { container, id, journeyId } = opts;

  // A single conditional UPDATE covers both "does it exist" and "is it
  // already promoted" atomically — no separate pre-fetch on the (common)
  // success path. The fallback lookup below only runs to tell the two
  // failure cases apart and build the right error message.
  const updated = await container.db
    .update(journeyBlueprints)
    .set({
      status: "disabled",
      promotedAt: new Date(),
      promotedToJourneyId: journeyId,
      updatedAt: new Date(),
    })
    .where(
      and(eq(journeyBlueprints.id, id), isNull(journeyBlueprints.promotedAt)),
    )
    .returning();

  const row = updated[0];
  if (row) return { ok: true, blueprint: row };

  const existing = await findBlueprintRow({ db: container.db, id });
  if (!existing) return notFound(id);
  return {
    ok: false,
    code: "already_promoted",
    error: `Blueprint "${id}" was already ${describePromotion(existing)}`,
  };
}
