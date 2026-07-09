import type { JourneyMeta } from "../types/journey.js";
import type { JourneyGraph } from "./types.js";

let counter = 0;
/** Monotonic, collision-free node id within a single graph build. */
function nid(): string {
  counter += 1;
  return `n${counter}`;
}

/**
 * Build the METADATA-level journey graph: trigger -> body placeholder ->
 * exitOn* -> end. This is the honest fallback when no source-derived (rich)
 * graph is available — at runtime the engine only has {@link JourneyMeta}, the
 * `run()` body is bundled away.
 *
 * Live counts (from `journeyStates.currentNodeId`) cannot be attached at this
 * level; the admin route overlays them after the fact.
 */
export function metaToGraph(meta: JourneyMeta): JourneyGraph {
  counter = 0;
  const nodes: JourneyGraph["nodes"] = [];
  const edges: JourneyGraph["edges"] = [];

  const trigger = {
    id: nid(),
    kind: "trigger" as const,
    label: meta.trigger.event,
    detail: meta.trigger.where?.length
      ? `${meta.trigger.where.length} condition(s)`
      : undefined,
  };
  nodes.push(trigger);

  const body = {
    id: nid(),
    kind: "checkpoint" as const,
    label: "run() body",
    detail: "Generate a graph to see the full flow",
  };
  nodes.push(body);
  edges.push({ from: trigger.id, to: body.id, kind: "main" });

  // Chain exitOn events off the body placeholder.
  for (const exit of meta.exitOn ?? []) {
    const exitNode = {
      id: nid(),
      kind: "exit" as const,
      label: exit.event,
    };
    nodes.push(exitNode);
    edges.push({ from: body.id, to: exitNode.id, kind: "main" });
  }

  const end = { id: nid(), kind: "end" as const, label: "end" };
  nodes.push(end);
  edges.push({ from: body.id, to: end.id, kind: "main" });

  return {
    journeyId: meta.id,
    nodes,
    edges,
    sourceLevel: "metadata",
    disclaimer:
      "Metadata-only graph. Run `hogsend journeys graph --all` to capture the authored control flow.",
  };
}
