import { z } from "zod";
import { conditionEvalSchema } from "../schemas/journey.schema.js";
import type { ConditionEval } from "../types/conditions.js";
import {
  journeyCaptureNodeSchema,
  journeyCheckpointNodeSchema,
  journeyDigestNodeSchema,
  journeyEndNodeSchema,
  journeyGraphSchema,
  journeySleepUntilNodeSchema,
  journeyStartNodeSchema,
  journeyUnknownNodeSchema,
} from "./schema.js";
import type {
  JourneyCheckpointNode,
  JourneyEdge,
  JourneyEndNode,
  JourneyGraph,
  JourneyNode,
  JourneyNodeBase,
  JourneyNodeMetaBase,
  JourneyNodeType,
  JourneySourceLocation,
  JourneyStartNode,
} from "./types.js";

// ---------------------------------------------------------------------------
// Journey Blueprints — the EXECUTION tier of the journey graph IR.
//
// The display tier (`journeyGraphSchema`, types.ts) is deliberately
// best-effort: the AST extractor reverse-engineers graphs out of arbitrary
// `defineJourney` source, so every meta field is optional and `degraded` /
// `warnings` exist to say "this is roughly what the code does". That is fine
// to SHOW a human in Studio; it is not fine to EXECUTE. A blueprint is a
// graph authored as data and run by the generic interpreter task, so this
// module layers the strictness the display tier deliberately omits:
//
//   - per-variant REQUIRED meta (a sleep without a duration cannot run)
//   - zero tolerance for `degraded` / `warnings`
//   - a closed executable node vocabulary (digest/unknown/sleepUntil/capture
//     are real display-tier members but never validate into a blueprint)
//   - structural guarantees (single start, acyclic, all nodes reachable,
//     unambiguous fan-out) the interpreter's tree-walk depends on
//
// Validation happens at SAVE time (admin API / MCP tool), not at 2am
// mid-run — this schema is the sandbox boundary of the whole feature
// (spec §8): nothing outside the vocabulary below is expressible.
// ---------------------------------------------------------------------------

/**
 * Execution-tier duration: the real `DurationObject` keys, strictly. The
 * display tier accepts any `Record<string, number>` (verbatim from source);
 * here an unknown key like `{ days: 3 }` is REJECTED loudly — `durationToMs`
 * ignores unknown keys, so it would otherwise become a silent zero-length
 * sleep at runtime.
 */
export const blueprintDurationSchema = z
  .strictObject({
    hours: z.number().nonnegative().optional(),
    minutes: z.number().nonnegative().optional(),
    seconds: z.number().nonnegative().optional(),
  })
  .refine(
    (d) =>
      d.hours !== undefined ||
      d.minutes !== undefined ||
      d.seconds !== undefined,
    { message: "duration must set at least one of hours/minutes/seconds" },
  );

/** Shared meta flags (mirrors `JourneyNodeMetaBase`). */
const metaBase = { unstable: z.boolean().optional() };

/**
 * `sleep` — `ctx.sleep({ duration, label: node.id })`. Cannot run without
 * the duration, so meta is required here (display tier: fully optional).
 */
export const blueprintSleepNodeSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  subtitle: z.string().optional(),
  line: z.number().optional(),
  type: z.literal("sleep"),
  meta: z.object({ ...metaBase, duration: blueprintDurationSchema }),
});

/**
 * `wait` — `ctx.waitForEvent({ event, timeout, label: node.id })`. Both
 * `event` and `timeout` are required by the runtime API
 * (`WaitForEventOptions.timeout` is not optional), so both are required here.
 */
export const blueprintWaitNodeSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  subtitle: z.string().optional(),
  line: z.number().optional(),
  type: z.literal("wait"),
  meta: z.object({
    ...metaBase,
    event: z.string().min(1),
    timeout: blueprintDurationSchema,
  }),
});

/**
 * `send` — `sendEmail({ template, idempotencyLabel? })`. Template key must be
 * a non-empty string.
 *
 * The registry lookup (is `template` a registered template key?) lives in the
 * engine's admin blueprint routes (`routes/admin/blueprints.ts`,
 * `validateBlueprintGraphForSave`) — the template registry belongs to the
 * engine container / consumer app, not to @hogsend/core.
 */
export const blueprintSendNodeSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  subtitle: z.string().optional(),
  line: z.number().optional(),
  type: z.literal("send"),
  meta: z.object({
    ...metaBase,
    template: z.string().min(1),
    idempotencyLabel: z.string().min(1).optional(),
  }),
});

