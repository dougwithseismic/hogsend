import { graphlib, layout } from "@dagrejs/dagre";
import type { JourneyGraphNodeType } from "@/lib/admin-api";

/**
 * Dagre-powered top-down layered layout. Journeys can now fork/converge
 * (if/else, decisions, waitForEvent branches), so a real DAG layout engine
 * beats the old hand-rolled longest-path pass. Returns absolute top-left
 * `{ x, y }` positions keyed by node id (dagre centres nodes; React Flow
 * anchors top-left, so we shift by half the node size).
 *
 * Node dimensions MUST match what the node component renders (see
 * `NODE_DIMS` — the card widths in journey-flow.tsx mirror these) or dagre's
 * centring will be off.
 */

export type XY = { x: number; y: number };

/** Per-type render footprint — kept in lockstep with the node card widths. */
export const NODE_DIMS: Record<
  JourneyGraphNodeType,
  { width: number; height: number }
> = {
  start: { width: 240, height: 76 },
  sleep: { width: 240, height: 76 },
  sleepUntil: { width: 240, height: 76 },
  wait: { width: 240, height: 76 },
  send: { width: 240, height: 76 },
  connector: { width: 240, height: 76 },
  checkpoint: { width: 240, height: 76 },
  trigger: { width: 240, height: 76 },
  capture: { width: 240, height: 76 },
  branch: { width: 240, height: 76 },
  decision: { width: 210, height: 72 },
  "end-completed": { width: 240, height: 76 },
  "end-exited": { width: 240, height: 76 },
  "end-failed": { width: 240, height: 76 },
  unknown: { width: 240, height: 76 },
};

const FALLBACK_DIM = { width: 240, height: 76 };

export type LayoutInput = {
  nodes: { id: string; type: JourneyGraphNodeType }[];
  edges: { source: string; target: string }[];
};

export function layoutGraph({ nodes, edges }: LayoutInput): Record<string, XY> {
  const g = new graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "TB",
    ranksep: 64,
    nodesep: 40,
    marginx: 24,
    marginy: 24,
  });

  const idSet = new Set(nodes.map((n) => n.id));
  for (const node of nodes) {
    const dim = NODE_DIMS[node.type] ?? FALLBACK_DIM;
    g.setNode(node.id, { width: dim.width, height: dim.height });
  }
  for (const edge of edges) {
    if (!idSet.has(edge.source) || !idSet.has(edge.target)) continue;
    g.setEdge(edge.source, edge.target);
  }

  layout(g);

  const positions: Record<string, XY> = {};
  for (const node of nodes) {
    const laid = g.node(node.id);
    if (!laid) continue;
    const dim = NODE_DIMS[node.type] ?? FALLBACK_DIM;
    positions[node.id] = {
      x: laid.x - dim.width / 2,
      y: laid.y - dim.height / 2,
    };
  }
  return positions;
}
