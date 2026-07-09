import { graphlib, layout } from "@dagrejs/dagre";
import type { JourneyGraphNodeType } from "@/lib/admin-api";

/**
 * Dagre-powered top-down layered layout. Journeys can now fork/converge
 * (if/else, decisions, waitForEvent branches), so a real DAG layout engine
 * beats the old hand-rolled longest-path pass. Returns absolute top-left
 * `{ x, y }` positions keyed by node id (dagre centres nodes; React Flow
 * anchors top-left, so we shift by half the node size) AND dagre's per-edge
 * routed waypoints — the bend points that dodge intermediate nodes so a
 * skip-edge (e.g. a decision's short branch) reads as a clean arc around the
 * spine instead of a straight line drawn on top of the cards it jumps over.
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
  edges: { id: string; source: string; target: string }[];
};

export type LayoutResult = {
  positions: Record<string, XY>;
  /** dagre-routed waypoints per edge id (node-avoiding bend points). */
  edgePoints: Record<string, XY[]>;
};

export function layoutGraph({ nodes, edges }: LayoutInput): LayoutResult {
  // Multigraph so each edge is keyed by its own id (a decision whose branches
  // converge on the same node produces parallel source→target edges).
  const g = new graphlib.Graph({
    multigraph: true,
    directed: true,
  }).setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "TB",
    // Roomier than a straight column: extra rank/node separation gives forks a
    // visible spread and leaves a clear lane for skip-edges to route through.
    ranksep: 84,
    nodesep: 80,
    edgesep: 24,
    marginx: 32,
    marginy: 32,
  });

  const idSet = new Set(nodes.map((n) => n.id));
  for (const node of nodes) {
    const dim = NODE_DIMS[node.type] ?? FALLBACK_DIM;
    g.setNode(node.id, { width: dim.width, height: dim.height });
  }
  for (const edge of edges) {
    if (!idSet.has(edge.source) || !idSet.has(edge.target)) continue;
    g.setEdge(edge.source, edge.target, {}, edge.id);
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

  // dagre's node centres share React Flow's coordinate space (top-left + half
  // = centre = dagre centre), so its edge waypoints can be used verbatim.
  const edgePoints: Record<string, XY[]> = {};
  for (const edge of edges) {
    if (!idSet.has(edge.source) || !idSet.has(edge.target)) continue;
    const laid = g.edge(edge.source, edge.target, edge.id) as
      | { points?: XY[] }
      | undefined;
    if (laid?.points?.length) {
      edgePoints[edge.id] = laid.points.map((p) => ({ x: p.x, y: p.y }));
    }
  }

  return { positions, edgePoints };
}

// --- edge geometry: dagre waypoints → rounded SVG path --------------------

/** Drop consecutive near-duplicate points (dagre emits a few) to avoid NaNs. */
function dedupePoints(points: XY[]): XY[] {
  const out: XY[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.5 && Math.abs(last.y - p.y) < 0.5) {
      continue;
    }
    out.push(p);
  }
  return out;
}

/**
 * SVG path through `points` with each interior vertex softened by a short
 * quadratic corner (`radius`) — the polyline reads as a smooth routed line
 * rather than a hard-cornered zig-zag.
 */
export function roundedPath(points: XY[], radius: number): string {
  const first = points[0];
  if (!first) return "";
  if (points.length === 1) return `M ${first.x},${first.y}`;
  let d = `M ${first.x},${first.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];
    if (!prev || !curr || !next) continue;
    const v1x = curr.x - prev.x;
    const v1y = curr.y - prev.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    const len1 = Math.hypot(v1x, v1y) || 1;
    const len2 = Math.hypot(v2x, v2y) || 1;
    const r = Math.min(radius, len1 / 2, len2 / 2);
    const p1x = curr.x - (v1x / len1) * r;
    const p1y = curr.y - (v1y / len1) * r;
    const p2x = curr.x + (v2x / len2) * r;
    const p2y = curr.y + (v2y / len2) * r;
    d += ` L ${p1x},${p1y} Q ${curr.x},${curr.y} ${p2x},${p2y}`;
  }
  const last = points[points.length - 1];
  if (last) d += ` L ${last.x},${last.y}`;
  return d;
}

/** Point at half the polyline's arc length — a stable spot for an edge label. */
export function polylineMidpoint(points: XY[]): XY {
  const first = points[0];
  if (!first) return { x: 0, y: 0 };
  if (points.length === 1) return first;
  const segLen: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const l = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
    segLen.push(l);
    total += l;
  }
  let half = total / 2;
  for (let i = 0; i < segLen.length; i++) {
    const seg = segLen[i];
    const a = points[i];
    const b = points[i + 1];
    if (seg === undefined || !a || !b) continue;
    if (half <= seg) {
      const t = seg === 0 ? 0 : half / seg;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    half -= seg;
  }
  return points[points.length - 1] ?? first;
}

/**
 * Build the drawable path for one edge: anchor the ends to React Flow's actual
 * handle coordinates, keep dagre's interior waypoints, round the corners, and
 * hand back a midpoint for the label.
 */
export function buildEdgePath(opts: {
  points: XY[] | undefined;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  radius?: number;
}): { path: string; labelX: number; labelY: number } {
  const { points, sourceX, sourceY, targetX, targetY, radius = 12 } = opts;
  // dagre's first/last points sit on the node boundary; swap them for the live
  // handle positions so the line meets the cards exactly (and still follows a
  // node while it's being dragged).
  const interior = points && points.length > 2 ? points.slice(1, -1) : [];
  const pts = dedupePoints([
    { x: sourceX, y: sourceY },
    ...interior,
    { x: targetX, y: targetY },
  ]);
  const mid = polylineMidpoint(pts);
  return { path: roundedPath(pts, radius), labelX: mid.x, labelY: mid.y };
}