/**
 * `connector` — `sendConnectorAction({ connectorId, action })`.
 *
 * The registry lookup (`connectorId`/`action` registered?) lives in the
 * engine's admin blueprint routes (same registry situation as
 * `send.meta.template` above).
 */
export const blueprintConnectorNodeSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  subtitle: z.string().optional(),
  line: z.number().optional(),
  type: z.literal("connector"),
  meta: z.object({
    ...metaBase,
    connectorId: z.string().min(1),
    action: z.string().min(1),
  }),
});

/** `trigger` — `ctx.trigger({ event })`. The event name is the whole point. */
export const blueprintTriggerNodeSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  subtitle: z.string().optional(),
  line: z.number().optional(),
  type: z.literal("trigger"),
  meta: z.object({ ...metaBase, event: z.string().min(1) }),
});

/**
 * `branch`/`decision` — the interpreter picks the outgoing
 * `conditional-true`/`conditional-false` edge by evaluating `conditions`
 * against the REAL condition vocabulary (`conditionEvalSchema` — the same
 * recursive schema `trigger.where`/`exitOn`/buckets use; reused, not
 * re-derived). Required and non-empty: a decision with nothing to evaluate
 * cannot pick an edge.
 */
export const blueprintDecisionNodeSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  subtitle: z.string().optional(),
  line: z.number().optional(),
  type: z.literal(["branch", "decision"]),
  meta: z.object({
    ...metaBase,
    conditions: z.array(conditionEvalSchema).min(1),
  }),
});

/**
 * The blueprint node schema. Executable variants are strict (required meta);
 * `start` / `checkpoint` / `end-*` reuse the display schemas unchanged (they
 * are executable with no extra meta — `checkpoint` uses the node id as its
 * label, `start`'s conditions are display chips: the REAL trigger lives on
 * the `journey_blueprints` row, spec §4/§7).
 *
 * `digest`, `unknown`, `sleepUntil` and `capture` are DELIBERATELY kept in
 * this union as their permissive display-tier schemas even though a blueprint
 * must never contain them: parsing them structurally and then rejecting them
 * in `findNonExecutableNodes` produces a named, structured issue
 * ("node X: digest nodes are not supported…") instead of Zod's opaque
 * invalid-discriminator error. This is defense-in-depth, not an oversight —
 * they are real members of `JourneyNodeType` the display tier needs, and the
 * execution tier must always refuse them (spec §7/§13).
 */
export const blueprintNodeSchema = z.discriminatedUnion("type", [
  journeyStartNodeSchema,
  blueprintSleepNodeSchema,
  journeySleepUntilNodeSchema,
  blueprintWaitNodeSchema,
  journeyDigestNodeSchema,
  blueprintSendNodeSchema,
  blueprintConnectorNodeSchema,
  journeyCheckpointNodeSchema,
  blueprintTriggerNodeSchema,
  journeyCaptureNodeSchema,
  blueprintDecisionNodeSchema,
  journeyEndNodeSchema,
  journeyUnknownNodeSchema,
]);

/**
 * Field-shape schema for a blueprint graph — the display `journeyGraphSchema`
 * narrowed to the execution tier:
 *
 *   - nodes validated per the strict variants above
 *   - `degraded` must be false/absent — an execution-tier graph is never
 *     "best effort"
 *   - `warnings` must be empty/absent — zero tolerance, a warning means
 *     "don't run it"
 *
 * NOTE: this schema covers FIELD requirements only. Structural rules
 * (single start, acyclic, reachability, fan-out, non-executable node types)
 * live in the plain check functions below so the interpreter and tests can
 * reuse them — always validate through {@link validateBlueprintGraph}, which
 * composes both layers into structured issues.
 */
export const blueprintGraphSchema = journeyGraphSchema.extend({
  journeyId: z.string().min(1),
  nodes: z.array(blueprintNodeSchema),
  degraded: z.literal(false).optional(),
  warnings: z.array(z.string()).max(0).optional(),
});

