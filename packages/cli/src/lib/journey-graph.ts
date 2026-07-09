import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { JourneyGraph } from "@hogsend/core";
import ts from "typescript";
import { resolveMemberLiteral } from "./const-resolver.js";

/**
 * Source-level journey graph extractor.
 *
 * At runtime a {@link DefinedJourney} only exposes `{ meta, task }` — the
 * `run()` closure is bundled away — so to show the INSIDE of a journey (the
 * sends, sleeps, waits, branches) we parse the authored `.ts` at dev time with
 * the TypeScript compiler API (pure syntax walk; no type-checker needed).
 *
 * Best-effort by design: the real journeys are sequential control flow with
 * shallow `if` and one `ctx.waitForEvent`, all handled here. Anything dynamic
 * (loops, switch, indirect dispatch) is skipped and recorded in `disclaimer`.
 *
 * Alternative considered: @babel/parser (already a dep of packages/inspector).
 * It would be lighter but offers no advantage for untyped statement-walking,
 * and `typescript` is already the repo's pinned compiler.
 */

/** The set of standalone send functions that map to a channel node. */
const CHANNEL_CALLS = new Set([
  "sendEmail",
  "sendFeedItem",
  "sendBanner",
  "sendSurvey",
  "sendConnectorAction",
]);

/**
 * Monotonic node-id generator, scoped per-extraction (not module-global) so
 * concurrent or interleaved extractions can't collide or reset each other.
 * Returns a function producing `n1`, `n2`, ...
 */
function makeNid(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `n${n}`;
  };
}

/** Best-effort literal value of a property in an object-literal expression. */
function literalString(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return node.text;
  // Identifier reference (e.g. `template: Foo`) — use its name so the node
  // reads as the constant the author referenced.
  if (ts.isIdentifier(node)) return node.text;
  // Property access (e.g. `Events.PAYMENT_FAILED`, `Templates.WELCOME`) — keep
  // the full text so event/template references read as the author wrote them.
  if (ts.isPropertyAccessExpression(node)) return node.getText();
  // Call expression (e.g. `days(3)`, `hours(1)`) — render as authored text so
  // durations read naturally.
  if (ts.isCallExpression(node)) return node.getText().replace(/\s+/g, " ");
  return undefined;
}

/**
 * Read a named property off an object-literal expression, returning the value
 * expression. Handles shorthand (`{ label }`) by matching the name.
 */
function propValue(
  obj: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText() === name) {
      return p.initializer;
    }
    if (ts.isShorthandPropertyAssignment(p) && p.name.getText() === name) {
      return p.name;
    }
  }
  return undefined;
}

/** Build a duration detail string from a `ctx.sleep({ duration })` arg. */
function durationDetail(
  obj: ts.ObjectLiteralExpression | undefined,
): string | undefined {
  if (!obj) return undefined;
  const dur = propValue(obj, "duration");
  if (!dur) return undefined;
  const text = dur.getText().replace(/\s+/g, " ");
  return text;
}

/** Recognize a `ctx.<method>(...)` or bare `<channel>(...)` call. */
interface RecognizedCall {
  /** "ctx" for context methods, or the channel fn name, or the callee text. */
  callee: string;
  /** First-arg object literal, if the call has one. */
  opts: ts.ObjectLiteralExpression | undefined;
  /** Full source text of the call, for display (used by `ctx.when.*`). */
  callText?: string;
}

/** Match an awaited expression, returning the recognized call shape. */
function recognizeAwait(
  expr: ts.Expression,
): { call: RecognizedCall } | undefined {
  let inner = expr;
  if (ts.isAwaitExpression(expr)) inner = expr.expression;
  // Strip parentheses.
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (!ts.isCallExpression(inner)) return undefined;
  const target = inner.expression;

  // ctx.when.<method>(...)() — the fluent scheduler builder is a double call:
  // the outer call's target is itself a CallExpression whose expression is a
  // PropertyAccessExpression chain ending in `.when`. Classify as callee
  // "when" so a schedule node is emitted.
  if (ts.isCallExpression(target) && endsInWhen(target.expression)) {
    return {
      call: {
        callee: "when",
        opts: undefined,
        callText: inner.getText().replace(/\s+/g, " "),
      },
    };
  }

  let callee: string | undefined;
  let opts: ts.ObjectLiteralExpression | undefined;
  // ctx.method(...)
  if (ts.isPropertyAccessExpression(target)) {
    callee = target.name.text;
  } else if (ts.isIdentifier(target)) {
    // sendEmail(...), bare function
    callee = target.text;
  }
  if (!callee) return undefined;
  const first = inner.arguments[0];
  if (first && ts.isObjectLiteralExpression(first)) opts = first;
  return { call: { callee, opts } };
}

