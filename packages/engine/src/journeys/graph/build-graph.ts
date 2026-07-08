import type {
  JourneyEdge,
  JourneyGraph,
  JourneyMeta,
  JourneyNode,
  JourneyNodeType,
} from "@hogsend/core";
import * as acorn from "acorn";
import * as walk from "acorn-walk";

/**
 * Runtime AST extractor: turn a journey's captured `run` source into a
 * {@link JourneyGraph} for Studio's visual workflow.
 *
 * Two independent passes (see docs/studio-journey-flow-plan.md Phase 1):
 *
 * NODES — every recognized side-effect / durable primitive call in the `run`
 * body becomes a node. Detection is STRUCTURAL, not name-based, so
 * bundler-renamed imports (`sendEmail2`) still resolve: a `send` is any call
 * whose first arg object carries `template`/`to`; a `connector` any whose first
 * arg object carries `connectorId`/`action`. `ctx.*` primitives are detected by
 * the property applied directly to the detected `ctx` binding (which may be
 * `ctx`, `_ctx`, or absent). Node ids follow the A2 rule so they join to the
 * runtime `journeyStates.currentNodeId`.
 *
 * EDGES — a real CONTROL-FLOW graph with forks + convergence, walked from the
 * AST statement tree (NOT a flat linear chain). A branching `if`/`if-else`
 * becomes an explicit `decision` node with a HUMANIZED question title
 * (`Plan is pro?`, `Feature used?`, `Score ≤ 6?` — traced from the test
 * expression, resolving `const` bindings back to `ctx.history.hasEvent` /
 * `ctx.guard.isSubscribed` / property comparisons); the preceding node flows
 * into the decision, whose `yes` edge (conditional-true) enters the consequent
 * and whose `no` edge (conditional-false) enters the alternate (or skips to the
 * convergence point when there is no else); both branches converge onto the node
 * after the `if`. A `waitForEvent` followed by `if (<result>.timedOut)` forks the
 * WAIT node itself into `timedOut` / `answered` (no decision node). A guard
 * `if (cond) return/throw` (no else) routes that path to `end-completed` and
 * continues. Loops / try-catch fall back to a linear sub-region + a warning; if
 * the whole control-flow walk throws it degrades to a linear chain + a warning.
 *
 * The WHOLE extraction is wrapped in try/catch: any parse/walk failure returns
 * {@link degradedGraphFromMeta}. It must NEVER throw.
 */

type Node = acorn.AnyNode;
type EdgeKind = NonNullable<JourneyEdge["kind"]>;

/** A dangling graph edge waiting to connect to the next node it flows into. */
interface OpenEnd {
  id: string;
  kind: EdgeKind;
  label?: string;
}

/** ctx namespaces/methods that are decision inputs / utilities, not nodes. */
const CTX_SKIP = new Set(["history", "guard", "when", "once", "now"]);
/** ctx primitives that DO become nodes, mapped to their node type. */
const CTX_NODE: Record<string, JourneyNodeType> = {
  sleep: "sleep",
  sleepUntil: "sleepUntil",
  waitForEvent: "wait",
  checkpoint: "checkpoint",
  trigger: "trigger",
};
/** Bare identifier calls that are pure utilities, never `unknown` nodes. */
const UTIL_CALLS = new Set([
  "days",
  "hours",
  "minutes",
  "String",
  "Boolean",
  "Number",
  "getPostHog",
]);
/**
 * Duration-helper name → the ACTUAL `DurationObject` it produces at runtime
 * (`@hogsend/core`: `days(n) = { hours: n*24 }`, `hours(n) = { hours: n }`,
 * `minutes(n) = { minutes: n }`). Reconstructing the real object — not a
 * fabricated `{ days: n }` — is what makes an unlabeled sleep's synthetic id
 * (`wait:${JSON.stringify(duration)}`) BYTE-IDENTICAL to the engine's runtime
 * `journeyStates.currentNodeId`, so the metrics join actually lands. There is
 * no `days`/`weeks`/`seconds` key on `DurationObject`, and no `weeks()`/
 * `seconds()` helper exists.
 */
const DURATION_HELPER: Record<string, (n: number) => Record<string, number>> = {
  days: (n) => ({ hours: n * 24 }),
  hours: (n) => ({ hours: n }),
  minutes: (n) => ({ minutes: n }),
};

/** Internal pre-node: a classified call plus its best-effort extracted fields. */
interface Raw {
  kind: JourneyNodeType;
  start: number;
  line?: number;
  authoredLabel?: string;
  labelUnstable?: boolean;
  duration?: Record<string, number>;
  timeout?: Record<string, number>;
  eventLiteral?: string;
  eventIdent?: string;
  templateLiteral?: string;
  templateIdent?: string;
  connectorId?: string;
  action?: string;
  idempotencyLabel?: string;
  captureMethod?: string;
  calleeName?: string;
}