// ---------------------------------------------------------------------------
// Execution-tier TS types. Hand-authored (not z.infer) so each variant
// narrows its display-tier counterpart — required meta instead of optional —
// while staying ASSIGNABLE to it: `BlueprintGraph extends JourneyGraph`
// is compile-asserted below, which is what makes Studio's flow view render a
// blueprint with zero new code (spec §3). Durations stay typed as the
// display-compatible `Record<string, number>`; the runtime schema
// (`blueprintDurationSchema`) guarantees the keys are real `DurationObject`
// keys (hours/minutes/seconds).
// ---------------------------------------------------------------------------

/** Node types that can appear in a saved blueprint. */
export type BlueprintNodeType = Exclude<
  JourneyNodeType,
  "digest" | "unknown" | "sleepUntil" | "capture"
>;

export interface BlueprintSleepNode extends JourneyNodeBase {
  type: "sleep";
  meta: JourneyNodeMetaBase & { duration: Record<string, number> };
}

export interface BlueprintWaitNode extends JourneyNodeBase {
  type: "wait";
  meta: JourneyNodeMetaBase & {
    event: string;
    timeout: Record<string, number>;
  };
}

export interface BlueprintSendNode extends JourneyNodeBase {
  type: "send";
  meta: JourneyNodeMetaBase & { template: string; idempotencyLabel?: string };
}

export interface BlueprintConnectorNode extends JourneyNodeBase {
  type: "connector";
  meta: JourneyNodeMetaBase & { connectorId: string; action: string };
}

export interface BlueprintTriggerNode extends JourneyNodeBase {
  type: "trigger";
  meta: JourneyNodeMetaBase & { event: string };
}

export interface BlueprintDecisionNode extends JourneyNodeBase {
  type: "branch" | "decision";
  meta: JourneyNodeMetaBase & { conditions: ConditionEval[] };
}

/**
 * A node in a validated blueprint — the executable subset of
 * {@link JourneyNode}, with per-variant required meta. A `switch (node.type)`
 * over this union in the interpreter gets compiler-enforced exhaustiveness
 * over exactly the executable vocabulary.
 */
export type BlueprintNode =
  | JourneyStartNode
  | BlueprintSleepNode
  | BlueprintWaitNode
  | BlueprintSendNode
  | BlueprintConnectorNode
  | JourneyCheckpointNode
  | BlueprintTriggerNode
  | BlueprintDecisionNode
  | JourneyEndNode;

/** A validated, executable journey blueprint graph. */
export interface BlueprintGraph {
  journeyId: string;
  source?: JourneySourceLocation;
  nodes: BlueprintNode[];
  edges: JourneyEdge[];
  /** Never true — kept in the shape only so the display type stays a supertype. */
  degraded?: false;
  /** Always empty — zero tolerance at the execution tier. */
  warnings?: string[];
}

// Compile-time cross-checks: the execution tier is a strict NARROWING of the
// display tier, never a divergence — a BlueprintGraph is always a valid
// JourneyGraph (Studio, the graph admin route, and dagre layout consume it
// unchanged), and BlueprintNodeType stays inside JourneyNodeType.
type _AssertBlueprintNode = [BlueprintNode] extends [JourneyNode]
  ? true
  : never;
type _AssertBlueprintGraph = [BlueprintGraph] extends [JourneyGraph]
  ? true
  : never;
type _AssertBlueprintNodeType = [BlueprintNodeType] extends [JourneyNodeType]
  ? true
  : never;
const _assertBlueprintNode: _AssertBlueprintNode = true;
const _assertBlueprintGraph: _AssertBlueprintGraph = true;
const _assertBlueprintNodeType: _AssertBlueprintNodeType = true;
void _assertBlueprintNode;
void _assertBlueprintGraph;
void _assertBlueprintNodeType;

// ---------------------------------------------------------------------------
// Structured validation result — what the admin `/validate` route and the MCP
// tool hand straight to a caller (spec §7). Every issue names the offending
// node/edge; never a raw Zod error or a caught exception's `.message`.
// ---------------------------------------------------------------------------

export type BlueprintValidationIssue = {
  nodeId?: string;
  edgeId?: string;
  path: (string | number)[];
  code: string;
  message: string;
};

export type BlueprintValidationResult =
  | { valid: true; graph: BlueprintGraph }
  | { valid: false; issues: BlueprintValidationIssue[] };

/**
 * The minimal structural view the graph checks below need. Both the display
 * `JourneyGraph` and a parsed blueprint satisfy it, so the interpreter and
 * tests can reuse the checks on either tier.
 */
export interface JourneyGraphLike {
  nodes: ReadonlyArray<{ id: string; type: string }>;
  edges: ReadonlyArray<{
    id: string;
    source: string;
    target: string;
    kind?: string;
  }>;
}

