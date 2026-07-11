/**
 * Journey Blueprint authoring tools (spec §9, phase 4) — the agent-facing
 * surface for creating, validating, and operating blueprints without a
 * deploy in the loop.
 *
 * Deliberately TRANSPORT-AGNOSTIC: this repo runs no MCP server today, so
 * each tool is a plain `{ name, description, inputSchema, handler }` record
 * rather than a registration against a specific SDK. That shape mounts
 * 1:1 onto whatever hosts it:
 *  - an MCP server: `server.registerTool(t.name, { description, inputSchema }, t.handler)`
 *  - the Vercel AI SDK (like `buildAgentTools`): `tool({ description, inputSchema, execute: t.handler })`
 *  - direct in-process calls (tests, scripts): `await t.handler(input)`
 *
 * Handlers call the SAME service layer the admin routes use
 * (`lib/blueprints.ts`) — in-process function calls, no HTTP round-trip, no
 * parallel auth or storage path (spec §9: "thin wrapper … no parallel auth
 * or storage path"). Authentication is the MOUNTING surface's job, exactly
 * as `adminRouter` middleware is for the routes: do not expose these tools
 * without an auth gate in front of them.
 *
 * Contract: handlers NEVER throw for expected failures. Every result is a
 * discriminated union on `ok` (+ `code` on failures), and graph problems
 * carry the same structured `BlueprintValidationIssue[]` the admin routes
 * return — an authoring agent iterates on an itemized "what's wrong and
 * where" list, not a caught exception's `.message`. Unexpected errors (DB
 * down, …) still throw and are the host's problem.
 */
import type { BlueprintValidationIssue } from "@hogsend/core";
import { journeyBlueprints, userEvents } from "@hogsend/db";
import { getTemplateNames } from "@hogsend/email";
import { count, desc, ilike, max } from "drizzle-orm";
import { z } from "zod";
import {
  type BlueprintServiceContainer,
  blueprintCreateBaseSchema,
  blueprintPatchFieldsSchema,
  createBlueprint,
  disableBlueprint,
  enableBlueprint,
  findBlueprintRow,
  type SerializedBlueprint,
  serializeBlueprint,
  updateBlueprint,
  validateBlueprintGraphForSave,
} from "../lib/blueprints.js";

// ---------------------------------------------------------------------------
// Tool shape
// ---------------------------------------------------------------------------

/** Issue shape shared by input parsing and graph validation failures. */
export type BlueprintToolIssue = {
  nodeId?: string;
  edgeId?: string;
  path: (string | number)[];
  code: string;
  message: string;
};

/** Returned when the tool call's arguments don't parse against `inputSchema`. */
export type BlueprintToolInvalidInput = {
  ok: false;
  code: "invalid_input";
  error: string;
  issues: BlueprintToolIssue[];
};

/**
 * One tool: a name, an agent-facing description, a Zod input schema (convert
 * with `z.toJSONSchema` for hosts that speak JSON Schema, e.g. MCP), and a
 * handler. The handler safe-parses its own input (applying defaults), so it
 * is self-contained even when the host doesn't pre-validate.
 */
export interface BlueprintToolDefinition<S extends z.ZodType, Out> {
  name: string;
  description: string;
  inputSchema: S;
  handler: (input: unknown) => Promise<Out | BlueprintToolInvalidInput>;
}

function defineTool<S extends z.ZodType, Out>(def: {
  name: string;
  description: string;
  inputSchema: S;
  run: (input: z.output<S>) => Promise<Out>;
}): BlueprintToolDefinition<S, Out> {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    handler: async (input) => {
      const parsed = def.inputSchema.safeParse(input ?? {});
      if (!parsed.success) {
        return {
          ok: false,
          code: "invalid_input",
          error: `Invalid input for ${def.name}`,
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.filter(
              (p): p is string | number => typeof p !== "symbol",
            ),
            code: issue.code,
            message: issue.message,
          })),
        } satisfies BlueprintToolInvalidInput;
      }
      return def.run(parsed.data);
    },
  };
}

// ---------------------------------------------------------------------------
// Shared result pieces + description fragments
// ---------------------------------------------------------------------------

type ToolWriteSuccess = { ok: true; blueprint: SerializedBlueprint };
type ToolNotFound = { ok: false; code: "not_found"; error: string };
type ToolConflict = { ok: false; code: "conflict"; error: string };
type ToolPromoted = { ok: false; code: "promoted"; error: string };
type ToolInFlight = { ok: false; code: "in_flight"; error: string };
type ToolVersionConflict = {
  ok: false;
  code: "version_conflict";
  error: string;
};
type ToolInvalidGraph = {
  ok: false;
  code: "invalid_graph";
  error: string;
  issues: BlueprintValidationIssue[];
};