export function buildJourneyGraph({
  runSource,
  meta,
}: {
  runSource?: string;
  meta: JourneyMeta;
}): JourneyGraph {
  if (!runSource) return degradedGraphFromMeta(meta);
  try {
    return extract(runSource, meta);
  } catch {
    return degradedGraphFromMeta(meta);
  }
}

/**
 * The meta-only fallback graph: `start → end-completed`, `degraded: true`. Used
 * when the source is missing or extraction throws.
 */
export function degradedGraphFromMeta(meta: JourneyMeta): JourneyGraph {
  return {
    journeyId: meta.id,
    degraded: true,
    nodes: [startNode(meta), endNode()],
    edges: [
      {
        id: "edge-0",
        source: "start",
        target: "end-completed",
        kind: "default",
      },
    ],
    warnings: ["journey source unavailable — showing trigger only"],
  };
}

function extract(runSource: string, meta: JourneyMeta): JourneyGraph {
  const wrapped = `(${runSource})`;
  const ast = acorn.parse(wrapped, {
    ecmaVersion: "latest",
    locations: true,
    allowReturnOutsideFunction: true,
  });

  const fn = findRunFunction(ast);
  if (!fn) throw new Error("run function not found");

  const ctxName =
    fn.params[1]?.type === "Identifier" ? fn.params[1].name : undefined;

  const warnings: string[] = [];

  // --- Pass A: collect + classify every call in source order ---
  const raws: Raw[] = [];
  walk.fullAncestor(ast, (node, _state, ancestors) => {
    if (node.type !== "CallExpression") return;
    const raw = classifyCall(node, ctxName, ancestors, warnings);
    if (raw) raws.push(raw);
  });
  raws.sort((a, b) => a.start - b.start);

  // --- Pass B: assign ids (A2 join-key rules) ---
  const emitted = assignNodes(raws);
  dedupeIds(emitted);

  const start = startNode(meta);
  const end = endNode();

  // --- Edges: real control-flow graph (forks + convergence) from the AST,
  // minting `decision` nodes for branching ifs. If the walk throws on some
  // exotic shape, degrade to a linear chain (never fail).
  let edges: JourneyEdge[];
  let decisions: JourneyNode[] = [];
  try {
    const flow = buildFlowEdges(fn, wrapped, ctxName, emitted, raws, warnings);
    edges = flow.edges;
    decisions = flow.decisions;
  } catch {
    warnings.push("control-flow analysis failed — showing linear path");
    edges = buildLinearEdges([start, ...emitted, end]);
  }

  const nodes = [start, ...emitted, ...decisions, end];

  if (meta.exitOn?.length) {
    warnings.push(`exits on: ${meta.exitOn.map((e) => e.event).join(", ")}`);
  }

  // Same helper / warning at N sites emits N identical strings — collapse them.
  const uniqueWarnings = [...new Set(warnings)];

  return {
    journeyId: meta.id,
    nodes,
    edges,
    ...(uniqueWarnings.length ? { warnings: uniqueWarnings } : {}),
  };
}

// ---------------------------------------------------------------------------
// AST location / navigation
// ---------------------------------------------------------------------------

function findRunFunction(
  ast: acorn.Program,
): acorn.ArrowFunctionExpression | acorn.FunctionExpression | undefined {
  const stmt = ast.body[0];
  if (stmt?.type === "ExpressionStatement") {
    const e = stmt.expression;
    if (
      e.type === "ArrowFunctionExpression" ||
      e.type === "FunctionExpression"
    ) {
      return e;
    }
  }
  // Fallback: find the first function anywhere in the tree.
  let found:
    | acorn.ArrowFunctionExpression
    | acorn.FunctionExpression
    | undefined;
  walk.simple(ast, {
    ArrowFunctionExpression(n) {
      found ??= n;
    },
    FunctionExpression(n) {
      found ??= n;
    },
  });
  return found;
}

/** Line number from acorn's `locations`; source is single-`(`-prefixed so it maps 1:1. */
function lineOf(node: Node): number | undefined {
  return node.loc?.start.line;
}

/**
 * If `callee`'s base identifier is `ctxName`, return the property applied
 * DIRECTLY to it (`ctx.sleep` → "sleep", `ctx.history.hasEvent` → "history").
 * Otherwise null.
 */
function ctxFirstProp(callee: Node, ctxName: string): string | null {
  let node: Node = callee;
  while (node.type === "MemberExpression") {
    const obj = node.object;
    if (obj.type === "Identifier" && obj.name === ctxName) {
      return node.property.type === "Identifier" ? node.property.name : null;
    }
    node = obj as Node;
  }
  return null;
}

/** The base identifier name of a member/call chain (`getPostHog()?.capture` → "getPostHog"). */
function rootIdentName(node: Node): string | undefined {
  let n: Node = node;
  for (;;) {
    if (n.type === "Identifier") return n.name;
    if (n.type === "MemberExpression") {
      n = n.object as Node;
      continue;
    }
    if (n.type === "CallExpression") {
      n = n.callee as Node;
      continue;
    }
    if (n.type === "ChainExpression") {
      n = n.expression as Node;
      continue;
    }
    return undefined;
  }
}