/**
 * Display-tier node types that must never validate into a blueprint, with
 * the reason surfaced to the author. Deliberate defense-in-depth (spec
 * §7/§13): these are real `JourneyNodeType` members the display tier needs,
 * but the execution tier refuses them outright.
 */
const NON_EXECUTABLE_NODE_TYPES: Readonly<Record<string, string>> = {
  digest: "digest nodes are not supported in blueprints (v1)",
  unknown: "unknown nodes are not executable",
  // The graph IR carries no static wake instant for sleepUntil (the instant
  // is dynamic in code journeys) and no event payload for capture (which is
  // also not replay-safe) — neither can execute until the vocabulary grows
  // the meta they need. TODO(phase 2): revisit if/when an instant spec /
  // capture payload is added to the IR.
  sleepUntil:
    "sleepUntil nodes are not executable in blueprints (v1) — the graph carries no static wake instant",
  capture:
    "capture nodes are not executable in blueprints (v1) — the graph carries no event payload and capture is not replay-safe",
};

/** Reject node types outside the executable vocabulary, by name. */
export function findNonExecutableNodes(
  graph: JourneyGraphLike,
): BlueprintValidationIssue[] {
  const issues: BlueprintValidationIssue[] = [];
  graph.nodes.forEach((node, index) => {
    const reason = NON_EXECUTABLE_NODE_TYPES[node.type];
    if (reason) {
      issues.push({
        nodeId: node.id,
        path: ["nodes", index, "type"],
        code: "unsupported_node_type",
        message: `node "${node.id}": ${reason}`,
      });
    }
  });
  return issues;
}

/** Node and edge ids must be unique — edges reference nodes by id. */
export function findDuplicateIds(
  graph: JourneyGraphLike,
): BlueprintValidationIssue[] {
  const issues: BlueprintValidationIssue[] = [];
  const seenNodes = new Set<string>();
  graph.nodes.forEach((node, index) => {
    if (seenNodes.has(node.id)) {
      issues.push({
        nodeId: node.id,
        path: ["nodes", index, "id"],
        code: "duplicate_node_id",
        message: `node "${node.id}": id is used by more than one node`,
      });
    }
    seenNodes.add(node.id);
  });
  const seenEdges = new Set<string>();
  graph.edges.forEach((edge, index) => {
    if (seenEdges.has(edge.id)) {
      issues.push({
        edgeId: edge.id,
        path: ["edges", index, "id"],
        code: "duplicate_edge_id",
        message: `edge "${edge.id}": id is used by more than one edge`,
      });
    }
    seenEdges.add(edge.id);
  });
  return issues;
}

/** Every edge must connect two existing nodes. */
export function findInvalidEdgeEndpoints(
  graph: JourneyGraphLike,
): BlueprintValidationIssue[] {
  const issues: BlueprintValidationIssue[] = [];
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  graph.edges.forEach((edge, index) => {
    if (!nodeIds.has(edge.source)) {
      issues.push({
        edgeId: edge.id,
        path: ["edges", index, "source"],
        code: "unknown_edge_source",
        message: `edge "${edge.id}": source "${edge.source}" is not a node id`,
      });
    }
    if (!nodeIds.has(edge.target)) {
      issues.push({
        edgeId: edge.id,
        path: ["edges", index, "target"],
        code: "unknown_edge_target",
        message: `edge "${edge.id}": target "${edge.target}" is not a node id`,
      });
    }
  });
  return issues;
}

/** A blueprint needs exactly one entry point. */
export function findStartNodeIssues(
  graph: JourneyGraphLike,
): BlueprintValidationIssue[] {
  const starts = graph.nodes.filter((node) => node.type === "start");
  if (starts.length === 0) {
    return [
      {
        path: ["nodes"],
        code: "missing_start_node",
        message: "graph has no start node — a blueprint needs exactly one",
      },
    ];
  }
  return starts.slice(1).map((node) => ({
    nodeId: node.id,
    path: ["nodes"],
    code: "multiple_start_nodes",
    message: `node "${node.id}": a blueprint has exactly one start node`,
  }));
}