const okWrite = (blueprint: SerializedBlueprint): ToolWriteSuccess => ({
  ok: true,
  blueprint,
});

/**
 * The closed executable vocabulary (spec §6/§7), summarized for the model.
 * Kept in the descriptions of every graph-accepting tool so an agent can
 * author without a docs round-trip.
 */
const GRAPH_FORMAT =
  "Graph format: { journeyId, nodes[], edges[] }. journeyId IS the blueprint id. " +
  'Node: { id, type, title, meta? }. Executable node types (closed vocabulary): "start" (exactly one; the entry point), ' +
  '"sleep" (meta.duration: { hours?, minutes?, seconds? }), ' +
  '"wait" (meta: { event, timeout } — wait for the user\'s event or time out; fork with edge kinds "answered"/"timedOut", or use a single unconditional edge), ' +
  '"send" (meta: { template, idempotencyLabel? } — template MUST be a key from list_email_templates), ' +
  '"connector" (meta: { connectorId, action } — must be a registered connector action), ' +
  '"checkpoint", "trigger" (meta: { event } — fires an event through the ingest pipeline), ' +
  '"decision"/"branch" (meta.conditions: ConditionEval[]; exactly two outgoing edges, kinds "conditional-true" and "conditional-false"), ' +
  'and terminals "end-completed"/"end-exited"/"end-failed". ' +
  'Edge: { id, source, target, kind? }. The graph must be acyclic, have exactly one start, and every node must be reachable from start; non-forking nodes have at most one outgoing edge. "sleepUntil", "capture", "digest", and "unknown" nodes are NOT executable in a blueprint. ' +
  "Trigger/entryLimit/exitOn/suppress live on the blueprint record, not in the graph.";

const ISSUE_LOOP_HINT =
  "On validation failure you get structured issues [{ nodeId?, edgeId?, path, code, message }] naming exactly what is wrong and where — fix and retry. " +
  "Tip: iterate with validate_journey_blueprint until valid before writing.";

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

// Neither `source` NOR `createdBy` is an input — this surface stamps "mcp"
// itself and binds `createdBy` to the mount identity, so provenance (spec §10
// Studio oversight) can't be spoofed by a prompt attributing a blueprint to
// someone else.
const createInputSchema = blueprintCreateBaseSchema.omit({ createdBy: true });

const updateInputSchema = blueprintPatchFieldsSchema
  .extend({ id: z.string().min(1) })
  .refine(
    (body) =>
      Object.entries(body).some(([k, v]) => k !== "id" && v !== undefined),
    { message: "update must set at least one field besides `id`" },
  );

const validateInputSchema = z
  .object({
    graph: z.unknown().optional(),
    id: z.string().min(1).optional(),
  })
  .refine((v) => (v.graph !== undefined) !== (v.id !== undefined), {
    message:
      "provide exactly one of `graph` (validate an unsaved graph) or `id` (re-validate a stored blueprint)",
  });

const idInputSchema = z.object({ id: z.string().min(1) });