/** True if `expr` is a `ctx.when.<method>(...)` call chain rooted at `ctx.when`. */
function endsInWhen(expr: ts.Expression): boolean {
  // Walk the property-access chain looking for a `ctx.when` root.
  // Handles `ctx.when.at("09:00").tz("...")` — at any point the chain
  // passes through a PropertyAccessExpression whose expression is `ctx.when`.
  let current: ts.Expression = expr;
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isCallExpression(current)
  ) {
    if (ts.isPropertyAccessExpression(current)) {
      if (current.expression.getText() === "ctx.when") return true;
      current = current.expression;
    } else {
      // CallExpression — inspect its callee.
      current = current.expression;
    }
  }
  return current.getText() === "ctx.when";
}

/**
 * The extraction state. `cursor` is the id of the node that the NEXT statement
 * should flow from on the main path. Branch arms temporarily fork into their
 * own tail and rejoin by returning the merged tail back to the caller.
 */
interface Walker {
  nodes: JourneyGraph["nodes"];
  edges: JourneyGraph["edges"];
  skipped: number;
  /** Per-extraction node-id generator (closure-local; no module-global). */
  nid: () => string;
  /** Lazily-created shared terminal node id (WS-2.5: one `end` per graph). */
  endId?: string;
  /** Per-graph disclaimer notes (loops, etc.) appended to the base disclaimer. */
  notes: string[];
  /**
   * Resolve a `<Object>.<member>` constant reference to a string literal by
   * following imports from the journey file (e.g. `Templates.WELCOME` →
   * `"welcome"`). Bound to the journey's file path at extraction start;
   * undefined when the source isn't on disk (returns undefined then).
   */
  resolveConst?: (objectName: string, memberName: string) => string | undefined;
}

/**
 * Derive an email node's `templateRef` (authored text) + `templateKey`
 * (resolved literal) from the `template:` value expression. String literals
 * resolve to themselves; `Templates.X` is resolved through the import graph;
 * anything dynamic yields no `templateKey` (the UI shows it as unresolved).
 */
function resolveTemplate(
  w: Walker,
  expr: ts.Expression | undefined,
): { templateRef?: string; templateKey?: string } {
  if (!expr) return {};
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return { templateRef: expr.text, templateKey: expr.text };
  }
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    return {
      templateRef: expr.getText(),
      templateKey: w.resolveConst?.(expr.expression.text, expr.name.text),
    };
  }
  return { templateRef: expr.getText().replace(/\s+/g, " ") };
}

/** Push a node and return its id. */
function pushNode(w: Walker, node: Omit<JourneyGraph["nodes"][number], "id">) {
  const id = w.nid();
  w.nodes.push({ id, ...node });
  return id;
}

/**
 * Return the shared terminal `end` node id for this graph, creating it lazily.
 * Multiple `return` statements and branch-termination points all flow into the
 * SAME end node (WS-2.5) — avoids N identical end nodes for N returns.
 */
function sharedEnd(w: Walker): string {
  if (!w.endId) {
    w.endId = pushNode(w, { kind: "end", label: "end" });
  }
  return w.endId;
}

/** Connect `from` -> `to`, optionally labelled. */
function edge(
  w: Walker,
  from: string | undefined,
  to: string,
  label?: string,
  kind?: JourneyGraph["edges"][number]["kind"],
) {
  if (!from) return;
  w.edges.push({ from, to, label, kind });
}