/**
 * Fan-out must be unambiguous for the interpreter's tree-walk:
 *   - `branch`/`decision`: exactly one conditional-true + one
 *     conditional-false outgoing edge (binary decisions only in v1, spec §13)
 *   - `wait`: at most one outgoing edge, OR an answered/timedOut pair
 *   - `end-*`: terminal, no outgoing edges
 *   - everything else: at most one outgoing edge — only decisions and waits
 *     fork
 */
export function findOutgoingEdgeIssues(
  graph: JourneyGraphLike,
): BlueprintValidationIssue[] {
  const issues: BlueprintValidationIssue[] = [];
  graph.nodes.forEach((node, index) => {
    if (Object.hasOwn(NON_EXECUTABLE_NODE_TYPES, node.type)) return; // rejected elsewhere
    const out = graph.edges.filter((edge) => edge.source === node.id);
    if (node.type === "branch" || node.type === "decision") {
      const trueEdges = out.filter((e) => e.kind === "conditional-true");
      const falseEdges = out.filter((e) => e.kind === "conditional-false");
      if (
        out.length !== 2 ||
        trueEdges.length !== 1 ||
        falseEdges.length !== 1
      ) {
        issues.push({
          nodeId: node.id,
          path: ["nodes", index],
          code: "invalid_decision_edges",
          message: `node "${node.id}": a ${node.type} node needs exactly one conditional-true and one conditional-false outgoing edge (found ${out.length} outgoing: ${trueEdges.length} true, ${falseEdges.length} false)`,
        });
      }
    } else if (node.type === "wait") {
      const answered = out.filter((e) => e.kind === "answered");
      const timedOut = out.filter((e) => e.kind === "timedOut");
      const validPair =
        out.length === 2 && answered.length === 1 && timedOut.length === 1;
      if (out.length > 1 && !validPair) {
        issues.push({
          nodeId: node.id,
          path: ["nodes", index],
          code: "invalid_wait_edges",
          message: `node "${node.id}": a wait node forks into exactly one answered and one timedOut edge (or a single unconditional edge) — found ${out.length} outgoing`,
        });
      }
    } else if (node.type.startsWith("end-")) {
      if (out.length > 0) {
        issues.push({
          nodeId: node.id,
          path: ["nodes", index],
          code: "terminal_node_has_outgoing_edges",
          message: `node "${node.id}": terminal ${node.type} node cannot have outgoing edges`,
        });
      }
    } else if (out.length > 1) {
      issues.push({
        nodeId: node.id,
        path: ["nodes", index],
        code: "ambiguous_fan_out",
        message: `node "${node.id}": a ${node.type} node can have at most one outgoing edge (found ${out.length}) — only decision and wait nodes fork`,
      });
    }
  });
  return issues;
}

/**
 * Blueprints must be acyclic (v1 has no loop nodes, spec §13). Reports the
 * specific back edge that closes each cycle. Edges pointing at unknown nodes
 * are skipped — `findInvalidEdgeEndpoints` owns those.
 */
export function findCycles(
  graph: JourneyGraphLike,
): BlueprintValidationIssue[] {
  const issues: BlueprintValidationIssue[] = [];
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const outgoing = new Map<
    string,
    Array<{ edge: JourneyGraphLike["edges"][number]; index: number }>
  >();
  graph.edges.forEach((edge, index) => {
    const list = outgoing.get(edge.source) ?? [];
    list.push({ edge, index });
    outgoing.set(edge.source, list);
  });
  // DFS colors: absent = unvisited, "active" = on the current path (a hit
  // means a back edge → cycle), "done" = fully explored.
  const state = new Map<string, "active" | "done">();
  const visit = (id: string): void => {
    state.set(id, "active");
    for (const { edge, index } of outgoing.get(id) ?? []) {
      if (!nodeIds.has(edge.target)) continue;
      const targetState = state.get(edge.target);
      if (targetState === "active") {
        issues.push({
          edgeId: edge.id,
          path: ["edges", index],
          code: "cyclic_graph",
          message: `edge "${edge.id}" (${edge.source} → ${edge.target}) creates a cycle — blueprint graphs must be acyclic`,
        });
      } else if (targetState === undefined) {
        visit(edge.target);
      }
    }
    state.set(id, "done");
  };
  for (const node of graph.nodes) {
    if (!state.has(node.id)) visit(node.id);
  }
  return issues;
}

/**
 * Every non-start node must be reachable from the start node — an island the
 * interpreter can never walk to is dead weight at best, a typo'd edge at
 * worst. When there is no start node at all this returns nothing;
 * `findStartNodeIssues` owns that case (avoids flooding every node with an
 * unreachable issue on top).
 */