/** The last identifier of an expression (`Templates.NPS_SURVEY` → "NPS_SURVEY"). */
function lastIdentOf(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression") {
    return node.property.type === "Identifier"
      ? node.property.name
      : lastIdentOf(node.object as Node);
  }
  return undefined;
}

function objectProp(
  obj: acorn.ObjectExpression,
  key: string,
): Node | undefined {
  for (const p of obj.properties) {
    if (p.type !== "Property" || p.computed) continue;
    const k = p.key;
    const name =
      k.type === "Identifier"
        ? k.name
        : k.type === "Literal" && typeof k.value === "string"
          ? k.value
          : undefined;
    if (name === key) return p.value as Node;
  }
  return undefined;
}

function objectExprArg(
  call: acorn.CallExpression,
): acorn.ObjectExpression | undefined {
  const first = call.arguments[0];
  return first && first.type === "ObjectExpression" ? first : undefined;
}

// ---------------------------------------------------------------------------
// Literal extraction
// ---------------------------------------------------------------------------

function stringLiteral(node: Node | undefined): string | undefined {
  return node && node.type === "Literal" && typeof node.value === "string"
    ? node.value
    : undefined;
}

/** Cook a template literal to `"scored-${…}"`; `dynamic` when it has expressions. */
function cookTemplate(t: acorn.TemplateLiteral): {
  text: string;
  dynamic: boolean;
} {
  let out = "";
  t.quasis.forEach((q, i) => {
    out += q.value.cooked ?? q.value.raw ?? "";
    if (i < t.expressions.length) out += "${…}";
  });
  return { text: out, dynamic: t.expressions.length > 0 };
}

/** Extract a label-like value: string literal, or cooked template (→ unstable). */
function extractLabel(
  node: Node | undefined,
): { value: string; unstable: boolean } | undefined {
  if (!node) return undefined;
  const s = stringLiteral(node);
  if (s !== undefined) return { value: s, unstable: false };
  if (node.type === "TemplateLiteral") {
    const { text, dynamic } = cookTemplate(node);
    return { value: text, unstable: dynamic };
  }
  return undefined;
}

/**
 * Extract a DurationObject from either a literal object (`{ hours: 336 }`,
 * `{ days: 14 }` — passed through verbatim, matching whatever the author wrote)
 * or a `days(14)`/`hours(1)`/`minutes(30)` helper call (reconstructed to the
 * REAL runtime object via {@link DURATION_HELPER}). Non-literal → undefined.
 */