function labelFirstArmEdge(
  w: Walker,
  from: string,
  edgeStart: number,
  label: string,
  kind: JourneyGraph["edges"][number]["kind"],
  fallbackTo: string,
) {
  const first = w.edges
    .slice(edgeStart)
    .find((candidate) => candidate.from === from);
  if (first) {
    first.label = label;
    first.kind = kind;
    return;
  }
  edge(w, from, fallbackTo, label, kind);
}

/**
 * Walk a block of statements. Returns the tail node id (the last main-flow
 * node statements after this block should continue from), or `undefined` if
 * the block always returns (every path terminates).
 */
function walkBlock(
  w: Walker,
  statements: readonly ts.Statement[],
  cursor: string | undefined,
  sourceFile: ts.SourceFile,
): string | undefined {
  let tail = cursor;
  for (const stmt of statements) {
    tail = walkStatement(w, stmt, tail, sourceFile);
    if (!tail) {
      // This statement terminated the path (return). Remaining statements in
      // this block are unreachable on this path.
      return undefined;
    }
  }
  return tail;
}

/** 1-based line number for a node, for "open in editor" later. */
function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

/**
 * First positional string argument of a call expression (for
 * `ctx.checkpoint("label")`). Accepts the expression that wraps the call so it
 * works for both bare call statements and `const x = await …` initializers.
 */
function firstStringArgOf(expr: ts.Expression): string | undefined {
  let inner = expr;
  if (ts.isAwaitExpression(inner)) inner = inner.expression;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  if (!ts.isCallExpression(inner)) return undefined;
  return literalString(inner.arguments[0]);
}

/**
 * Classify an awaited call and append the matching node (or treat it as a
 * no-op predicate). Returns the new tail node id, or `undefined` if the call
 * terminated the path (it never does today). Takes an explicit `line` so it
 * works for both expression statements and variable-statement initializers.
 */
