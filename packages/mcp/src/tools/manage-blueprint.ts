/**
 * `manage_blueprint` — the agent-facing authoring surface for Journey
 * Blueprints, wrapping the admin REST API (`POST/PATCH /v1/admin/blueprints`
 * + `/validate` + `/enable` + `/disable`) through the {@link AdminClient}.
 *
 * A single tool with an `action` dispatcher (create | update | validate |
 * enable | disable) rather than five tools — the consolidation the plan calls
 * for. Provenance (`source: "mcp"`) is stamped by THIS surface on create, never
 * taken from tool input. There is deliberately NO `promote` action: the promote
 * API route only stamps the DB, while codegen/git lives in the CLI, so an agent
 * that called bare `promote` would freeze a blueprint with no code artifact —
 * use `hogsend blueprints promote` instead.
 *
 * Expected failures come back as discriminated `{ ok: false, code, ... }`
 * results (ported from `blueprint-tools.ts`): `invalid_input` for bad args,
 * `invalid_graph` (a 422, carrying the route's structured `issues[]`),
 * `not_found`, `conflict`/`in_flight`/`promoted` (409s), `unauthorized`/
 * `forbidden`, `unreachable`. Never a throw for an expected outcome.
 */
// Import the authoring-guide constants from the engine's env-free LEAF module,
// NOT the barrel — the barrel eagerly validates the engine's server env, which
// the standalone stdio bin (a client machine) does not have. The blueprint
// FIELD validation is authoritative on the server (the admin route re-validates
// every write), so this surface only does lightweight per-action requirement
// checks locally for a clean `invalid_input`.
import {
  GRAPH_FORMAT,
  ISSUE_LOOP_HINT,
} from "@hogsend/engine/mcp/authoring-guide";
import { z } from "zod";
import type { AdminClient } from "../lib/admin-client.js";
import { mapHttpError, requirement } from "../lib/result.js";
import { defineTool, type McpTool } from "../lib/tool.js";

const NAME = "manage_blueprint";

// A duration mirrors the execution-tier `{ hours?, minutes?, seconds? }` shape.
// STRICT keys locally so a `{ days: 7 }` typo is rejected HERE with a named
// issue — otherwise it would be silently stripped to `{}` (the engine's
// "suppression disabled" sentinel) and never reach the server's own strict
// check.
const durationSchema = z.strictObject({
  hours: z.number().nonnegative().optional(),
  minutes: z.number().nonnegative().optional(),
  seconds: z.number().nonnegative().optional(),
});

// A property condition (triggerWhere / exitOn[].where). STRICT, so a malformed
// condition is rejected locally instead of hitting an opaque server 400. The
// `type: "property"` discriminant is REQUIRED (the engine's
// propertyConditionSchema mandates it); `operator` stays a plain string so the
// server remains authoritative on the operator vocabulary.
const propertyConditionsSchema = z.array(
  z.strictObject({
    type: z.literal("property"),
    property: z.string().min(1),
    operator: z.string().min(1),
    value: z.unknown().optional(),
  }),
);

/**
 * The wire raw shape — every field optional except `action`, because the SDK
 * validates against this ONE shape for every action. Per-action requirements
 * (create needs name/triggerEvent/entryLimit/suppress/graph; update needs
 * id + a field; validate needs exactly one of graph/id; enable/disable need
 * id) are enforced in the handler as lightweight presence checks; the admin
 * route is the authoritative validator for every write.
 */
const manageBlueprintShape = {
  action: z
    .enum(["create", "update", "validate", "enable", "disable"])
    .describe(
      "create (new draft/enabled blueprint) · update (patch fields by id) · " +
        "validate (dry-run a graph or a stored blueprint, no write) · " +
        "enable · disable.",
    ),
  id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The blueprint id (= the graph's journeyId). Required for update, " +
        "enable, disable, and validate-by-id.",
    ),
  name: z
    .string()
    .min(1)
    .optional()
    .describe("Human-readable name (create/update)."),
  description: z.string().nullable().optional(),
  status: z
    .enum(["draft", "enabled"])
    .optional()
    .describe(
      "Create-only. Defaults to draft; pass enabled to go live immediately. " +
        "After create, use the enable/disable actions — not update.",
    ),
  triggerEvent: z
    .string()
    .min(1)
    .optional()
    .describe("The event name that enrolls users (create/update)."),
  triggerWhere: propertyConditionsSchema
    .nullable()
    .optional()
    .describe(
      "Property conditions the trigger event must satisfy (null clears on update).",
    ),
  entryLimit: z
    .enum(["once", "once_per_period", "unlimited"])
    .optional()
    .describe("Pair once_per_period with entryPeriod."),
  entryPeriod: durationSchema.nullable().optional(),
  exitOn: z
    .array(
      z.object({
        event: z.string().min(1),
        where: propertyConditionsSchema.optional(),
      }),
    )
    .nullable()
    .optional()
    .describe("Events that abort in-flight runs (null clears on update)."),
  suppress: durationSchema
    .optional()
    .describe(
      "Quiet-period after a completed run; {} disables (required on create).",
    ),
  graph: z
    .unknown()
    .optional()
    .describe(
      "The JSON journey graph { journeyId, nodes[], edges[] } (create/update/validate).",
    ),
} satisfies z.ZodRawShape;

