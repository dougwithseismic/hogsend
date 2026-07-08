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
 * Design (two tiers, see docs/studio-journey-flow-plan.md Phase 1):
 *
 * TIER 1 — the linear backbone. Every recognized side-effect / durable
 * primitive call in the `run` body becomes a node, chained in SOURCE ORDER with
 * `default` edges: `start → n1 → … → end-completed`. Detection is STRUCTURAL,
 * not name-based, so bundler-renamed imports (`sendEmail2`) still resolve: a
 * `send` is any call whose first arg object carries `template`/`to`; a
 * `connector` any whose first arg object carries `connectorId`/`action`. `ctx.*`
 * primitives are detected by the property applied directly to the detected `ctx`
 * param binding (which may be `ctx`, `_ctx`, or absent).
 *
 * TIER 2 — best-effort branch refinement layered on top of the linear chain and
 * wrapped so it can NEVER destabilize Tier 1: `if`-guarded sends get a
 * `conditional-true`/`conditional-false` inbound edge. `waitForEvent`
 * timed-out/answered branches are intentionally shown as a linear path in v1
 * (flagged via a warning) — linear correctness always wins.
 *
 * The WHOLE extraction is wrapped in try/catch: any parse/walk failure returns
 * {@link degradedGraphFromMeta}. It must NEVER throw.
 */

type Node = acorn.AnyNode;

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
  // Tier 2 — enclosing `if` branch (best-effort; undefined at top level).
  ifKey?: string;
  ifKind?: "consequent" | "alternate";
  ifTest?: string;
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
    const raw = classifyCall(node, ctxName, ancestors, wrapped, warnings);
    if (raw) raws.push(raw);
  });
  raws.sort((a, b) => a.start - b.start);

  // --- Pass B: assign ids (A2 join-key rules) building the linear chain ---
  const emitted = assignNodes(raws);
  dedupeIds(emitted);

  // --- Assemble chain + edges ---
  const start = startNode(meta);
  const end = endNode();
  const nodes = [start, ...emitted, end];
  const edges = buildEdges(nodes);

  // Tier 2 (best-effort, isolated): conditional inbound edges + a note when a
  // waitForEvent timed-out branch is present but shown linearly.
  try {
    refineBranches(nodes, raws, edges, warnings);
  } catch {
    warnings.push("branch refinement skipped — showing linear path");
  }

  if (meta.exitOn?.length) {
    warnings.push(`exits on: ${meta.exitOn.map((e) => e.event).join(", ")}`);
  }

  // Same helper called at N sites emits N identical warnings — collapse them.
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
  source: string,
  warnings: string[],
): Raw | undefined {
  const callee = call.callee;
  if (callee.type === "Super") return undefined;

  const base: Pick<Raw, "start" | "line"> = {
    start: call.start,
    line: lineOf(call),
  };
  const branch = enclosingIf(call, ancestors, source);

  // 1. ctx.* primitives (detected by the property applied directly to ctx).
  if (ctxName) {
    const prop = ctxFirstProp(callee, ctxName);
    if (prop !== null) {
      if (CTX_SKIP.has(prop)) return undefined;
      const kind = CTX_NODE[prop];
      if (!kind) return undefined; // unrecognized ctx member → not a node
      return { ...base, ...branch, ...ctxNodeFields(kind, call) };
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
      return { ...base, ...branch, kind: "capture", captureMethod: method };
    }
  }

  // 3. Structural send / connector detection on the first-arg object.
  const arg = objectExprArg(call);
  if (arg) {
    if (objectProp(arg, "connectorId") || objectProp(arg, "action")) {
      const cid = stringLiteral(objectProp(arg, "connectorId"));
      const act = stringLiteral(objectProp(arg, "action"));
      return {
        ...base,
        ...branch,
        kind: "connector",
        connectorId: cid,
        action: act,
      };
    }
    if (objectProp(arg, "template") || objectProp(arg, "to")) {
      return { ...base, ...branch, ...sendFields(arg) };
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
    return { ...base, ...branch, kind: "unknown", calleeName: callee.name };
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
  // The nearest preceding AUTHORED (literal) boundary label — the "site" a send
  // inherits when it has no idempotencyLabel (mirrors the engine's currentLabel).
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
// Terminals + edges
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

function buildEdges(nodes: JourneyNode[]): JourneyEdge[] {
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
// Tier 2 — conditional edge refinement (best-effort, isolated)
// ---------------------------------------------------------------------------

/**
 * Find the innermost enclosing `IfStatement` for which `call` sits in the
 * consequent or alternate (not the test). Returns a stable key + branch + test
 * source so an inbound edge into a conditionally-reached node can be labeled.
 */
function enclosingIf(
  call: Node,
  ancestors: Node[],
  source: string,
): Pick<Raw, "ifKey" | "ifKind" | "ifTest"> {
  for (let i = ancestors.length - 2; i >= 0; i--) {
    const anc = ancestors[i];
    if (!anc || anc.type !== "IfStatement") continue;
    const inConsequent = within(call, anc.consequent);
    const inAlternate = anc.alternate ? within(call, anc.alternate) : false;
    if (!inConsequent && !inAlternate) continue; // call is in the test
    return {
      ifKey: `if@${anc.start}:${inConsequent ? "c" : "a"}`,
      ifKind: inConsequent ? "consequent" : "alternate",
      ifTest: source.slice(anc.test.start, anc.test.end),
    };
  }
  return {};
}

function within(inner: Node, outer: Node): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

/**
 * Label inbound edges into nodes that ENTER an `if` branch as
 * `conditional-true`/`conditional-false`, and warn when a `waitForEvent`
 * timed-out branch is present (shown linearly in v1).
 */
function refineBranches(
  nodes: JourneyNode[],
  raws: Raw[],
  edges: JourneyEdge[],
  warnings: string[],
): void {
  // nodes = [start, ...emitted(raws), end]; emitted[k] ↔ raws[k] ↔ nodes[k+1].
  const rawAt = (chainIdx: number): Raw | undefined =>
    chainIdx >= 1 && chainIdx <= raws.length ? raws[chainIdx - 1] : undefined;

  let sawTimedOut = false;
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    if (!edge) continue;
    const sourceRaw = rawAt(i);
    const targetRaw = rawAt(i + 1);
    if (!targetRaw?.ifKey) continue;
    // Only the edge that ENTERS the branch (source not already inside it).
    if (sourceRaw?.ifKey === targetRaw.ifKey) continue;

    if (targetRaw.ifKind === "alternate") {
      edge.kind = "conditional-false";
      edge.label = "else";
    } else {
      edge.kind = "conditional-true";
      if (targetRaw.ifTest) edge.label = truncate(targetRaw.ifTest);
    }
    if (targetRaw.ifTest?.includes("timedOut")) sawTimedOut = true;
  }

  const hasWait = nodes.some((n) => n.type === "wait");
  if (hasWait && sawTimedOut) {
    warnings.push(
      "waitForEvent timed-out/answered branches are shown as a linear path (v1)",
    );
  }
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