export function findUnreachableNodes(
  graph: JourneyGraphLike,
): BlueprintValidationIssue[] {
  const starts = graph.nodes.filter((node) => node.type === "start");
  if (starts.length === 0) return [];
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge.target);
    outgoing.set(edge.source, list);
  }
  const reachable = new Set<string>(starts.map((node) => node.id));
  const queue = [...reachable];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const target of outgoing.get(current) ?? []) {
      if (!reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
  }
  const issues: BlueprintValidationIssue[] = [];
  graph.nodes.forEach((node, index) => {
    if (!reachable.has(node.id)) {
      issues.push({
        nodeId: node.id,
        path: ["nodes", index],
        code: "unreachable_node",
        message: `node "${node.id}": not reachable from the start node`,
      });
    }
  });
  return issues;
}

/** Best-effort id lookup in the RAW input for pointing Zod issues at a node/edge. */
function idAtIndex(
  input: unknown,
  key: "nodes" | "edges",
  index: number,
): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const collection = (input as Record<string, unknown>)[key];
  if (!Array.isArray(collection)) return undefined;
  const item: unknown = collection[index];
  if (typeof item !== "object" || item === null) return undefined;
  const id = (item as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
}

/** Map one Zod issue into the structured shape, naming the node/edge it hits. */
function issueFromZod(
  issue: z.core.$ZodIssue,
  input: unknown,
): BlueprintValidationIssue {
  const path = issue.path.filter(
    (segment): segment is string | number =>
      typeof segment === "string" || typeof segment === "number",
  );
  let nodeId: string | undefined;
  let edgeId: string | undefined;
  if (path[0] === "nodes" && typeof path[1] === "number") {
    nodeId = idAtIndex(input, "nodes", path[1]);
  } else if (path[0] === "edges" && typeof path[1] === "number") {
    edgeId = idAtIndex(input, "edges", path[1]);
  }
  let code: string = issue.code ?? "invalid";
  let message = issue.message;
  if (path[0] === "degraded") {
    code = "degraded_graph";
    message =
      "a blueprint is never best-effort — degraded graphs are display-only and cannot be executed";
  } else if (path[0] === "warnings") {
    code = "graph_has_warnings";
    message =
      "a blueprint must have no warnings — a warning means the graph is not safe to execute";
  } else if (nodeId !== undefined) {
    message = `node "${nodeId}": ${message}`;
  } else if (edgeId !== undefined) {
    message = `edge "${edgeId}": ${message}`;
  }
  return { nodeId, edgeId, path, code, message };
}

/**
 * Validate an untrusted graph into an executable {@link BlueprintGraph}.
 *
 * Two layers, both mapped into structured {@link BlueprintValidationIssue}s:
 *  1. `blueprintGraphSchema` — field shapes (required per-variant meta, zero
 *     tolerance for degraded/warnings)
 *  2. the structural checks — executable vocabulary, unique ids, edge
 *     endpoints, single start, unambiguous fan-out, acyclic, reachability
 *
 * This is the save-time sandbox boundary (spec §8): the admin API and the
 * MCP tool surface the issue list verbatim so an authoring agent gets an
 * itemized "what's wrong and where", never a caught exception's message.
 */
export function validateBlueprintGraph(
  graph: unknown,
): BlueprintValidationResult {
  const parsed = blueprintGraphSchema.safeParse(graph);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((issue) => issueFromZod(issue, graph)),
    };
  }
  const issues: BlueprintValidationIssue[] = [
    ...findNonExecutableNodes(parsed.data),
    ...findDuplicateIds(parsed.data),
    ...findInvalidEdgeEndpoints(parsed.data),
    ...findStartNodeIssues(parsed.data),
    ...findOutgoingEdgeIssues(parsed.data),
    ...findCycles(parsed.data),
    ...findUnreachableNodes(parsed.data),
  ];
  if (issues.length > 0) return { valid: false, issues };
  // Sound by construction: the schema enforced per-variant required meta and
  // findNonExecutableNodes rejected every non-executable variant, so the
  // remaining nodes are exactly the BlueprintNode union. The double cast
  // bridges the zod-inferred duration objects ({ hours?: number; ... }) to
  // the display-compatible Record<string, number> the hand types use.
  return { valid: true, graph: parsed.data as unknown as BlueprintGraph };
}
