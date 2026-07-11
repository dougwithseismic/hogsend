/**
 * Blueprint → code journey generation — the pure codegen half of
 * "promote to code" (`hogsend blueprints promote`).
 *
 * Takes a Journey Blueprint's row data (the flat serialized shape the admin
 * API returns) and generates the source of a real `defineJourney()`
 * TypeScript file: the graph's linear spine becomes sequential `await`
 * statements, `branch`/`decision` nodes become `if`/`else`, and a `wait`
 * node with divergent `answered`/`timedOut` edges becomes a `.timedOut`
 * fork. Pure string-in/string-out: no filesystem, no formatting — the CLI
 * command that calls this owns file writing, Biome formatting, and the
 * `promoteBlueprint()` DB transition.
 *
 * v1 scope decisions (deliberate, not oversights):
 *  - event names and template keys are emitted as literal double-quoted
 *    strings — no reverse-matching against a consumer's `Events`/`Templates`
 *    constants
 *  - durations are emitted as literal objects (`{ hours: 48 }`), never via
 *    the `hours()`/`days()` helpers — the literal is exactly what the
 *    blueprint row stores, so it is always correct
 *  - only `EventCondition` decisions compile to real code; every other
 *    condition type compiles to a loud `false` stub with an inline
 *    TODO(promote-to-code) block comment that still type-checks (the
 *    never-true branch) and carries the raw condition JSON for a human to
 *    port
 */
// NOTE: these types canonically live in @hogsend/core, but @hogsend/core is
// not a direct dependency of this package — @hogsend/engine (which is)
// re-exports the full core barrel, so we import through it.
import type {
  BlueprintGraph,
  BlueprintNode,
  ConditionEval,
  EventCondition,
  JourneyEdge,
  PropertyCondition,
} from "@hogsend/engine";

/**
 * The blueprint fields codegen needs — structurally matches the engine's
 * `SerializedBlueprint` (lib/blueprints.ts) minus the columns codegen has no
 * use for (status, version, provenance, timestamps). Defined locally so the
 * CLI does not deep-import a non-barrel engine internal.
 */
export interface CodegenBlueprintInput {
  id: string;
  name: string;
  description: string | null;
  triggerEvent: string;
  triggerWhere: PropertyCondition[] | null;
  entryLimit: "once" | "once_per_period" | "unlimited";
  entryPeriod: { hours?: number; minutes?: number; seconds?: number } | null;
  exitOn: Array<{ event: string; where?: PropertyCondition[] }> | null;
  suppress: { hours?: number; minutes?: number; seconds?: number };
  graph: BlueprintGraph;
}

export interface GenerateJourneyFileOptions {
  /** The id of the generated code journey (`meta.id`, export name). */
  journeyId: string;
}

/** One compiled decision condition — an inline expression plus any TODO comment lines. */
export interface CompiledCondition {
  /**
   * Inline boolean expression (may contain `await` — only valid inside the
   * async `run` body).
   */
  expression: string;
  /**
   * `//` comment lines to emit above the statement that embeds
   * {@link expression} (raw JSON for TODO-stubbed condition types).
   */
  comments: string[];
}

const INDENT = "  ";
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const DURATION_KEYS = ["hours", "minutes", "seconds"] as const;

/**
 * Structural duration shape — matches both `DurationObject` (an interface,
 * so NOT assignable to `Record<string, number>`) and the graph tier's
 * `Record<string, number>` durations.
 */
interface DurationInput {
  readonly hours?: number;
  readonly minutes?: number;
  readonly seconds?: number;
}

/** JS comparison for `EventCondition.operator`. */
const COUNT_OPERATORS: Record<
  NonNullable<EventCondition["operator"]>,
  string
> = {
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  eq: "===",
};

/** Double-quoted TS string literal. */
function str(value: string): string {
  return JSON.stringify(value);
}

/**
 * A duration object literal with canonical key order — `{ hours: 48 }`,
 * `{ hours: 1, minutes: 30 }`, or `{}` (a zero/disabled duration).
 */