const description =
  "Author and operate Journey Blueprints — lifecycle automations authored as a " +
  "JSON graph, stored in the DB and run by the generic interpreter (no deploy). " +
  "One tool, dispatched by `action`. Per action: create needs name, triggerEvent, " +
  "entryLimit, suppress and graph (source is stamped mcp automatically; status " +
  "defaults draft, pass enabled to go live); update needs id plus one changed " +
  "field (status transitions go through enable/disable, NOT update; a graph edit " +
  "is blocked while enrollments are active/waiting, and a promoted blueprint is " +
  "frozen); validate needs exactly one of graph (unsaved) or id (stored) and " +
  "always returns { valid, issues } (valid:false is success, not an error); " +
  "enable/disable need only id. There is NO promote action — promoting to code is " +
  "the `hogsend blueprints promote` CLI (it generates the code artifact). " +
  "Full vocabulary: read the hogsend://blueprint-authoring-guide resource. " +
  GRAPH_FORMAT +
  " " +
  ISSUE_LOOP_HINT;

type Rest = Omit<
  z.output<z.ZodObject<typeof manageBlueprintShape>>,
  "action" | "id"
>;

/** Fields the create route requires (the server re-validates them strictly). */
const CREATE_REQUIRED = [
  "name",
  "triggerEvent",
  "entryLimit",
  "suppress",
  "graph",
] as const satisfies readonly (keyof Rest)[];

async function runCreate(client: AdminClient, rest: Rest) {
  const missing = CREATE_REQUIRED.filter((k) => rest[k] === undefined);
  if (missing.length > 0) {
    return requirement(NAME, `create requires: ${missing.join(", ")}`);
  }
  // On create, `null` is NOT a "clear" — the create route rejects null-valued
  // optionals. Drop them (null ≡ omitted here); null pass-through stays on
  // update, where it genuinely clears a stored field.
  const body = Object.fromEntries(
    Object.entries(rest).filter(([, v]) => v !== null && v !== undefined),
  );
  try {
    // Provenance is stamped HERE — never trusted from tool input (spec §10).
    const res = await client.post<{ blueprint: unknown }>(
      "/v1/admin/blueprints",
      { ...body, source: "mcp" },
    );
    return { ok: true as const, blueprint: res.blueprint };
  } catch (err) {
    return mapHttpError(err);
  }
}

async function runUpdate(
  client: AdminClient,
  id: string | undefined,
  rest: Rest,
) {
  if (!id) return requirement(NAME, "update requires `id`");
  // `status` is not patchable. REJECT it loudly rather than silently dropping
  // it — an agent passing status:"enabled" here must not believe the blueprint
  // went live (it wouldn't have).
  if (rest.status !== undefined) {
    return requirement(
      NAME,
      'status cannot be changed via update — use action="enable" or action="disable"',
    );
  }
  const patch = Object.fromEntries(
    Object.entries(rest).filter(([, v]) => v !== undefined),
  );
  if (Object.keys(patch).length === 0) {
    return requirement(NAME, "update must set at least one field besides `id`");
  }
  try {
    const res = await client.patch<{ blueprint: unknown }>(
      `/v1/admin/blueprints/${encodeURIComponent(id)}`,
      patch,
    );
    return { ok: true as const, blueprint: res.blueprint };
  } catch (err) {
    return mapHttpError(err);
  }
}

async function runValidate(
  client: AdminClient,
  id: string | undefined,
  graph: unknown,
) {
  const hasGraph = graph !== undefined;
  const hasId = id !== undefined;
  if (hasGraph === hasId) {
    return requirement(
      NAME,
      "validate needs exactly one of `graph` (an unsaved graph) or `id` (a stored blueprint)",
    );
  }
  try {
    const res = hasGraph
      ? await client.post<{ valid: boolean; issues: unknown[] }>(
          "/v1/admin/blueprints/validate",
          { graph },
        )
      : await client.post<{ valid: boolean; issues: unknown[] }>(
          `/v1/admin/blueprints/${encodeURIComponent(id as string)}/validate`,
        );
    return { ok: true as const, valid: res.valid, issues: res.issues };
  } catch (err) {
    return mapHttpError(err);
  }
}

async function runLifecycle(
  client: AdminClient,
  id: string | undefined,
  action: "enable" | "disable",
) {
  if (!id) return requirement(NAME, `${action} requires \`id\``);
  try {
    const res = await client.post<{ blueprint: unknown }>(
      `/v1/admin/blueprints/${encodeURIComponent(id)}/${action}`,
    );
    return { ok: true as const, blueprint: res.blueprint };
  } catch (err) {
    return mapHttpError(err);
  }
}

/** Build the `manage_blueprint` tool bound to an {@link AdminClient}. */
export function createManageBlueprintTool(
  client: AdminClient,
): McpTool<typeof manageBlueprintShape> {
  return defineTool({
    name: NAME,
    description,
    inputSchema: manageBlueprintShape,
    run: async ({ action, id, ...rest }) => {
      switch (action) {
        case "create":
          return runCreate(client, rest);
        case "update":
          return runUpdate(client, id, rest);
        case "validate":
          return runValidate(client, id, rest.graph);
        case "enable":
          return runLifecycle(client, id, "enable");
        case "disable":
          return runLifecycle(client, id, "disable");
      }
    },
  });
}