function handleAwaitedCall(
  w: Walker,
  call: RecognizedCall,
  cursor: string | undefined,
  line: number,
  expr: ts.Expression,
): string | undefined {
  const { callee, opts } = call;
  const optStr = (name: string): string | undefined =>
    opts ? literalString(propValue(opts, name)) : undefined;

  // ctx.when.* — the fluent scheduler builder (e.g.
  // `await ctx.when.at("09:00").tz("America/New_York")()`). Emitted as a
  // schedule node whose detail is the full call text. No countKey: the engine
  // doesn't write a stable currentNodeId for schedules.
  if (callee === "when") {
    const id = pushNode(w, {
      kind: "schedule",
      label: "schedule",
      detail: call.callText,
      sourceLine: line,
    });
    edge(w, cursor, id, undefined, "main");
    return id;
  }

  // Channel sends.
  if (CHANNEL_CALLS.has(callee)) {
    const label =
      callee === "sendEmail"
        ? (optStr("subject") ?? optStr("template") ?? "email")
        : callee === "sendConnectorAction"
          ? [optStr("connectorId"), optStr("action")]
              .filter(Boolean)
              .join("/") || "connector"
          : (optStr("title") ?? callee);
    const kind =
      callee === "sendEmail"
        ? "email"
        : callee === "sendConnectorAction"
          ? "connector"
          : "inapp";
    // For emails, resolve the template reference to a concrete key where we
    // can (literal or `Templates.X` via imports). `detail` keeps the authored
    // ref for display; `templateKey` is the reliable join to `email_sends`.
    const { templateRef, templateKey } =
      callee === "sendEmail"
        ? resolveTemplate(w, opts ? propValue(opts, "template") : undefined)
        : {};
    const detail = callee === "sendEmail" ? templateRef : undefined;
    const id = pushNode(w, {
      kind,
      label,
      detail,
      templateRef,
      templateKey,
      sourceLine: line,
    });
    edge(w, cursor, id, undefined, "main");
    return id;
  }

  // ctx.sleep / ctx.sleepUntil. NOTE: sleeps do NOT write `currentNodeId` in
  // the engine (sleeps are non-blocking durable waits), so no countKey — a
  // sleep node never carries a live count badge by design.
  if (callee === "sleep" || callee === "sleepUntil") {
    const label =
      optStr("label") ?? (callee === "sleep" ? "sleep" : "sleep until");
    const detail = durationDetail(opts);
    const id = pushNode(w, {
      kind: "sleep",
      label,
      detail,
      sourceLine: line,
    });
    edge(w, cursor, id, undefined, "main");
    return id;
  }

  // ctx.waitForEvent — decision node. The "fired" path continues as the main
  // cursor; a following `if (answer.timedOut)` block models the timeout arm as
  // a branch, so we don't emit a phantom timeout edge here.
  //
  // countKey MIRRORS the engine's `enterWait` key
  // (journey-context.ts: `label ?? \`wait-event:${event}\``) so the route's
  // per-node counts (grouped by `journeyStates.currentNodeId`) join correctly.
  // Without this, waits without an explicit label would key on the event name
  // here but on `wait-event:<event>` in the DB — counts invisible.
  if (callee === "waitForEvent") {
    const event = optStr("event");
    const label = optStr("label") ?? event ?? "wait for event";
    const timeout = opts
      ? literalString(propValue(opts, "timeout"))
      : undefined;
    const countKey =
      optStr("label") ?? (event ? `wait-event:${event}` : undefined);
    const id = pushNode(w, {
      kind: "wait",
      label,
      detail: timeout ? `timeout ${timeout}` : undefined,
      countKey,
      sourceLine: line,
    });
    edge(w, cursor, id, undefined, "main");
    return id;
  }

  // ctx.checkpoint — takes a positional string label, not an opts object.
  if (callee === "checkpoint") {
    const arg = firstStringArgOf(expr);
    const id = pushNode(w, {
      kind: "checkpoint",
      label: arg ?? "checkpoint",
      countKey: arg,
      sourceLine: line,
    });
    edge(w, cursor, id, undefined, "main");
    return id;
  }

  // ctx.trigger — emit a trigger-event node.
  if (callee === "trigger") {
    const label = optStr("event") ?? "trigger";
    const id = pushNode(w, { kind: "trigger-event", label, sourceLine: line });
    edge(w, cursor, id, undefined, "main");
    return id;
  }

  // ctx.history.*, ctx.guard.*, ctx.now(), ctx.once(...) — predicates/sources
  // that don't render as their own node (a following `if` captures them).
  if (
    callee === "hasEvent" ||
    callee === "journey" ||
    callee === "email" ||
    callee === "events" ||
    callee === "isSubscribed" ||
    callee === "now" ||
    callee === "once"
  ) {
    return cursor;
  }

  // Unknown awaited call.
  w.skipped += 1;
  return cursor;
}

/**
 * Walk a single statement. Returns the new tail (id of the main-flow node the
 * next statement continues from), or `undefined` if the path terminated here.
 */