function extractDuration(
  node: Node | undefined,
): Record<string, number> | undefined {
  if (!node) return undefined;
  if (node.type === "ObjectExpression") {
    const out: Record<string, number> = {};
    for (const p of node.properties) {
      if (p.type !== "Property" || p.computed) continue;
      const key =
        p.key.type === "Identifier"
          ? p.key.name
          : p.key.type === "Literal" && typeof p.key.value === "string"
            ? p.key.value
            : undefined;
      const val = p.value;
      if (key && val.type === "Literal" && typeof val.value === "number") {
        out[key] = val.value;
      }
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (node.type === "CallExpression" && node.callee.type === "Identifier") {
    const build = DURATION_HELPER[node.callee.name];
    const arg = node.arguments[0];
    if (
      build &&
      arg &&
      arg.type === "Literal" &&
      typeof arg.value === "number"
    ) {
      return build(arg.value);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function classifyCall(
  call: acorn.CallExpression,
  ctxName: string | undefined,
  ancestors: Node[],
  warnings: string[],
): Raw | undefined {
  const callee = call.callee;
  if (callee.type === "Super") return undefined;

  const base: Pick<Raw, "start" | "line"> = {
    start: call.start,
    line: lineOf(call),
  };

  // 1. ctx.* primitives (detected by the property applied directly to ctx).
  if (ctxName) {
    const prop = ctxFirstProp(callee, ctxName);
    if (prop !== null) {
      if (CTX_SKIP.has(prop)) return undefined;
      const kind = CTX_NODE[prop];
      if (!kind) return undefined; // unrecognized ctx member → not a node
      return { ...base, ...ctxNodeFields(kind, call) };
    }
  }

  // 2. getPostHog()?.capture()/.identify()
  if (callee.type === "MemberExpression") {
    const method =
      callee.property.type === "Identifier" ? callee.property.name : undefined;
    if (
      (method === "capture" || method === "identify") &&
      rootIdentName(callee.object as Node) === "getPostHog"
    ) {
      return { ...base, kind: "capture", captureMethod: method };
    }
  }

  // 3. Structural send / connector detection on the first-arg object.
  const arg = objectExprArg(call);
  if (arg) {
    if (objectProp(arg, "connectorId") || objectProp(arg, "action")) {
      const cid = stringLiteral(objectProp(arg, "connectorId"));
      const act = stringLiteral(objectProp(arg, "action"));
      return { ...base, kind: "connector", connectorId: cid, action: act };
    }
    if (objectProp(arg, "template") || objectProp(arg, "to")) {
      return { ...base, ...sendFields(arg) };
    }
  }

  // 4. Awaited unknown bare-identifier call (a helper) → honest `unknown` node.
  // An OPTIONAL call (`await helper?.()`) nests an extra ChainExpression between
  // the AwaitExpression and the CallExpression — unwrap it so the optional form
  // is treated identically to the plain one (else the side effect is dropped).
  let parent = ancestors[ancestors.length - 2];
  if (parent?.type === "ChainExpression") {
    parent = ancestors[ancestors.length - 3];
  }
  const awaited = parent?.type === "AwaitExpression";
  if (awaited && callee.type === "Identifier" && !UTIL_CALLS.has(callee.name)) {
    warnings.push(
      `'${callee.name}' is a helper call — its side effects are not expanded`,
    );
    return { ...base, kind: "unknown", calleeName: callee.name };
  }

  return undefined;
}

type ClassifiedFields = Partial<Raw> & { kind: JourneyNodeType };

function ctxNodeFields(
  kind: JourneyNodeType,
  call: acorn.CallExpression,
): ClassifiedFields {
  if (kind === "checkpoint") {
    // ctx.checkpoint(label) — the label is the first positional arg.
    const label = extractLabel(call.arguments[0] as Node | undefined);
    return {
      kind,
      authoredLabel: label?.value,
      labelUnstable: label?.unstable,
    };
  }

  const arg = objectExprArg(call);
  if (kind === "sleep") {
    const label = extractLabel(arg && objectProp(arg, "label"));
    return {
      kind,
      authoredLabel: label?.value,
      labelUnstable: label?.unstable,
      duration: arg ? extractDuration(objectProp(arg, "duration")) : undefined,
    };
  }
  if (kind === "sleepUntil") {
    const label = extractLabel(arg && objectProp(arg, "label"));
    return {
      kind,
      authoredLabel: label?.value,
      labelUnstable: label?.unstable,
    };
  }
  if (kind === "wait") {
    const label = extractLabel(arg && objectProp(arg, "label"));
    const eventNode = arg ? objectProp(arg, "event") : undefined;
    return {
      kind,
      authoredLabel: label?.value,
      labelUnstable: label?.unstable,
      eventLiteral: stringLiteral(eventNode),
      eventIdent: lastIdentOf(eventNode),
      timeout: arg ? extractDuration(objectProp(arg, "timeout")) : undefined,
    };
  }
  // trigger
  const eventNode = arg ? objectProp(arg, "event") : undefined;
  return {
    kind,
    eventLiteral: stringLiteral(eventNode),
    eventIdent: lastIdentOf(eventNode),
  };
}

function sendFields(arg: acorn.ObjectExpression): ClassifiedFields {
  const templateNode = objectProp(arg, "template");
  const idem = extractLabel(objectProp(arg, "idempotencyLabel"));
  return {
    kind: "send",
    templateLiteral: stringLiteral(templateNode),
    templateIdent: lastIdentOf(templateNode),
    // Only a literal idempotencyLabel is a stable id "site".
    idempotencyLabel: idem && !idem.unstable ? idem.value : undefined,
  };
}

// ---------------------------------------------------------------------------
// Node id assignment (A2)
// ---------------------------------------------------------------------------

function assignNodes(raws: Raw[]): JourneyNode[] {
  const nodes: JourneyNode[] = [];
  // The nearest preceding boundary label — the "site" a send inherits when it
  // has no idempotencyLabel (mirrors the engine's boundary.currentLabel, which
  // advances even on the engine's DETERMINISTIC default labels).
  let currentLabel: string | undefined;

  raws.forEach((raw, idx) => {
    const { node, boundaryLabel } = nodeFromRaw(raw, idx, currentLabel);
    if (boundaryLabel !== undefined) currentLabel = boundaryLabel;
    nodes.push(node);
  });
  return nodes;
}

function nodeFromRaw(
  raw: Raw,
  idx: number,
  currentLabel: string | undefined,
): { node: JourneyNode; boundaryLabel?: string } {
  const meta: NonNullable<JourneyNode["meta"]> = {};
  let id: string;
  let title: string;
  let subtitle: string | undefined;
  let boundaryLabel: string | undefined;

  switch (raw.kind) {
    case "sleep": {
      if (raw.authoredLabel !== undefined) {
        id = raw.authoredLabel;
        boundaryLabel = raw.labelUnstable ? undefined : raw.authoredLabel;
      } else if (raw.duration) {
        // DETERMINISTIC synthetic id — byte-identical to the engine's default
        // `currentNodeId`. Advance currentLabel exactly as the engine's
        // setBoundaryLabel does, so a following label-less send inherits it.
        id = `wait:${JSON.stringify(raw.duration)}`;
        boundaryLabel = id;
      } else {
        id = `sleep:${idx}`;
        meta.unstable = true;
      }
      if (raw.duration) meta.duration = raw.duration;
      if (raw.labelUnstable) meta.unstable = true;
      title = raw.authoredLabel ?? "Sleep";
      subtitle = raw.duration ? formatDuration(raw.duration) : undefined;
      break;
    }
    case "sleepUntil": {
      if (raw.authoredLabel !== undefined) {
        id = raw.authoredLabel;
        boundaryLabel = raw.labelUnstable ? undefined : raw.authoredLabel;
        if (raw.labelUnstable) meta.unstable = true;
      } else {
        id = `wait-until:${idx}`;
        meta.unstable = true;
      }
      title = raw.authoredLabel ?? "Sleep until";
      break;
    }
    case "wait": {
      if (raw.authoredLabel !== undefined) {
        id = raw.authoredLabel;
        boundaryLabel = raw.labelUnstable ? undefined : raw.authoredLabel;
        if (raw.labelUnstable) meta.unstable = true;
      } else if (raw.eventLiteral !== undefined) {
        // DETERMINISTIC synthetic id (engine default `wait-event:${event}`) —
        // advance currentLabel so a following label-less send inherits it.
        id = `wait-event:${raw.eventLiteral}`;
        boundaryLabel = id;
      } else {
        id = `wait-event:${idx}`;
        meta.unstable = true;
      }
      if (raw.eventLiteral) meta.event = raw.eventLiteral;
      if (raw.timeout) meta.timeout = raw.timeout;
      subtitle = raw.eventLiteral ?? raw.eventIdent;
      title = raw.authoredLabel ?? subtitle ?? "Wait for event";
      break;
    }
    case "checkpoint": {
      id = raw.authoredLabel ?? `checkpoint:${idx}`;
      if (raw.authoredLabel === undefined || raw.labelUnstable) {
        meta.unstable = true;
      }
      if (raw.authoredLabel !== undefined && !raw.labelUnstable) {
        boundaryLabel = raw.authoredLabel;
      }
      title = "Checkpoint";
      subtitle = raw.authoredLabel;
      break;
    }
    case "trigger": {
      const key = raw.eventLiteral ?? raw.eventIdent ?? String(idx);
      id = `trigger:${key}`;
      if (raw.eventLiteral) meta.event = raw.eventLiteral;
      title = "Trigger";
      subtitle = raw.eventLiteral ?? raw.eventIdent;
      break;
    }
    case "send": {
      const site =
        raw.idempotencyLabel ??
        currentLabel ??
        raw.templateLiteral ??
        raw.templateIdent ??
        "send";
      id = `send:${site}`;
      if (raw.templateLiteral) meta.template = raw.templateLiteral;
      if (raw.idempotencyLabel) meta.idempotencyLabel = raw.idempotencyLabel;
      title = "Send email";
      subtitle =
        raw.templateLiteral ?? raw.templateIdent ?? raw.idempotencyLabel;
      break;
    }
    case "connector": {
      id = `connector:${raw.connectorId ?? idx}:${raw.action ?? idx}`;
      if (raw.connectorId) meta.connectorId = raw.connectorId;
      if (raw.action) meta.action = raw.action;
      title = raw.action ?? "Connector action";
      subtitle =
        [raw.connectorId, raw.action].filter(Boolean).join(" · ") || undefined;
      break;
    }
    case "capture": {
      id = `capture:${idx}`;
      title = raw.captureMethod === "identify" ? "Identify" : "Capture";
      subtitle = raw.captureMethod;
      break;
    }
    default: {
      // unknown
      id = `unknown:${raw.calleeName ?? "call"}:${idx}`;
      title = raw.calleeName ?? "Unknown call";
      subtitle = "helper call";
      break;
    }
  }

  const node: JourneyNode = {
    id,
    type: raw.kind,
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(Object.keys(meta).length ? { meta } : {}),
    ...(raw.line ? { line: raw.line } : {}),
  };
  return { node, boundaryLabel };
}

/** Suffix `#2`, `#3`, … onto any duplicate emitted ids to keep them unique. */
function dedupeIds(nodes: JourneyNode[]): void {
  const used = new Set<string>(["start", "end-completed"]);
  for (const node of nodes) {
    if (!used.has(node.id)) {
      used.add(node.id);
      continue;
    }
    let k = 2;
    while (used.has(`${node.id}#${k}`)) k++;
    node.id = `${node.id}#${k}`;
    used.add(node.id);
  }
}

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

function startNode(meta: JourneyMeta): JourneyNode {
  return {
    id: "start",
    type: "start",
    title: "Start",
    ...(meta.trigger.event ? { subtitle: meta.trigger.event } : {}),
    ...(meta.trigger.where?.length
      ? { meta: { conditions: meta.trigger.where } }
      : {}),
  };
}

function endNode(): JourneyNode {
  return { id: "end-completed", type: "end-completed", title: "Completed" };
}

/** Ultimate fallback: a flat `start → … → end-completed` chain. */
function buildLinearEdges(nodes: JourneyNode[]): JourneyEdge[] {
  const edges: JourneyEdge[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const from = nodes[i];
    const to = nodes[i + 1];
    if (!from || !to) continue;
    edges.push({
      id: `edge-${i}`,
      source: from.id,
      target: to.id,
      kind: "default",
    });
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Control-flow edges — walk the statement tree; branching ifs become decision
// nodes, waitForEvent `.timedOut` ifs fork the wait node, guards early-exit.
// ---------------------------------------------------------------------------

/** Is a test the `<x>.timedOut` shape that turns a wait into a fork? */
function testIsTimedOut(test: Node): boolean {
  const t = test.type === "ChainExpression" ? test.expression : test;
  return (
    t.type === "MemberExpression" &&
    t.property.type === "Identifier" &&
    t.property.name === "timedOut"
  );
}

/**
 * Is the test a `!X` negation? The decision title is the POSITIVE question, so a
 * negated test routes the consequent (which runs when the positive condition is
 * FALSE) onto the `no` edge and the alternate/bypass onto `yes`.
 */
function testIsNegated(test: Node): boolean {
  const t = test.type === "ChainExpression" ? test.expression : test;
  return t.type === "UnaryExpression" && t.operator === "!";
}

/** Comparison operator → readable phrasing for a decision question. */
const COMPARISON_OPS: Record<string, string> = {
  "===": "is",
  "==": "is",
  "!==": "is not",
  "!=": "is not",
  ">=": "≥",
  "<=": "≤",
  ">": ">",
  "<": "<",
};

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** `FEATURE_USED` → "feature used"; `hasUsedFeature` → "has used feature". */
function humanizeIdent(name: string): string {
  if (/^[A-Z0-9_]+$/.test(name)) return name.toLowerCase().replace(/_/g, " ");
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

/** An event name → a short yes/no question, `FEATURE_USED` → "Feature used?". */
function eventTitle(name: string): string {
  return `${cap(humanizeIdent(name))}?`;
}

/** The identifiers a `const`/`let` pattern binds (`{ found: x }` → ["x"]). */
function patternNames(pat: Node): string[] {
  if (pat.type === "Identifier") return [pat.name];
  if (pat.type === "ObjectPattern") {
    const names: string[] = [];
    for (const p of pat.properties) {
      if (p.type !== "Property") continue;
      const v = p.value;
      if (v.type === "Identifier") names.push(v.name);
      else if (v.type === "AssignmentPattern" && v.left.type === "Identifier") {
        names.push(v.left.name);
      }
    }
    return names;
  }
  return [];
}

function buildFlowEdges(
  fn: acorn.ArrowFunctionExpression | acorn.FunctionExpression,
  source: string,
  ctxName: string | undefined,
  emitted: JourneyNode[],
  raws: Raw[],
  warnings: string[],
): { edges: JourneyEdge[]; decisions: JourneyNode[] } {
  const edges: JourneyEdge[] = [];
  const seen = new Set<string>();
  let counter = 0;

  const nodeType = new Map<string, JourneyNodeType>();
  for (const n of emitted) nodeType.set(n.id, n.type);

  // Synthetic `decision` nodes minted for branching ifs (unique ids, appended
  // to the graph's node list by the caller).
  const used = new Set<string>(["start", "end-completed"]);
  for (const n of emitted) used.add(n.id);
  const decisions: JourneyNode[] = [];
  let decisionCounter = 0;
  const mintDecision = (title: string): JourneyNode => {
    let id = `decision:${decisionCounter++}`;
    while (used.has(id)) id = `decision:${decisionCounter++}`;
    used.add(id);
    // Decisions don't join to currentNodeId — the id is purely a React key, so
    // it is always synthetic (unstable).
    const node: JourneyNode = {
      id,
      type: "decision",
      title,
      meta: { unstable: true },
    };
    decisions.push(node);
    return node;
  };

  const addEdge = (oe: OpenEnd, targetId: string): void => {
    // Dedupe by (source, target, kind): guards can otherwise emit the same edge
    // from several early-return sites.
    const key = `${oe.id} ${targetId} ${oe.kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({
      id: `edge-${counter++}`,
      source: oe.id,
      target: targetId,
      kind: oe.kind,
      ...(oe.label ? { label: oe.label } : {}),
    });
  };

  /** Emitted nodes whose call.start ∈ [lo, hi), in source order. */
  const nodesInRange = (lo: number, hi: number): JourneyNode[] => {
    const out: JourneyNode[] = [];
    for (let i = 0; i < raws.length; i++) {
      const r = raws[i];
      const n = emitted[i];
      if (r && n && r.start >= lo && r.start < hi) out.push(n);
    }
    return out;
  };
  const hasNodesInRange = (lo: number, hi: number): boolean =>
    raws.some((r) => r.start >= lo && r.start < hi);

  /** Chain preds through the node-worthy calls in [lo, hi) linearly. */
  const chainRange = (lo: number, hi: number, preds: OpenEnd[]): OpenEnd[] => {
    let cur = preds;
    for (const n of nodesInRange(lo, hi)) {
      for (const oe of cur) addEdge(oe, n.id);
      cur = [{ id: n.id, kind: "default" }];
    }
    return cur;
  };

  /** A pass-through guard: `if (cond) return/throw` — no else, no nodes inside. */
  const isPureExitGuard = (consequent: Node): boolean => {
    if (hasNodesInRange(consequent.start, consequent.end)) return false;
    if (
      consequent.type === "ReturnStatement" ||
      consequent.type === "ThrowStatement"
    ) {
      return true;
    }
    if (consequent.type === "BlockStatement") {
      const last = consequent.body[consequent.body.length - 1];
      return (
        !!last &&
        (last.type === "ReturnStatement" || last.type === "ThrowStatement")
      );
    }
    return false;
  };

  // --- Humanizers: trace the test expression into a readable question. ---
  const sourceSlice = (n: Node): string => source.slice(n.start, n.end);

  const operandText = (n: Node): string => {
    if (n.type === "MemberExpression") return lastIdentOf(n) ?? sourceSlice(n);
    if (n.type === "Literal") {
      return typeof n.value === "string"
        ? n.value
        : String(n.value ?? sourceSlice(n));
    }
    if (n.type === "Identifier") return humanizeIdent(n.name);
    return sourceSlice(n);
  };

  const humanizeComparison = (
    bin: acorn.BinaryExpression,
  ): string | undefined => {
    const op = COMPARISON_OPS[bin.operator];
    if (!op) return undefined;
    const left = cap(operandText(bin.left as Node));
    return `${left} ${op} ${operandText(bin.right as Node)}?`;
  };

  /** Resolve a binding init (`ctx.history.hasEvent` / `isSubscribed` / compare). */
  const traceHint = (init: Node): string | undefined => {
    let n = init;
    if (n.type === "AwaitExpression") n = n.argument as Node;
    if (n.type === "ChainExpression") n = n.expression as Node;
    if (n.type === "BinaryExpression") return humanizeComparison(n);
    let call: Node = n;
    if (call.type === "MemberExpression") call = call.object as Node;
    if (call.type === "AwaitExpression") call = call.argument as Node;
    if (call.type === "ChainExpression") call = call.expression as Node;
    if (call.type === "CallExpression" && ctxName) {
      const first = ctxFirstProp(call.callee as Node, ctxName);
      const method = lastIdentOf(call.callee as Node);
      if (first === "history" && method === "hasEvent") {
        const arg = objectExprArg(call);
        const ev = arg ? objectProp(arg, "event") : undefined;
        const name = stringLiteral(ev) ?? lastIdentOf(ev);
        return name ? eventTitle(name) : "Event occurred?";
      }
      if (first === "guard" && method === "isSubscribed") {
        return "Still subscribed?";
      }
    }
    return undefined;
  };

  // Track simple boolean bindings so `if (isPro)` resolves to its real criteria.
  const bindingMap = new Map<string, string>();
  walk.simple(fn, {
    VariableDeclarator(d) {
      if (!d.init) return;
      const hint = traceHint(d.init as Node);
      if (!hint) return;
      for (const name of patternNames(d.id as Node)) bindingMap.set(name, hint);
    },
  });

  /** The humanized question for an `if` test (best-effort; falls back to code). */
  const humanizeCondition = (test: Node): string => {
    let t = test;
    if (t.type === "ChainExpression") t = t.expression as Node;
    // Strip a single leading `!` — the yes/no edges carry the branch selection,
    // so the title stays the positive question.
    if (t.type === "UnaryExpression" && t.operator === "!") {
      t = t.argument as Node;
    }
    if (t.type === "AwaitExpression") t = t.argument as Node;
    if (t.type === "ChainExpression") t = t.expression as Node;
    if (t.type === "Identifier") {
      return bindingMap.get(t.name) ?? `${cap(humanizeIdent(t.name))}?`;
    }
    if (t.type === "BinaryExpression") {
      const c = humanizeComparison(t);
      if (c) return c;
    }
    if (t.type === "CallExpression") {
      const h = traceHint(t);
      if (h) return h;
    }
    return `${truncate(sourceSlice(t))}?`;
  };

  function flowSeq(stmts: Node[], preds: OpenEnd[]): OpenEnd[] {
    let cur = preds;
    for (const s of stmts) cur = flowStatement(s, cur);
    return cur;
  }

  function flowStatement(stmt: Node, preds: OpenEnd[]): OpenEnd[] {
    switch (stmt.type) {
      case "BlockStatement":
        return flowSeq(stmt.body, preds);
      case "IfStatement":
        return flowIf(stmt, preds);
      case "ReturnStatement":
      case "ThrowStatement": {
        // Any node in the return argument connects first, then → terminal.
        const cur = chainRange(stmt.start, stmt.end, preds);
        for (const oe of cur) addEdge(oe, "end-completed");
        return [];
      }
      case "TryStatement": {
        warnings.push("try/catch shown as a linear region");
        let out = flowStatement(stmt.block, preds);
        if (stmt.handler) {
          out = [...out, ...flowStatement(stmt.handler.body, preds)];
        }
        if (stmt.finalizer) out = flowStatement(stmt.finalizer, out);
        return out;
      }
      case "WhileStatement":
      case "DoWhileStatement":
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement": {
        warnings.push("loop body shown once (not expanded)");
        return flowStatement(stmt.body, preds);
      }
      case "LabeledStatement":
        return flowStatement(stmt.body, preds);
      default:
        // Expression / variable / etc: chain its direct node-worthy calls.
        return chainRange(stmt.start, stmt.end, preds);
    }
  }

  function flowIf(stmt: acorn.IfStatement, predsIn: OpenEnd[]): OpenEnd[] {
    // Node-worthy calls in the TEST run BEFORE the fork (rare, but honest).
    const preds = chainRange(stmt.test.start, stmt.test.end, predsIn);

    const firstPred = preds[0];
    const waitFork =
      preds.length === 1 &&
      firstPred !== undefined &&
      nodeType.get(firstPred.id) === "wait" &&
      testIsTimedOut(stmt.test);

    // Guard `if (cond) return;` — no else, consequent is a pure return/throw.
    // The TRUE path exits to the terminal; the FALSE path continues with the
    // predecessors' kinds PRESERVED (so an upstream branch label — e.g. a wait's
    // "answered" — survives the guard instead of being re-labeled). No decision
    // node: a guard is a one-way filter, not a two-way branch.
    if (!stmt.alternate && isPureExitGuard(stmt.consequent)) {
      if (waitFork && firstPred) {
        addEdge(
          { id: firstPred.id, kind: "timedOut", label: "timed out" },
          "end-completed",
        );
        return [{ id: firstPred.id, kind: "answered", label: "answered" }];
      }
      const label = testIsTimedOut(stmt.test)
        ? "timed out"
        : humanizeCondition(stmt.test);
      for (const oe of preds) {
        if (oe.kind === "default") {
          addEdge(
            { id: oe.id, kind: "conditional-true", label },
            "end-completed",
          );
        }
      }
      return preds;
    }

    // waitForEvent `.timedOut` branch → fork the WAIT node itself (no decision).
    if (waitFork && firstPred) {
      const trueExits = flowStatement(stmt.consequent, [
        { id: firstPred.id, kind: "timedOut", label: "timed out" },
      ]);
      const answered: OpenEnd = {
        id: firstPred.id,
        kind: "answered",
        label: "answered",
      };
      const falseExits = stmt.alternate
        ? flowStatement(stmt.alternate, [answered])
        : [answered];
      return [...trueExits, ...falseExits];
    }

    // Plain branching if → an explicit DECISION node with a humanized question.
    // The `yes` edge = the positive condition is TRUE, `no` = FALSE. The title is
    // the POSITIVE form, so a negated test (`!X`) attaches the consequent — which
    // runs when the positive condition is FALSE — to the `no` edge, and the
    // alternate/bypass to `yes`. (Non-negated: consequent on `yes` as usual.)
    const decision = mintDecision(humanizeCondition(stmt.test));
    for (const oe of preds) addEdge(oe, decision.id);
    const yes: OpenEnd = {
      id: decision.id,
      kind: "conditional-true",
      label: "yes",
    };
    const no: OpenEnd = {
      id: decision.id,
      kind: "conditional-false",
      label: "no",
    };
    const negated = testIsNegated(stmt.test);
    const consequentEntry = negated ? no : yes;
    const bypassEntry = negated ? yes : no;
    const trueExits = flowStatement(stmt.consequent, [consequentEntry]);
    const falseExits = stmt.alternate
      ? flowStatement(stmt.alternate, [bypassEntry])
      : [bypassEntry];
    return [...trueExits, ...falseExits];
  }

  // Drive from the start node through the function body; converge the tail.
  let preds: OpenEnd[] = [{ id: "start", kind: "default" }];
  const body = fn.body;
  preds =
    body.type === "BlockStatement"
      ? flowSeq(body.body, preds)
      : chainRange(body.start, body.end, preds);
  for (const oe of preds) addEdge(oe, "end-completed");

  return { edges, decisions };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatDuration(d: Record<string, number>): string {
  return (
    Object.entries(d)
      .map(([unit, n]) => {
        // The core helpers store days as hours (`days(14) = { hours: 336 }`) —
        // fold whole-day hour counts back to days so subtitles read naturally.
        if (unit === "hours" && n >= 24 && n % 24 === 0) {
          return plural(n / 24, "day");
        }
        return plural(n, unit.replace(/s$/, ""));
      })
      .join(", ") || "duration"
  );
}

function plural(n: number, unit: string): string {
  return `${n} ${n === 1 ? unit : `${unit}s`}`;
}

function truncate(s: string, max = 48): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
