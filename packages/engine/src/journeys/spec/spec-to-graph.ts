import type {
  DurationObject,
  JourneyEdge,
  JourneyGraph,
  JourneyNode,
  JourneySpec,
  JourneyStep,
  SpecCondition,
} from "@hogsend/core";

/**
 * Map a {@link JourneySpec} onto the runtime journey-graph IR — the same shape
 * the acorn-based `buildJourneyGraph` extracts from authored source, so the
 * Studio flow canvas, per-node live/failed metric joins, and template previews
 * work identically for spec journeys.
 *
 * Node-id conventions mirror `graph/build-graph.ts` exactly (they are the join
 * keys to `journeyStates.currentNodeId` and `journey_logs`):
 *   - sleep / sleep_until / wait_for_event / checkpoint → the authored step id
 *     (the interpreter passes it as the durable label)
 *   - send_email  → `send:<stepId>`   (stepId is the idempotency-label site)
 *   - trigger     → `trigger:<stepId>` (unique per step; the event may repeat)
 *   - branch      → the step id, type "decision"
 *   - terminals   → reserved `start` / `end-completed`
 *
 * Every node id is unique by construction: step ids are validated unique, the
 * `send:`/`trigger:` prefixes never collide with a bare step id (`:` is not a
 * legal step-id char), and the reserved terminal ids are barred as step ids by
 * the schema. So this graph is full-fidelity: never `degraded`, no warnings, no
 * unstable ids.
 */
export function specToGraph(spec: JourneySpec): JourneyGraph {
  const nodes: JourneyNode[] = [];
  const edges: JourneyEdge[] = [];
  let edgeCounter = 0;

  const addNode = (node: JourneyNode): void => {
    nodes.push(node);
  };
  const addEdge = (
    source: string,
    target: string,
    kind: JourneyEdge["kind"] = "default",
    label?: string,
  ): void => {
    edges.push({
      id: `edge-${edgeCounter++}`,
      source,
      target,
      kind,
      ...(label ? { label } : {}),
    });
  };

  addNode({
    id: "start",
    type: "start",
    title: "Start",
    ...(spec.meta.trigger.event ? { subtitle: spec.meta.trigger.event } : {}),
    ...(spec.meta.trigger.where?.length
      ? { meta: { conditions: spec.meta.trigger.where } }
      : {}),
  });

  /**
   * Emit a step sequence. `entries` are the dangling node ids (with edge kind +
   * label) that should connect INTO the first node of the sequence; returns the
   * dangling exits of the sequence (empty when every path ended explicitly).
   */
  interface OpenEnd {
    id: string;
    kind: JourneyEdge["kind"];
    label?: string;
  }

  const emitSequence = (
    steps: JourneyStep[],
    entries: OpenEnd[],
  ): OpenEnd[] => {
    let open = entries;
    for (const step of steps) {
      if (step.type === "end") {
        for (const oe of open) {
          addEdge(oe.id, "end-completed", oe.kind, oe.label);
        }
        return [];
      }

      if (step.type === "branch") {
        addNode({
          id: step.id,
          type: "decision",
          title: describeCondition(step.if),
          meta: { conditions: [step.if] },
        });
        for (const oe of open) addEdge(oe.id, step.id, oe.kind, oe.label);

        const yesExits = emitSequence(step.yes, [
          { id: step.id, kind: "conditional-true", label: "yes" },
        ]);
        const noExits = emitSequence(step.no ?? [], [
          { id: step.id, kind: "conditional-false", label: "no" },
        ]);
        open = [...yesExits, ...noExits];
        continue;
      }

      const node = nodeForStep(step);
      addNode(node);
      for (const oe of open) addEdge(oe.id, node.id, oe.kind, oe.label);
      open = [{ id: node.id, kind: "default" }];
    }
    return open;
  };

  const finalOpen = emitSequence(spec.steps, [
    { id: "start", kind: "default" },
  ]);
  addNode({ id: "end-completed", type: "end-completed", title: "Completed" });
  for (const oe of finalOpen) {
    addEdge(oe.id, "end-completed", oe.kind, oe.label);
  }

  return { journeyId: spec.id, nodes, edges };
}

function nodeForStep(
  step: Exclude<JourneyStep, { type: "branch" } | { type: "end" }>,
): JourneyNode {
  switch (step.type) {
    case "send_email":
      return {
        id: `send:${step.id}`,
        type: "send",
        title: "Send email",
        subtitle: step.template,
        meta: { template: step.template, idempotencyLabel: step.id },
      };
    case "sleep":
      return {
        id: step.id,
        type: "sleep",
        title: step.id,
        subtitle: formatDuration(step.duration),
        meta: { duration: { ...step.duration } },
      };
    case "sleep_until":
      return {
        id: step.id,
        type: "sleepUntil",
        title: step.id,
        subtitle: step.at,
      };
    case "wait_for_event":
      return {
        id: step.id,
        type: "wait",
        title: step.id,
        subtitle: step.event,
        meta: { event: step.event, timeout: { ...step.timeout } },
      };
    case "checkpoint":
      return {
        id: step.id,
        type: "checkpoint",
        title: "Checkpoint",
        subtitle: step.id,
      };
    case "trigger_event":
      // Key on the step id (not the event): two `trigger_event` steps may fire
      // the SAME event on different branches, and a node id must be unique for
      // the canvas + edge wiring. Trigger nodes never write `currentNodeId`, so
      // there is no metric join that depends on an event-derived id.
      return {
        id: `trigger:${step.id}`,
        type: "trigger",
        title: "Trigger",
        subtitle: step.event,
        meta: { event: step.event, idempotencyLabel: step.id },
      };
  }
}

/** Compact human text for a decision node header. */
function describeCondition(condition: SpecCondition): string {
  switch (condition.type) {
    case "property": {
      const value = condition.value === undefined ? "" : ` ${condition.value}`;
      return `${condition.property} ${condition.operator}${value}`;
    }
    case "event":
      return condition.check === "not_exists"
        ? `no ${condition.eventName}`
        : condition.eventName;
    case "wait_result":
      return condition.fired
        ? `${condition.of} answered`
        : `${condition.of} timed out`;
    case "composite":
      return condition.conditions
        .map(describeCondition)
        .join(` ${condition.operator} `);
  }
}

function formatDuration(d: DurationObject): string {
  const parts: string[] = [];
  const hours = d.hours ?? 0;
  if (hours >= 24 && hours % 24 === 0) parts.push(plural(hours / 24, "day"));
  else if (hours) parts.push(plural(hours, "hour"));
  if (d.minutes) parts.push(plural(d.minutes, "minute"));
  if (d.seconds) parts.push(plural(d.seconds, "second"));
  return parts.join(" ") || "0 seconds";
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}