function walkStatement(
  w: Walker,
  stmt: ts.Statement,
  cursor: string | undefined,
  sourceFile: ts.SourceFile,
): string | undefined {
  // Expression statement (covers `await ...` calls).
  if (ts.isExpressionStatement(stmt)) {
    const recognized = recognizeAwait(stmt.expression);
    if (!recognized) {
      w.skipped += 1;
      return cursor;
    }
    return handleAwaitedCall(
      w,
      recognized.call,
      cursor,
      lineOf(sourceFile, stmt),
      stmt.expression,
    );
  }

  // if / else — branch diamond.
  if (ts.isIfStatement(stmt)) {
    const condText = stmt.expression.getText().replace(/\s+/g, " ");
    const branchId = pushNode(w, {
      kind: "branch",
      label: condText,
      sourceLine: lineOf(sourceFile, stmt),
    });
    edge(w, cursor, branchId, undefined, "main");

    // Consequent (yes arm).
    const yesStatements = ts.isBlock(stmt.thenStatement)
      ? stmt.thenStatement.statements
      : [stmt.thenStatement];
    const yesEdgeStart = w.edges.length;
    const yesTail = walkBlock(w, yesStatements, branchId, sourceFile);
    labelFirstArmEdge(
      w,
      branchId,
      yesEdgeStart,
      "yes",
      "yes",
      yesTail ?? pushEnd(w),
    );

    // Alternate (no arm).
    if (stmt.elseStatement) {
      const noStatements = ts.isBlock(stmt.elseStatement)
        ? stmt.elseStatement.statements
        : [stmt.elseStatement];
      const noEdgeStart = w.edges.length;
      const noTail = walkBlock(w, noStatements, branchId, sourceFile);
      labelFirstArmEdge(
        w,
        branchId,
        noEdgeStart,
        "no",
        "no",
        noTail ?? pushEnd(w),
      );
      // If both arms terminate, the path ends.
      if (!yesTail && !noTail) return undefined;
      // Continue main flow from whichever arm didn't return. The common
      // `if (x) return;` idiom: yes arm ends, no arm continues.
      return noTail ?? yesTail ?? undefined;
    }
    // No else: the "no" path falls through to the next statement from the
    // branch itself (the next statement's edge is the implicit "no" path).
    return branchId;
  }

  // return — terminates the path, flowing into the shared end node (WS-2.5:
  // one end node per graph regardless of how many returns exist).
  if (ts.isReturnStatement(stmt)) {
    const endId = sharedEnd(w);
    edge(w, cursor, endId, undefined, "main");
    return undefined;
  }

  // Variable statements — inspect initializers for awaited calls so we don't
  // lose context method calls hidden inside `const x = await ctx.method()`
  // (e.g. `const { found } = await ctx.history.hasEvent(...)` is a predicate
  // that should NOT render its own node; `const ans = await ctx.waitForEvent`
  // should). We walk the original initializer expression directly so source
  // positions stay real.
  if (ts.isVariableStatement(stmt)) {
    for (const d of stmt.declarationList.declarations) {
      if (d.initializer) {
        const recognized = recognizeAwait(d.initializer);
        if (recognized) {
          const tail = handleAwaitedCall(
            w,
            recognized.call,
            cursor,
            lineOf(sourceFile, d),
            d.initializer,
          );
          if (tail === undefined) continue;
          cursor = tail;
        }
      }
    }
    return cursor;
  }

  // switch — model as a single branch on the discriminant; walk every case
  // body as one combined arm (case-by-case precision isn't worth the noise for
  // the sequential journeys in practice).
  if (ts.isSwitchStatement(stmt)) {
    const branchId = pushNode(w, {
      kind: "branch",
      label: `switch(${stmt.expression.getText().replace(/\s+/g, " ")})`,
      sourceLine: lineOf(sourceFile, stmt),
    });
    edge(w, cursor, branchId, undefined, "main");
    // Flatten case bodies into one statement list. Cases often wrap their body
    // in a Block (`case "x": { ... }`); unwrap those so the inner statements
    // are walked directly. `break` statements terminate the case (no node).
    const caseStatements: ts.Statement[] = [];
    for (const c of stmt.caseBlock.clauses) {
      for (const s of c.statements) {
        if (ts.isBlock(s)) caseStatements.push(...s.statements);
        else if (ts.isBreakStatement(s)) continue;
        else caseStatements.push(s);
      }
    }
    const tail = walkBlock(w, caseStatements, branchId, sourceFile);
    return tail ?? branchId;
  }

  // Loops (for / for-in / for-of / while / do-while) — walk the body ONCE on
  // the main path (the loop-back isn't modeled) and note the simplification.
  // Without this, an `await sendEmail(...)` inside a loop body was invisible.
  const loopBody = getLoopBody(stmt);
  if (loopBody !== undefined) {
    w.notes.push("Loop body shown once; iterations not modeled.");
    const statements = ts.isBlock(loopBody) ? loopBody.statements : [loopBody];
    return walkBlock(w, statements, cursor, sourceFile) ?? cursor;
  }

  // try / catch / finally — walk the try body on the main path, the catch body
  // as a branch arm, and the finally on the main path.
  if (ts.isTryStatement(stmt)) {
    let tail = cursor;
    if (stmt.tryBlock) {
      tail = walkBlock(w, stmt.tryBlock.statements, tail, sourceFile) ?? tail;
    }
    if (stmt.catchClause) {
      const catchBlock = stmt.catchClause.block;
      const catchBranch = pushNode(w, {
        kind: "branch",
        label: "catch",
        sourceLine: lineOf(sourceFile, stmt.catchClause),
      });
      edge(w, cursor, catchBranch, undefined, "main");
      const catchTail = walkBlock(
        w,
        catchBlock.statements,
        catchBranch,
        sourceFile,
      );
      edge(w, catchBranch, catchTail ?? sharedEnd(w), "caught", "yes");
      tail = catchTail ?? tail;
    }
    if (stmt.finallyBlock) {
      tail =
        walkBlock(w, stmt.finallyBlock.statements, tail, sourceFile) ?? tail;
    }
    return tail;
  }

  w.skipped += 1;
  return cursor;
}

