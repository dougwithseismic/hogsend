import type { JsonValue } from "@hatchet-dev/typescript-sdk/v1/types.js";
import {
  type BlueprintGraph,
  BlueprintNodeExecutionError,
  BlueprintUnreachableNodeError,
  type DurationObject,
  evaluateCondition,
  isReservedEventName,
  type JourneyEdge,
  type JourneyNode,
  type PropertyCondition,
  RESERVED_EVENT_NAMESPACES,
  serializeBlueprintError,
  validateBlueprintGraph,
} from "@hogsend/core";
import type {
  JourneyContext,
  JourneyMeta,
  JourneyUser,
} from "@hogsend/core/types";
import { type Database, journeyBlueprints, journeyStates } from "@hogsend/db";
import type { TemplateName } from "@hogsend/email";
import { and, eq, notInArray } from "drizzle-orm";
import {
  BLUEPRINT_RUN_EVENT,
  JOURNEY_EXECUTION_TIMEOUT,
  JOURNEY_SCHEDULE_TIMEOUT,
} from "../journeys/constants.js";
import { JourneyExitedError } from "../journeys/errors.js";
import {
  type EventPayloadInput,
  executeJourneyRun,
} from "../journeys/execute-journey-run.js";
import { TERMINAL_STATUSES } from "../journeys/journey-context.js";
import { logTransition } from "../journeys/journey-log.js";
import { sendConnectorAction } from "../lib/connector-actions.js";
import { getDb } from "../lib/db.js";
import { sendEmail } from "../lib/email.js";
import { hatchet } from "../lib/hatchet.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger(process.env.LOG_LEVEL);

/** A `journey_blueprints` row as Drizzle returns it. */
export type JourneyBlueprintRow = typeof journeyBlueprints.$inferSelect;

/**
 * Build the `JourneyMeta` the shared run lifecycle consumes from a
 * `journey_blueprints` row. The row's trigger/entry/exit/suppress columns
 * mirror `JourneyMeta` 1:1 by design (spec §4) so the SAME enrollment-guard
 * functions `defineJourney` uses receive it verbatim — `status !== "enabled"`
 * is the blueprint's `meta.enabled === false`. The jsonb columns are opaque in
 * `@hogsend/db` (db cannot import core), so this is the single read-site
 * narrowing, per the `campaigns.steps` convention.
 */
export function blueprintMetaFromRow(row: JourneyBlueprintRow): JourneyMeta {
  const triggerWhere = (row.triggerWhere ?? undefined) as
    | PropertyCondition[]
    | undefined;
  return {
    id: row.id,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    enabled: row.status === "enabled",
    trigger: {
      event: row.triggerEvent,
      ...(triggerWhere?.length ? { where: triggerWhere } : {}),
    },
    entryLimit: row.entryLimit,
    ...(row.entryPeriod
      ? { entryPeriod: row.entryPeriod as DurationObject }
      : {}),
    ...(row.exitOn?.length
      ? { exitOn: row.exitOn as NonNullable<JourneyMeta["exitOn"]> }
      : {}),
    // `{}` / zero duration disables the suppress guard — same contract as
    // JourneyMeta.suppress (the boundary maps it to suppressMs: 0).
    suppress: (row.suppress ?? {}) as DurationObject,
  };
}

/**
 * Errors the per-node wrap must NOT swallow into a `BlueprintNodeExecutionError`:
 *  - `JourneyExitedError` — a control-flow signal (exitOn / cancel / the
 *    `end-exited` node); the lifecycle catch maps it to `status: "exited"`.
 *  - Hatchet's AbortError — a graceful-shutdown RELEASE; wrapping it would
 *    defeat the lifecycle's abort detection and poison the enrollment with a
 *    false "failed".
 *  - Blueprint errors already carrying their node id.
 */
function isWalkPassThroughError(err: unknown): boolean {
  if (err instanceof JourneyExitedError) return true;
  if (
    err instanceof BlueprintNodeExecutionError ||
    err instanceof BlueprintUnreachableNodeError
  ) {
    return true;
  }
  return (
    err instanceof Error &&
    (err.name === "AbortError" ||
      (err as { code?: string }).code === "ABORT_ERR")
  );
}