const listEventsInputSchema = z.object({
  search: z
    .string()
    .min(1)
    .optional()
    .describe("case-insensitive substring filter on the event name"),
  limit: z.number().int().min(1).max(200).default(100),
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface JourneyBlueprintToolsOptions {
  /** The DI client (or a Pick of db/registry/templates/connectorActionRegistry). */
  container: BlueprintServiceContainer;
  /**
   * Actor label stamped into `journey_blueprints.createdBy` for every create —
   * bind the mounting session's identity here (e.g. an MCP session id or
   * operator email) for Studio's post-hoc oversight. It is NOT a tool input:
   * a model cannot attribute a blueprint to anyone, exactly as `source` is
   * stamped by the surface.
   */
  createdBy?: string;
}

/**
 * Build the journey-blueprint tool set (spec §9). See the module docs for
 * the mounting contract; `Object.values(tools)` gives the array form.
 */
export function createJourneyBlueprintTools(
  options: JourneyBlueprintToolsOptions,
) {
  const { container, createdBy: defaultCreatedBy } = options;

  const create_journey_blueprint = defineTool({
    name: "create_journey_blueprint",
    description:
      "Create a journey blueprint — a lifecycle automation authored as a JSON graph, stored in the database and executed by the generic interpreter (no deploy). " +
      'The blueprint id is the graph\'s journeyId. Defaults to status "draft"; pass status "enabled" to go live immediately (new matching events start enrolling). ' +
      "The graph is fully validated (schema + structure + template/connector registries) BEFORE anything is written — an invalid graph is never saved. " +
      "triggerEvent (+ optional triggerWhere property conditions) decides enrollment; entryLimit is once | once_per_period (with entryPeriod) | unlimited; " +
      "exitOn lists events that abort in-flight runs; suppress is a quiet-period duration ({} disables). " +
      GRAPH_FORMAT +
      " " +
      ISSUE_LOOP_HINT,
    inputSchema: createInputSchema,
    run: async (
      input,
    ): Promise<ToolWriteSuccess | ToolConflict | ToolInvalidGraph> => {
      const result = await createBlueprint({
        container,
        input: {
          ...input,
          source: "mcp",
          // Mount-bound identity always wins — `createdBy` is not a tool input.
          createdBy: defaultCreatedBy,
        },
      });
      if (!result.ok) return result;
      return okWrite(serializeBlueprint(result.blueprint));
    },
  });

  const update_journey_blueprint = defineTool({
    name: "update_journey_blueprint",
    description:
      "Partially update a journey blueprint by id. A `graph` change is re-validated exactly like create and bumps `version` by 1, " +
      "but is REJECTED while the blueprint has any active/waiting enrollment (editing a live graph can desync the durable replay journal " +
      "for a run suspended mid-graph) — wait for enrollments to drain, or disable the blueprint and let them finish, first. " +
      "Metadata-only edits (name, triggerEvent, exitOn, …) don't bump and are never blocked. " +
      "The id is immutable — graph.journeyId must equal `id`. Status cannot be set here: use enable_journey_blueprint / disable_journey_blueprint. " +
      "Nullable fields (description, triggerWhere, entryPeriod, exitOn) accept null to clear. " +
      "A blueprint promoted to code is frozen and rejects every update — the code journey is the source of truth. " +
      GRAPH_FORMAT +
      " " +
      ISSUE_LOOP_HINT,
    inputSchema: updateInputSchema,
    run: async ({
      id,
      ...patch
    }): Promise<
      | ToolWriteSuccess
      | ToolNotFound
      | ToolInvalidGraph
      | ToolInFlight
      | ToolVersionConflict
      | ToolPromoted
    > => {
      const result = await updateBlueprint({ container, id, patch });
      if (!result.ok) return result;
      return okWrite(serializeBlueprint(result.blueprint));
    },
  });

  const validate_journey_blueprint = defineTool({
    name: "validate_journey_blueprint",
    description:
      "Dry-run validation, no write — the iterate-in-a-loop call while authoring. Pass `graph` to validate an unsaved graph, " +
      "or `id` to re-validate a stored blueprint's graph against the CURRENT template/connector registries (useful after registry drift). " +
      "Returns { valid, issues } — a `valid: false` report is a successful call, not an error. Runs the exact checks create/update/enable run. " +
      GRAPH_FORMAT,
    inputSchema: validateInputSchema,
    run: async ({
      graph,
      id,
    }): Promise<
      | { ok: true; valid: boolean; issues: BlueprintValidationIssue[] }
      | ToolNotFound
    > => {
      let target: unknown = graph;
      if (id !== undefined) {
        const row = await findBlueprintRow({ db: container.db, id });
        if (!row) {
          return {
            ok: false,
            code: "not_found",
            error: `Blueprint "${id}" not found`,
          };
        }
        target = row.graph;
      }
      const result = validateBlueprintGraphForSave(target, container);
      return result.valid
        ? { ok: true, valid: true, issues: [] }
        : { ok: true, valid: false, issues: result.issues };
    },
  });

  const list_email_templates = defineTool({
    name: "list_email_templates",
    description:
      "List the registered email template keys — the ONLY values a blueprint send node's meta.template may use " +
      "(a send of an unregistered key is rejected at save time). Returns each template's key, default subject, and category.",
    inputSchema: z.object({}),
    run: async () => {
      const view = container.templates as Record<
        string,
        { defaultSubject?: string; category?: string }
      >;
      const templates = getTemplateNames(container.templates)
        .map((key) => String(key))
        .sort()
        .map((key) => ({
          key,
          defaultSubject: view[key]?.defaultSubject,
          category: view[key]?.category,
        }));
      return { ok: true as const, templates };
    },
  });

  const list_events = defineTool({
    name: "list_events",
    description:
      "Best-effort event-name vocabulary for authoring triggers, waits, and exitOn rules. Event names are an OPEN vocabulary " +
      "(no closed registry exists anywhere in the engine — same as code journeys), so this merges: events actually observed in the " +
      "event store (with occurrence counts, most recently seen first) and events referenced as code-journey or blueprint triggers. " +
      "Any other event name is also valid — it just hasn't been seen yet. Prefer a listed name over inventing a near-duplicate.",
    inputSchema: listEventsInputSchema,
    run: async ({ search, limit }) => {
      type EventEntry = {
        name: string;
        occurrences: number;
        lastSeenAt: string | null;
        usedBy: string[];
      };

      // Observed vocabulary — grouped scan of user_events, recency-first.
      // ilike special chars are escaped so a search of "100%" matches
      // literally instead of becoming a wildcard.
      const escaped = search?.replace(/[\\%_]/g, (m) => `\\${m}`);
      const lastSeen = max(userEvents.occurredAt);
      const observed = await container.db
        .select({
          name: userEvents.event,
          occurrences: count(),
          lastSeenAt: lastSeen,
        })
        .from(userEvents)
        .where(escaped ? ilike(userEvents.event, `%${escaped}%`) : undefined)
        .groupBy(userEvents.event)
        .orderBy(desc(lastSeen))
        .limit(limit);

      const byName = new Map<string, EventEntry>();
      for (const row of observed) {
        byName.set(row.name, {
          name: row.name,
          occurrences: Number(row.occurrences),
          lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
          usedBy: [],
        });
      }

      const matches = (name: string) =>
        !search || name.toLowerCase().includes(search.toLowerCase());
      const entryFor = (name: string): EventEntry => {
        const existing = byName.get(name);
        if (existing) return existing;
        const created: EventEntry = {
          name,
          occurrences: 0,
          lastSeenAt: null,
          usedBy: [],
        };
        byName.set(name, created);
        return created;
      };

      // Declared vocabulary — code-journey triggers (never observed rows if
      // nothing fired yet) and blueprint triggers, labeled by consumer.
      for (const journey of container.registry.getAll()) {
        const event = journey.trigger?.event;
        if (!event || !matches(event)) continue;
        entryFor(event).usedBy.push(`journey:${journey.id}`);
      }
      const blueprintRows = await container.db
        .select({
          id: journeyBlueprints.id,
          triggerEvent: journeyBlueprints.triggerEvent,
          status: journeyBlueprints.status,
        })
        .from(journeyBlueprints);
      for (const bp of blueprintRows) {
        if (!matches(bp.triggerEvent)) continue;
        entryFor(bp.triggerEvent).usedBy.push(
          `blueprint:${bp.id} (${bp.status})`,
        );
      }

      return {
        ok: true as const,
        note:
          "Event names are an open vocabulary — this is observed + declared usage, not a closed registry. " +
          "Reserved namespaces (email.*, journey.*, bucket.*, contact.*) are engine-emitted; don't use them as blueprint trigger events.",
        events: [...byName.values()],
      };
    },
  });

  const enable_journey_blueprint = defineTool({
    name: "enable_journey_blueprint",
    description:
      "Enable a blueprint: new matching events start enrolling on the next ingest. The stored graph is re-validated against the " +
      "CURRENT registries first — a blueprint whose template/connector vanished since save cannot go live (fix it via " +
      "update_journey_blueprint, guided by the returned issues). Idempotent when already enabled. A blueprint promoted to code " +
      "cannot be re-enabled.",
    inputSchema: idInputSchema,
    run: async ({
      id,
    }): Promise<
      ToolWriteSuccess | ToolNotFound | ToolPromoted | ToolInvalidGraph
    > => {
      const result = await enableBlueprint({ container, id });
      if (!result.ok) return result;
      return okWrite(serializeBlueprint(result.blueprint));
    },
  });

  const disable_journey_blueprint = defineTool({
    name: "disable_journey_blueprint",
    description:
      "Disable a blueprint: new enrollments stop on the next event; in-flight runs keep going to completion " +
      "(same semantics as a code journey with enabled: false). Idempotent when already disabled.",
    inputSchema: idInputSchema,
    run: async ({ id }): Promise<ToolWriteSuccess | ToolNotFound> => {
      const result = await disableBlueprint({ container, id });
      if (!result.ok) return result;
      return okWrite(serializeBlueprint(result.blueprint));
    },
  });

  return {
    create_journey_blueprint,
    update_journey_blueprint,
    validate_journey_blueprint,
    list_email_templates,
    list_events,
    enable_journey_blueprint,
    disable_journey_blueprint,
  };
}

export type JourneyBlueprintTools = ReturnType<
  typeof createJourneyBlueprintTools
>;