/** Extract the body of a loop statement, or undefined if `stmt` isn't a loop. */
function getLoopBody(stmt: ts.Statement): ts.Statement | undefined {
  if (ts.isForStatement(stmt)) return stmt.statement;
  if (ts.isForInStatement(stmt)) return stmt.statement;
  if (ts.isForOfStatement(stmt)) return stmt.statement;
  if (ts.isWhileStatement(stmt)) return stmt.statement;
  if (ts.isDoStatement(stmt)) return stmt.statement;
  return undefined;
}

/** Helper: the shared end node (used when a branch arm fully terminates). */
function pushEnd(w: Walker): string {
  return sharedEnd(w);
}

/**
 * Parse `meta: { id, trigger: { event }, exitOn: [...] }` from a
 * `defineJourney` call's object literal — a shallow scan, no evaluation.
 */
interface ParsedMeta {
  id: string;
  triggerEvent: string;
  exitOn: string[];
}

function parseMetaLite(arg: ts.Expression): ParsedMeta | undefined {
  if (!ts.isObjectLiteralExpression(arg)) return undefined;
  const metaExpr = arg.properties.find(
    (p) => ts.isPropertyAssignment(p) && p.name.getText() === "meta",
  );
  if (!metaExpr || !ts.isPropertyAssignment(metaExpr)) return undefined;
  const meta = metaExpr.initializer;
  if (!ts.isObjectLiteralExpression(meta)) return undefined;

  const idProp = meta.properties.find(
    (p) => ts.isPropertyAssignment(p) && p.name.getText() === "id",
  );
  const triggerProp = meta.properties.find(
    (p) => ts.isPropertyAssignment(p) && p.name.getText() === "trigger",
  );
  if (!idProp || !triggerProp) return undefined;
  if (
    !ts.isPropertyAssignment(idProp) ||
    !ts.isPropertyAssignment(triggerProp)
  ) {
    return undefined;
  }
  const id = literalString(idProp.initializer);
  const triggerObj = triggerProp.initializer;
  if (!id || !ts.isObjectLiteralExpression(triggerObj)) return undefined;
  const eventProp = triggerObj.properties.find(
    (p) => ts.isPropertyAssignment(p) && p.name.getText() === "event",
  );
  if (!eventProp || !ts.isPropertyAssignment(eventProp)) return undefined;
  const triggerEvent = literalString(eventProp.initializer);
  if (!triggerEvent) return undefined;

  const exitOn: string[] = [];
  const exitProp = meta.properties.find(
    (p) => ts.isPropertyAssignment(p) && p.name.getText() === "exitOn",
  );
  if (exitProp && ts.isPropertyAssignment(exitProp)) {
    const exitInit = exitProp.initializer;
    if (ts.isArrayLiteralExpression(exitInit)) {
      for (const el of exitInit.elements) {
        if (ts.isObjectLiteralExpression(el)) {
          const ev = el.properties.find(
            (p) => ts.isPropertyAssignment(p) && p.name.getText() === "event",
          );
          if (ev && ts.isPropertyAssignment(ev)) {
            const name = literalString(ev.initializer);
            if (name) exitOn.push(name);
          }
        }
      }
    }
  }
  return { id, triggerEvent, exitOn };
}