/** Narrow a required meta field, throwing the typed node error when absent.
 * Unreachable for a graph that passed `validateBlueprintGraph` (the schema
 * requires per-variant meta) — jsonb defense-in-depth plus TS narrowing. */
function requireNodeMeta<T>(
  blueprintId: string,
  node: { id: string; type: string },
  field: string,
  value: T | undefined | null,
): T {
  if (value === undefined || value === null) {
    throw new BlueprintNodeExecutionError(
      blueprintId,
      node.id,
      `${node.type} node is missing required meta.${field}`,
    );
  }
  return value;
}

export interface WalkBlueprintGraphOptions {
  blueprintId: string;
  /** A graph that passed {@link validateBlueprintGraph}. */
  graph: BlueprintGraph;
  user: JourneyUser;
  ctx: JourneyContext;
  db: Database;
}

/**
 * Tree-walk a validated blueprint graph, executing each node through the
 * EXACT same primitives a code journey calls (spec §6): `ctx.sleep`,
 * `ctx.waitForEvent`, `ctx.checkpoint`, `ctx.trigger`, `sendEmail()`,
 * `sendConnectorAction()`, `evaluateCondition()`. Every label/idempotencyLabel
 * is the node id — as replay-stable as a hand-authored `ctx.sleep({ label })`
 * — so the existing two-layer exactly-once machinery applies unchanged.
 *
 * The dispatch is an exhaustive `switch` over the FULL `JourneyNodeType`
 * union with a compiler-enforced `never` default (spec §6.1): adding a node
 * type without an interpreter case is a compile error, and the four
 * non-executable display-tier types throw typed errors as defense-in-depth
 * (validation already rejected them).
 */