function durationLiteral(duration: DurationInput): string {
  const parts: string[] = [];
  for (const key of DURATION_KEYS) {
    const value = duration[key];
    if (value !== undefined) parts.push(`${key}: ${value}`);
  }
  return parts.length === 0 ? "{}" : `{ ${parts.join(", ")} }`;
}

/**
 * Render plain JSON-ish data (conditions, exitOn rules) as a compact
 * single-line TS literal. `undefined` object entries are omitted.
 */
function tsLiteral(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return str(value);
    case "number":
    case "boolean":
      return String(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => tsLiteral(item)).join(", ")}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(
          ([k, v]) => `${IDENTIFIER_RE.test(k) ? k : str(k)}: ${tsLiteral(v)}`,
        );
      return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
    }
    default:
      throw new Error(
        `blueprint codegen: cannot emit a ${typeof value} value as a TS literal`,
      );
  }
}

/**
 * `"send-nudge"` → `"sendNudge"`; always a valid identifier. Exported — the
 * `blueprints promote` CLI command needs the EXACT same naming to register
 * the generated export in `src/journeys/index.ts`; importing this instead of
 * re-implementing it means the two can never drift.
 */
export function camelCase(id: string): string {
  const parts = id.split(/[^A-Za-z0-9]+/).filter((part) => part.length > 0);
  const joined = parts
    .map((part, index) =>
      index === 0
        ? part.charAt(0).toLowerCase() + part.slice(1)
        : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join("");
  const name = joined.length === 0 ? "generated" : joined;
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

/** camelCase(base), de-duplicated against names already handed out. */
function uniqueVarName(base: string, used: Set<string>): string {
  const candidate = camelCase(base);
  let name = candidate;
  for (let suffix = 2; used.has(name); suffix += 1) {
    name = `${candidate}${suffix}`;
  }
  used.add(name);
  return name;
}

/**
 * Compile ONE decision condition to an inline boolean expression.
 *
 * `EventCondition` is fully supported (`ctx.history.hasEvent`). Every other
 * condition type (`property`/`composite`/`email_engagement`/
 * `channel_identity`) compiles to an honest `false` stub with an inline TODO
 * block comment — the generated file still type-checks (the branch is never
 * taken) and the raw condition JSON is emitted as comments so a human can
 * port it by hand.
 */
export function compileCondition(
  condition: ConditionEval,
  nodeId: string,
): CompiledCondition {
  if (condition.type === "event") {
    return { expression: compileEventCondition(condition), comments: [] };
  }
  const marker = `TODO(promote-to-code): manually port this "${condition.type}" condition from blueprint node "${nodeId}"`;
  return {
    expression: `false /* ${marker} — see the raw JSON in the comment above */`,
    comments: [`// ${marker} — raw JSON:`, `// ${JSON.stringify(condition)}`],
  };
}

function compileEventCondition(condition: EventCondition): string {
  const args = [`userId: user.id`, `event: ${str(condition.eventName)}`];
  if (condition.within !== undefined) {
    args.push(`within: ${durationLiteral(condition.within)}`);
  }
  const call = `await ctx.history.hasEvent({ ${args.join(", ")} })`;
  switch (condition.check) {
    case "exists":
      return `(${call}).found`;
    case "not_exists":
      return `!(${call}).found`;
    case "count": {
      // Mirrors evaluateEventCondition: a count check without operator/value
      // degrades to "any occurrence".
      if (condition.operator === undefined || condition.value === undefined) {
        return `(${call}).count > 0`;
      }
      return `(${call}).count ${COUNT_OPERATORS[condition.operator]} ${condition.value}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Graph walk → run() body
// ---------------------------------------------------------------------------

interface WalkContext {
  nodesById: Map<string, BlueprintNode>;
  outgoing: Map<string, JourneyEdge[]>;
  usedVarNames: Set<string>;
  usesSendEmail: boolean;
  usesConnector: boolean;
}

function outgoingEdges(walk: WalkContext, nodeId: string): JourneyEdge[] {
  return walk.outgoing.get(nodeId) ?? [];
}

/** The single unconditional next node, or undefined at a dead end. */
function singleTarget(
  walk: WalkContext,
  node: BlueprintNode,
): string | undefined {
  const out = outgoingEdges(walk, node.id);
  if (out.length > 1) {
    throw new Error(
      `blueprint codegen: node "${node.id}" (${node.type}) has ${out.length} outgoing edges — only decision and wait nodes fork`,
    );
  }
  return out[0]?.target;
}

/** Emit `lines`, then continue the chain from `node`'s single next node. */
function continueFrom(
  walk: WalkContext,
  node: BlueprintNode,
  depth: number,
  path: ReadonlySet<string>,
  lines: string[],
): string[] {
  return [...lines, ...emitChain(walk, singleTarget(walk, node), depth, path)];
}

/** `if (condition) { trueTarget } else { falseTarget }`, both bodies via emitBranchBody. */
function emitIfElse(
  walk: WalkContext,
  ind: string,
  condition: string,
  trueTarget: string,
  falseTarget: string,
  depth: number,
  path: ReadonlySet<string>,
): string[] {
  return [
    `${ind}if (${condition}) {`,
    ...emitBranchBody(walk, trueTarget, depth + 1, path),
    `${ind}} else {`,
    ...emitBranchBody(walk, falseTarget, depth + 1, path),
    `${ind}}`,
  ];
}

/**
 * Emit the statement chain starting at `nodeId` (inclusive) until the branch
 * terminates. `path` carries the node ids of the CURRENT walk so a malformed
 * cyclic graph fails loudly instead of recursing forever (validated
 * blueprints are always acyclic).
 */
function emitChain(
  walk: WalkContext,
  nodeId: string | undefined,
  depth: number,
  path: ReadonlySet<string>,
): string[] {
  if (nodeId === undefined) return [];
  const node = walk.nodesById.get(nodeId);
  if (!node) {
    throw new Error(
      `blueprint codegen: an edge points at unknown node "${nodeId}"`,
    );
  }
  if (path.has(nodeId)) {
    throw new Error(
      `blueprint codegen: cycle detected at node "${nodeId}" — blueprint graphs must be acyclic`,
    );
  }
  const nextPath = new Set(path);
  nextPath.add(nodeId);
  const ind = INDENT.repeat(depth);

  switch (node.type) {
    case "start":
      // No statement — the trigger lives on meta.
      return emitChain(walk, singleTarget(walk, node), depth, nextPath);

    case "end-completed":
      // Terminal: running off the end of run() completes the enrollment
      // (status "completed" + journey:completed) — same as the interpreter.
      return [];

    case "end-exited":
      // Terminal: ctx.exit() flips the enrollment "exited" and aborts cleanly
      // — NO journey:completed / journey:failed — mirroring the interpreter's
      // end-exited node. A plain return would wrongly complete this branch.
      return [`${ind}await ctx.exit();`];

    case "end-failed": {
      // Terminal: a thrown error marks the enrollment "failed" and emits
      // journey:failed, exactly as the interpreter's end-failed node does. A
      // plain return would wrongly complete this branch.
      const message = `journey reached the "${node.id}" end-failed terminal`;
      return [`${ind}throw new Error(${str(message)});`];
    }

    case "sleep":
      return continueFrom(walk, node, depth, nextPath, [
        `${ind}await ctx.sleep({ duration: ${durationLiteral(node.meta.duration)}, label: ${str(node.id)} });`,
      ]);

    case "checkpoint":
      return continueFrom(walk, node, depth, nextPath, [
        `${ind}await ctx.checkpoint(${str(node.id)});`,
      ]);

    case "trigger":
      // idempotencyLabel = the node id, exactly as the interpreter passes it,
      // so a replay re-pushing this trigger is a no-op.
      return continueFrom(walk, node, depth, nextPath, [
        `${ind}await ctx.trigger({ event: ${str(node.meta.event)}, userId: user.id, idempotencyLabel: ${str(node.id)} });`,
      ]);

    case "send": {
      walk.usesSendEmail = true;
      const lines = [
        `${ind}await sendEmail({`,
        `${ind}${INDENT}to: user.email,`,
        `${ind}${INDENT}userId: user.id,`,
        `${ind}${INDENT}journeyStateId: user.stateId,`,
        `${ind}${INDENT}journeyName: user.journeyName,`,
        `${ind}${INDENT}template: ${str(node.meta.template)},`,
        // Always label the send (author's label ?? the node id), exactly as the
        // interpreter does — so two sends of the SAME template on divergent
        // branches derive DISTINCT exactly-once keys instead of colliding (the
        // engine throws an intra-run key-collision otherwise).
        `${ind}${INDENT}idempotencyLabel: ${str(node.meta.idempotencyLabel ?? node.id)},`,
        `${ind}});`,
      ];
      return continueFrom(walk, node, depth, nextPath, lines);
    }

    case "connector":
      walk.usesConnector = true;
      // idempotencyLabel = the node id, exactly as the interpreter passes it
      // (connector meta carries no label in v1) — branch-stable exactly-once.
      return continueFrom(walk, node, depth, nextPath, [
        `${ind}await sendConnectorAction({ connectorId: ${str(node.meta.connectorId)}, action: ${str(node.meta.action)}, idempotencyLabel: ${str(node.id)} });`,
      ]);

    case "wait": {
      const out = outgoingEdges(walk, node.id);
      const answered = out.find((edge) => edge.kind === "answered");
      const timedOut = out.find((edge) => edge.kind === "timedOut");
      const callBody = [
        `event: ${str(node.meta.event)},`,
        `timeout: ${durationLiteral(node.meta.timeout)},`,
        `label: ${str(node.id)},`,
      ];
      if (answered && timedOut) {
        const varName = uniqueVarName(node.id, walk.usedVarNames);
        return [
          `${ind}const ${varName} = await ctx.waitForEvent({`,
          ...callBody.map((line) => `${ind}${INDENT}${line}`),
          `${ind}});`,
          ...emitIfElse(
            walk,
            ind,
            `${varName}.timedOut`,
            timedOut.target,
            answered.target,
            depth,
            nextPath,
          ),
        ];
      }
      if (out.length > 1) {
        throw new Error(
          `blueprint codegen: node "${node.id}" (wait) has ${out.length} outgoing edges — expected a single edge, or exactly one "answered" and one "timedOut"`,
        );
      }
      // Single-edge wait: the result is unused, so no variable is introduced.
      return [
        `${ind}await ctx.waitForEvent({`,
        ...callBody.map((line) => `${ind}${INDENT}${line}`),
        `${ind}});`,
        ...emitChain(walk, out[0]?.target, depth, nextPath),
      ];
    }

    case "branch":
    case "decision": {
      const out = outgoingEdges(walk, node.id);
      const trueEdge = out.find((edge) => edge.kind === "conditional-true");
      const falseEdge = out.find((edge) => edge.kind === "conditional-false");
      if (!trueEdge || !falseEdge) {
        throw new Error(
          `blueprint codegen: ${node.type} node "${node.id}" needs one conditional-true and one conditional-false outgoing edge`,
        );
      }
      const compiled = node.meta.conditions.map((condition) =>
        compileCondition(condition, node.id),
      );
      const comments = compiled.flatMap((c) => c.comments);
      const expression = compiled.map((c) => c.expression).join(" && ");
      return [
        ...comments.map((comment) => `${ind}${comment}`),
        ...emitIfElse(
          walk,
          ind,
          expression,
          trueEdge.target,
          falseEdge.target,
          depth,
          nextPath,
        ),
      ];
    }

    default: {
      const unreachable: never = node;
      throw new Error(
        `blueprint codegen: unsupported node type ${JSON.stringify(unreachable)}`,
      );
    }
  }
}

/** A branch body; an empty one gets a comment so the block reads intentionally. */
function emitBranchBody(
  walk: WalkContext,
  targetNodeId: string,
  depth: number,
  path: ReadonlySet<string>,
): string[] {
  const lines = emitChain(walk, targetNodeId, depth, path);
  if (lines.length === 0) {
    return [`${INDENT.repeat(depth)}// (the journey ends on this branch)`];
  }
  return lines;
}

// ---------------------------------------------------------------------------
// meta + file assembly
// ---------------------------------------------------------------------------

function emitMetaLines(
  blueprint: CodegenBlueprintInput,
  journeyId: string,
): string[] {
  const ind = INDENT.repeat(2);
  const lines = [
    `${ind}id: ${str(journeyId)},`,
    `${ind}name: ${str(blueprint.name)},`,
  ];
  if (blueprint.description !== null) {
    lines.push(`${ind}description: ${str(blueprint.description)},`);
  }
  lines.push(`${ind}enabled: true,`);

  const where =
    blueprint.triggerWhere !== null && blueprint.triggerWhere.length > 0
      ? blueprint.triggerWhere
      : undefined;
  lines.push(
    `${ind}trigger: ${tsLiteral({ event: blueprint.triggerEvent, where })},`,
  );

  lines.push(`${ind}entryLimit: ${str(blueprint.entryLimit)},`);
  if (blueprint.entryLimit === "once_per_period" && blueprint.entryPeriod) {
    lines.push(`${ind}entryPeriod: ${durationLiteral(blueprint.entryPeriod)},`);
  }
  if (blueprint.exitOn !== null && blueprint.exitOn.length > 0) {
    const exitOn = blueprint.exitOn.map(({ event, where: exitWhere }) => ({
      event,
      where:
        exitWhere !== undefined && exitWhere.length > 0 ? exitWhere : undefined,
    }));
    lines.push(`${ind}exitOn: ${tsLiteral(exitOn)},`);
  }
  lines.push(`${ind}suppress: ${durationLiteral(blueprint.suppress)},`);
  return lines;
}

/**
 * Generate the full source of a `defineJourney()` file from a blueprint.
 *
 * The returned string is syntactically valid, readably indented TypeScript;
 * run it through Biome after writing it to disk. Throws on a structurally
 * broken graph (no/multiple start nodes, cycles, dangling edges, malformed
 * fan-out) — callers hand in graphs that already passed blueprint validation,
 * so these are defensive.
 */
export function generateJourneyFile(
  blueprint: CodegenBlueprintInput,
  opts: GenerateJourneyFileOptions,
): string {
  const startNodes = blueprint.graph.nodes.filter(
    (node) => node.type === "start",
  );
  const start = startNodes[0];
  if (!start || startNodes.length > 1) {
    throw new Error(
      `blueprint codegen: expected exactly one start node, found ${startNodes.length}`,
    );
  }

  const walk: WalkContext = {
    nodesById: new Map(blueprint.graph.nodes.map((node) => [node.id, node])),
    outgoing: new Map(),
    usedVarNames: new Set(),
    usesSendEmail: false,
    usesConnector: false,
  };
  for (const edge of blueprint.graph.edges) {
    const list = walk.outgoing.get(edge.source) ?? [];
    list.push(edge);
    walk.outgoing.set(edge.source, list);
  }

  const bodyLines = emitChain(walk, start.id, 2, new Set());

  const imports = ["defineJourney"];
  if (walk.usesConnector) imports.push("sendConnectorAction");
  if (walk.usesSendEmail) imports.push("sendEmail");

  const exportName = camelCase(opts.journeyId);
  return [
    `import { ${imports.join(", ")} } from "@hogsend/engine";`,
    "",
    "/**",
    ` * Generated from Journey Blueprint ${str(blueprint.id)} (promote to code).`,
    " *",
    " * Event names and template keys are emitted as literal strings — swap them",
    " * for your Events/Templates constants if you keep those. Resolve any",
    " * TODO(promote-to-code) markers before enabling.",
    " */",
    `export const ${exportName} = defineJourney({`,
    `${INDENT}meta: {`,
    ...emitMetaLines(blueprint, opts.journeyId),
    `${INDENT}},`,
    "",
    `${INDENT}run: async (user, ctx) => {`,
    ...bodyLines,
    `${INDENT}},`,
    "});",
    "",
  ].join("\n");
}