/**
 * Find the `defineJourney({ meta, run })` call in a source file and return its
 * argument object literal. Returns `undefined` if not found.
 */
function findDefineJourneyArg(
  sf: ts.SourceFile,
): ts.ObjectLiteralExpression | undefined {
  let result: ts.ObjectLiteralExpression | undefined;
  function visit(node: ts.Node) {
    if (result) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "defineJourney"
    ) {
      const first = node.arguments[0];
      if (first && ts.isObjectLiteralExpression(first)) {
        result = first;
      }
    }
    node.forEachChild(visit);
  }
  visit(sf);
  return result;
}

/**
 * Resolve the `run` body to a list of statements, handling three authoring
 * shapes:
 *   1. `run: async (user, ctx) => { ... }`  — inline arrow (the common case).
 *   2. `run: someFn` where `someFn` is a top-level FunctionDeclaration or a
 *      `const someFn = async (...) => {...}` in the SAME file — resolve and
 *      walk its body. (The documented vitest-friendly standalone-export
 *      pattern, e.g. demo-inapp.ts.)
 *   3. `run: importedFn` (unresolvable) — return `null`; the caller emits a
 *      metadata-level graph with a body placeholder + disclaimer.
 *
 * Returns `{ statements }` (possibly empty), or `null` if unresolvable.
 */
function resolveRunBody(
  arg: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
): readonly ts.Statement[] | null {
  const runProp = arg.properties.find(
    (p) => ts.isPropertyAssignment(p) && p.name.getText() === "run",
  );
  if (!runProp || !ts.isPropertyAssignment(runProp)) return null;
  const init = runProp.initializer;

  // Case 1: inline arrow.
  if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
    return blockStatements(init.body);
  }

  // Case 2: identifier reference — find a same-file definition.
  if (ts.isIdentifier(init)) {
    const name = init.text;
    // FunctionDeclaration: `function someFn(user, ctx) { ... }`
    const fnDecl = findNode(
      sourceFile,
      (n) => ts.isFunctionDeclaration(n) && n.name?.text === name,
    );
    if (fnDecl && ts.isFunctionDeclaration(fnDecl) && fnDecl.body) {
      return blockStatements(fnDecl.body);
    }
    // const someFn = async (user, ctx) => { ... }
    const varDecl = findNode(sourceFile, (n) => {
      if (!ts.isVariableStatement(n)) return false;
      return n.declarationList.declarations.some(
        (d) =>
          ts.isIdentifier(d.name) &&
          d.name.text === name &&
          d.initializer !== undefined &&
          (ts.isArrowFunction(d.initializer) ||
            ts.isFunctionExpression(d.initializer)),
      );
    });
    if (varDecl && ts.isVariableStatement(varDecl)) {
      for (const d of varDecl.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          d.name.text === name &&
          d.initializer &&
          (ts.isArrowFunction(d.initializer) ||
            ts.isFunctionExpression(d.initializer))
        ) {
          return blockStatements(d.initializer.body);
        }
      }
    }
    // Case 3: unresolvable (imported from another module).
    return null;
  }

  return null;
}

/** Statements of a function body (Block) or a single expression statement. */
function blockStatements(
  body: ts.Block | ts.Expression,
): readonly ts.Statement[] {
  if (ts.isBlock(body)) return body.statements;
  // Expression-body arrow: `(x) => doThing()` — wrap as a single statement.
  return [ts.factory.createExpressionStatement(body)];
}

/** First node in `sourceFile` matching `pred` (depth-first). */
function findNode(
  sourceFile: ts.SourceFile,
  pred: (n: ts.Node) => boolean,
): ts.Node | undefined {
  let result: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (result) return;
    if (pred(node)) {
      result = node;
      return;
    }
    node.forEachChild(visit);
  }
  visit(sourceFile);
  return result;
}

/**
 * Extract a {@link JourneyGraph} from a journey `.ts` file's source text.
 *
 * Throws if no `defineJourney({ run })` is found. Best-effort: dynamic control
 * flow is skipped and noted in `disclaimer`.
 */