export async function walkBlueprintGraph(
  opts: WalkBlueprintGraphOptions,
): Promise<void> {
  const { blueprintId, graph, user, ctx, db } = opts;

  // The execution tier is a compile-asserted narrowing of the display tier,
  // so widening to `JourneyNode` is free — and it is what lets the switch
  // below cover the FULL node-type vocabulary (a `BlueprintNode`-typed switch
  // could not even name the non-executable cases).
  const nodes: JourneyNode[] = graph.nodes;
  const nodesById = new Map<string, JourneyNode>(
    nodes.map((node) => [node.id, node]),
  );
  const outgoing = new Map<string, JourneyEdge[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge);
    outgoing.set(edge.source, list);
  }

  const start = nodes.find((node) => node.type === "start");
  if (!start) {
    // Unreachable post-validation (findStartNodeIssues) — defense-in-depth.
    throw new BlueprintNodeExecutionError(
      blueprintId,
      "start",
      "graph has no start node",
    );
  }

  /** The single unconditional next hop. Zero outgoing edges ends the walk —
   * the run returns and the lifecycle marks the enrollment completed, exactly
   * like a code journey's `run()` running off the end of its body. */
  const defaultNext = (node: JourneyNode): string | null => {
    const edges = outgoing.get(node.id) ?? [];
    if (edges.length === 0) return null;
    if (edges.length === 1) {
      // length === 1 → the single element exists; TS can't see that.
      return edges[0]?.target ?? null;
    }
    throw new BlueprintNodeExecutionError(
      blueprintId,
      node.id,
      `a ${node.type} node cannot fork (${edges.length} outgoing edges)`,
    );
  };

  /** Pick the outgoing edge whose `kind` matches, throwing when absent. */
  const nextByKind = (node: JourneyNode, kind: JourneyEdge["kind"]): string => {
    const edge = (outgoing.get(node.id) ?? []).find((e) => e.kind === kind);
    if (!edge) {
      throw new BlueprintNodeExecutionError(
        blueprintId,
        node.id,
        `no outgoing edge with kind "${kind}"`,
      );
    }
    return edge.target;
  };

  /** Execute one node; returns the next node id, or null to end the walk. */
  const executeNode = async (node: JourneyNode): Promise<string | null> => {
    switch (node.type) {
      case "start":
        return defaultNext(node);

      case "sleep": {
        const duration = requireNodeMeta(
          blueprintId,
          node,
          "duration",
          node.meta?.duration,
        );
        await ctx.sleep({
          duration: duration as DurationObject,
          label: node.id,
        });
        return defaultNext(node);
      }

      case "wait": {
        const event = requireNodeMeta(
          blueprintId,
          node,
          "event",
          node.meta?.event,
        );
        const timeout = requireNodeMeta(
          blueprintId,
          node,
          "timeout",
          node.meta?.timeout,
        );
        const result = await ctx.waitForEvent({
          event,
          timeout: timeout as DurationObject,
          label: node.id,
        });
        // A forking wait branches on the answer (validation guarantees the
        // answered/timedOut pair); a single unconditional edge (or none)
        // continues regardless of the outcome.
        const edges = outgoing.get(node.id) ?? [];
        if (edges.length === 2) {
          return nextByKind(node, result.timedOut ? "timedOut" : "answered");
        }
        return defaultNext(node);
      }

      case "send": {
        const template = requireNodeMeta(
          blueprintId,
          node,
          "template",
          node.meta?.template,
        );
        // subject omitted → the tracked mailer falls back to the template
        // registry's defaultSubject. idempotencyLabel = the node id (unique
        // per graph), so the derived exactly-once key is branch-stable even
        // when two sends of the same template share a nearest wait label.
        await sendEmail({
          to: user.email,
          userId: user.id,
          journeyStateId: user.stateId,
          template: template as TemplateName,
          journeyName: user.journeyName,
          props: user.properties,
          idempotencyLabel: node.meta?.idempotencyLabel ?? node.id,
        });
        return defaultNext(node);
      }

      case "connector": {
        const connectorId = requireNodeMeta(
          blueprintId,
          node,
          "connectorId",
          node.meta?.connectorId,
        );
        const action = requireNodeMeta(
          blueprintId,
          node,
          "action",
          node.meta?.action,
        );
        // KNOWN PRE-EXISTING GAP (spec §15): sendConnectorAction's Layer-2
        // backstop covers replays, but in degraded (pre-eviction) mode a
        // crash between the provider call and the status flip can still
        // double-send — same exposure a code journey's connector call has.
        await sendConnectorAction({
          connectorId,
          action,
          idempotencyLabel: node.id,
        });
        return defaultNext(node);
      }

      case "checkpoint":
        await ctx.checkpoint(node.id);
        return defaultNext(node);

      case "trigger": {
        const event = requireNodeMeta(
          blueprintId,
          node,
          "event",
          node.meta?.event,
        );
        // Save-time validation rejects reserved namespaces since the check
        // was added, but the graph column is jsonb — a row saved BEFORE the
        // rule (or written out-of-band) must still never forge an
        // engine-emitted event through the ingest pipeline.
        if (isReservedEventName(event)) {
          throw new BlueprintNodeExecutionError(
            blueprintId,
            node.id,
            `trigger node event "${event}" uses a reserved namespace (${RESERVED_EVENT_NAMESPACES.join("/")})`,
          );
        }
        await ctx.trigger({
          event,
          userId: user.id,
          userEmail: user.email,
          idempotencyLabel: node.id,
        });
        return defaultNext(node);
      }

      case "branch":
      case "decision": {
        const conditions = node.meta?.conditions;
        if (!conditions?.length) {
          throw new BlueprintNodeExecutionError(
            blueprintId,
            node.id,
            `${node.type} node has no conditions to evaluate`,
          );
        }
        // AND across the array (a single composite condition expresses OR).
        // Recorded via ctx.once so the verdict is durable on ANY engine: a
        // decision may read live DB state (event / email_engagement
        // conditions), and a replay re-evaluating it could flip the branch —
        // diverging the positional durable journal AND selecting a different
        // downstream template. Exactly the non-deterministic-discriminant
        // case ctx.once exists for; the node id keys the record.
        const passed = await ctx.once(`decision:${node.id}`, async () => {
          for (const condition of conditions) {
            const matched = await evaluateCondition({
              condition,
              ctx: { db, userId: user.id, journeyContext: user.properties },
            });
            if (!matched) return false;
          }
          return true;
        });
        return nextByKind(
          node,
          passed ? "conditional-true" : "conditional-false",
        );
      }

      case "end-completed":
        // Terminal: the run returns and the shared lifecycle marks the
        // enrollment completed + pushes journey:completed — identical to a
        // code journey's run() returning normally.
        return null;

      case "end-exited": {
        // Terminal: flip the row terminal the same way checkExits does, then
        // abort the run via the SAME control-flow signal a mid-wait exit
        // uses — the lifecycle catch maps it to { status: "exited" } without
        // a "failed" write or a journey:failed push. Idempotent on replay
        // (the guarded update no-ops once terminal).
        const [exited] = await db
          .update(journeyStates)
          .set({
            status: "exited",
            exitedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(journeyStates.id, user.stateId),
              notInArray(journeyStates.status, [...TERMINAL_STATUSES]),
            ),
          )
          .returning({ id: journeyStates.id });
        if (exited) {
          logTransition({
            db,
            journeyStateId: user.stateId,
            from: null,
            to: "end-exited",
            action: "exited",
          });
        }
        throw new JourneyExitedError(user.stateId);
      }

      case "end-failed":
        // Terminal: matches a code journey's thrown error — the lifecycle
        // marks the row "failed" (structured errorMessage via serializeError),
        // pushes journey:failed, and rethrows so the Hatchet run fails.
        throw new BlueprintNodeExecutionError(
          blueprintId,
          node.id,
          "the walk reached an end-failed terminal node",
        );

      // Non-executable display-tier types (NON_EXECUTABLE_NODE_TYPES).
      // Unreachable in practice — validateBlueprintGraph rejected them at
      // save time AND again at execution time — but the switch covers the
      // FULL JourneyNodeType vocabulary so reaching one throws the typed
      // error instead of walking past it silently (spec §6.1).
      case "sleepUntil":
      case "capture":
      case "digest":
      case "unknown":
        throw new BlueprintNodeExecutionError(
          blueprintId,
          node.id,
          `node type "${node.type}" is not executable in a blueprint`,
        );

      default: {
        // Compiler-enforced exhaustiveness: adding a JourneyNodeType without
        // an interpreter case is a COMPILE error, not a silent no-op.
        const _exhaustive: never = node;
        throw new BlueprintNodeExecutionError(
          blueprintId,
          (_exhaustive as JourneyNode).id,
          `unhandled node type: ${(_exhaustive as JourneyNode).type}`,
        );
      }
    }
  };

  let currentId: string | null = start.id;
  let steps = 0;
  while (currentId !== null) {
    const node = nodesById.get(currentId);
    if (!node) {
      // An edge pointed at a node that does not exist. Unreachable post-
      // validation (findInvalidEdgeEndpoints) — defense-in-depth.
      throw new BlueprintUnreachableNodeError(blueprintId, currentId);
    }
    // Acyclicity backstop: a validated graph visits each node at most once,
    // so a walk longer than the node count means a cycle slipped past
    // validation — fail loudly instead of spinning durable sleeps forever.
    steps += 1;
    if (steps > nodes.length) {
      throw new BlueprintNodeExecutionError(
        blueprintId,
        node.id,
        "tree-walk exceeded the graph's node count — the graph is not acyclic",
      );
    }
    try {
      currentId = await executeNode(node);
    } catch (err) {
      if (isWalkPassThroughError(err)) throw err;
      // Any other failure is pinned to the node that raised it, so
      // journeyStates.errorMessage / Studio can point at exactly what broke.
      throw new BlueprintNodeExecutionError(blueprintId, node.id, err);
    }
  }
}

/**
 * The event payload `checkBlueprintTriggers` pushes for each matching enabled
 * blueprint — one push per (blueprint, user) enrollment attempt.
 */
export interface BlueprintRunPayload {
  blueprintId: JsonValue;
  blueprintVersion: JsonValue;
  userId: JsonValue;
  userEmail: JsonValue;
  triggerProperties: JsonValue;
  [key: string]: JsonValue;
}

/**
 * The generic blueprint interpreter — ONE statically-registered durable task
 * for ALL blueprints, ever (spec §5): blueprints created/edited/enabled at
 * runtime need no worker redeploy because dispatch is a DB lookup at ingest
 * (`checkBlueprintTriggers`) feeding this task via `blueprint:run`, not a
 * per-blueprint `onEvents` registration.
 *
 * Each run loads the blueprint row, re-validates the stored graph
 * (defense-in-depth — jsonb is not trusted at execution time either), builds
 * the row's `JourneyMeta` mirror, and hands the tree-walk to the SAME
 * `executeJourneyRun` lifecycle `defineJourney` tasks use — identical
 * enrollment guards, replay recovery, journey context, replay-safety
 * boundary, and terminal transitions.
 */
export const journeyBlueprintInterpreter = hatchet.durableTask({
  name: "journey-blueprint-interpreter",
  onEvents: [BLUEPRINT_RUN_EVENT],
  executionTimeout: JOURNEY_EXECUTION_TIMEOUT,
  // retries STAYS 0 — same "missed > doubled" rationale as define-journey's
  // task config: a retry replays side effects whose durable status flip may
  // not have committed.
  retries: 0,
  scheduleTimeout: JOURNEY_SCHEDULE_TIMEOUT,
  fn: async (input: BlueprintRunPayload, hatchetCtx) => {
    const db = getDb();
    const blueprintId = input.blueprintId as string;

    const row = await db.query.journeyBlueprints.findFirst({
      where: eq(journeyBlueprints.id, blueprintId),
    });
    if (!row) {
      logger.warn("blueprint run skipped: blueprint not found", {
        blueprintId,
      });
      return { status: "skipped", reason: "blueprint_not_found" };
    }

    // Defense-in-depth (spec §6): a saved blueprint already passed
    // validateBlueprintGraph at save time, but the graph column is still
    // jsonb — never execute it without re-validating.
    const validated = validateBlueprintGraph(row.graph);
    if (!validated.valid) {
      logger.error(
        "blueprint run skipped: stored graph failed execution-time validation",
        { blueprintId, issues: validated.issues },
      );
      return { status: "skipped", reason: "invalid_blueprint_graph" };
    }

    // Version pin (spec §12): the version this run enrolled under, recorded
    // into journeyStates.context.__blueprintVersion on FIRST entry (a replay
    // recovers the existing row — extraContext is never re-written). v1 keeps
    // no graph history, so a drifted row can only execute the CURRENT graph —
    // surface the drift loudly instead of failing the run.
    const enrolledVersion =
      typeof input.blueprintVersion === "number"
        ? input.blueprintVersion
        : row.version;
    if (enrolledVersion !== row.version) {
      logger.warn(
        "blueprint version drifted since this run was dispatched; executing the current graph",
        { blueprintId, enrolledVersion, currentVersion: row.version },
      );
    }

    const meta = blueprintMetaFromRow(row);
    const graph = validated.graph;

    return executeJourneyRun({
      meta,
      run: (user, ctx) =>
        walkBlueprintGraph({ blueprintId: row.id, graph, user, ctx, db }),
      input: {
        userId: input.userId,
        userEmail: input.userEmail,
        properties: input.triggerProperties,
      } satisfies EventPayloadInput,
      hatchetCtx,
      extraContext: { __blueprintVersion: enrolledVersion },
      // Structured errorMessage (spec §6.1): { blueprintId, nodeId, message }
      // as JSON in the SAME journeyStates.errorMessage field code journeys
      // use, so Studio's error display needs no blueprint-specific branching.
      serializeError: (err) =>
        JSON.stringify(serializeBlueprintError(row.id, err)),
    });
  },
});