export function extractJourneyGraph(
  filePath: string,
  sourceText?: string,
): JourneyGraph {
  const text = sourceText ?? readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const arg = findDefineJourneyArg(sourceFile);
  if (!arg) {
    throw new Error(
      `journey-graph: no defineJourney({ ... }) call found in ${filePath}`,
    );
  }

  // Per-extraction Walker: closure-local nid (no module-global counter), a
  // lazily-shared end node, and a notes buffer for per-graph disclaimers.
  const w: Walker = {
    nodes: [],
    edges: [],
    skipped: 0,
    nid: makeNid(),
    notes: [],
    // Resolve `Templates.X`-style refs by following imports from THIS file.
    // Reads sibling `.ts` on disk; harmless (returns undefined) when the
    // journey isn't backed by a real file path.
    resolveConst: (objectName, memberName) =>
      resolveMemberLiteral(filePath, objectName, memberName),
  };

  // Seed trigger + exit nodes from the lite meta parse. The trigger's countKey
  // is the literal "start" — that's the value the engine writes to
  // `journeyStates.currentNodeId` at journey creation (define-journey.ts),
  // so per-node counts for users sitting at the very beginning (before any
  // checkpoint/wait) join onto the trigger node.
  const meta = parseMetaLite(arg);
  const triggerId = pushNode(w, {
    kind: "trigger",
    label: meta?.triggerEvent ?? "trigger",
    countKey: "start",
  });

  // Resolve the run body. An inline arrow is walked directly; a referenced
  // same-file function is resolved and walked; an unresolvable reference
  // (imported) falls back to a metadata-level body placeholder (no throw —
  // the journey still shows its trigger + exits).
  const statements = resolveRunBody(arg, sourceFile);
  if (statements === null) {
    const placeholder = pushNode(w, {
      kind: "checkpoint",
      label: "run() body",
      detail: "referenced function — open the source to see the flow",
    });
    edge(w, triggerId, placeholder, undefined, "main");
    edge(w, placeholder, sharedEnd(w), undefined, "main");
    w.notes.push("run() references an imported function; body not analyzed.");
  } else {
    const tail = walkBlock(w, statements, triggerId, sourceFile);
    // If the main path didn't terminate with an explicit return, flow into the
    // shared end node.
    if (tail) {
      edge(w, tail, sharedEnd(w), undefined, "main");
    }
  }

  // Append exitOn events as dangling exit nodes off the trigger (they can fire
  // at any point during the run).
  for (const exitEvent of meta?.exitOn ?? []) {
    const exitId = pushNode(w, { kind: "exit", label: exitEvent });
    edge(w, triggerId, exitId, "exit", "main");
  }

  // Assemble the disclaimer: skipped-statement count + any per-graph notes
  // (loop bodies, switch simplifications, etc.).
  const parts: string[] = [];
  if (w.skipped > 0) {
    parts.push(
      `Best-effort graph: ${w.skipped} statement(s) were skipped (dynamic control flow may be hidden).`,
    );
  }
  parts.push(...w.notes);
  const disclaimer = parts.length > 0 ? parts.join(" ") : undefined;

  return {
    journeyId: meta?.id ?? filePath,
    nodes: w.nodes,
    edges: w.edges,
    sourceLevel: "rich",
    disclaimer,
    // sourceFile is relativized by the caller (generateAll / the CLI command),
    // which knows the project root; the extractor only knows the input path.
    // The hash lets the admin route detect a stale manifest by re-hashing the
    // on-disk file (dev; in prod images the source is absent and the check is
    // skipped).
    sourceHash: createHash("sha256").update(text).digest("hex"),
  };
}

/**
 * Extract a graph and return only the lite-parsed `id` — used to match a CLI
 * `<id>` argument to the right source file when scanning a journeys directory.
 */
export function extractJourneyId(filePath: string): string | undefined {
  try {
    const text = readFileSync(filePath, "utf8");
    const sf = ts.createSourceFile(
      filePath,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const arg = findDefineJourneyArg(sf);
    if (!arg) return undefined;
    return parseMetaLite(arg)?.id;
  } catch {
    return undefined;
  }
}
