import type {
  FlowGraphEdge,
  FlowGraphNode,
  SurfaceTier,
} from "@/lib/admin-api";
import { roundedPath, type XY } from "@/views/journeys/flow-layout";

/**
 * Tier layout for the control room — deliberately NOT a generic DAG layout.
 *
 * The lifecycle IS the x-axis: a node's tier fixes its column, so the map
 * reads left-to-right (acquisition → revenue) no matter what the graph does.
 * Within a column, rows are ordered by longest-path depth over the intra-tier
 * subgraph (so a local funnel still reads top-to-bottom), then by contacts.
 *
 * The critical property is STABILITY: the view polls, and a node that jumps
 * rows on refresh restarts every edge animation attached to it. So the caller
 * threads an `order` accumulator — an id that already has a slot KEEPS it,
 * and only genuinely new ids are appended. Positions are therefore a pure
 * function of (order, tier), not of this poll's traffic.
 */

export const TIERS: readonly SurfaceTier[] = [
  "acquisition",
  "activation",
  "retention",
  "revenue",
];

/** Node card footprint — must match `surface-node.tsx`. */
export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 88;

const COLUMN_X = 480;
const ROW_GAP = 48;
const ROW_PITCH = NODE_HEIGHT + ROW_GAP;
const TOP_MARGIN = 64;

/** Corner radius for the orthogonal waypoint paths. */
const CORNER_RADIUS = 16;
/** Parallel edges sharing a routing channel fan out by this much. */
const CHANNEL_OFFSET = 14;
/** How far a back-edge detours out of its column before climbing. */
const LANE_GUTTER = 56;
/** Stub length before an intra-tier detour turns. */
const STUB = 24;

export type FlowHandles = {
  source: "out-r" | "out-b";
  target: "in-l" | "in-t";
};

export type FlowRoute = {
  points: XY[];
  /** Rounded SVG path — also the CSS `offset-path` the particles ride. */
  d: string;
  /** Polyline length, used to pace particles at a constant speed. */
  length: number;
  handles: FlowHandles;
};

export type TierLayout = {
  positions: Record<string, XY>;
  routes: Record<string, FlowRoute>;
};

/** Stable edge id — `from`→`to` is unique in the flow map. */
export function flowEdgeId(edge: Pick<FlowGraphEdge, "from" | "to">): string {
  return `${edge.from}->${edge.to}`;
}

/**
 * Row order within one tier: longest-path depth over the intra-tier subgraph
 * (Kahn, cycles fall back to depth 0), then contacts desc, then id.
 */
function orderTier(
  nodes: FlowGraphNode[],
  edges: FlowGraphEdge[],
): FlowGraphNode[] {
  const ids = new Set(nodes.map((n) => n.id));
  const inner = edges.filter(
    (e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to,
  );

  const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const e of inner) {
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    const list = outgoing.get(e.from);
    if (list) list.push(e.to);
    else outgoing.set(e.from, [e.to]);
  }

  const depth = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const queue = nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const next of outgoing.get(id) ?? []) {
      depth.set(next, Math.max(depth.get(next) ?? 0, (depth.get(id) ?? 0) + 1));
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      // A cycle leaves nodes with remaining > 0 — they keep depth 0 and fall
      // back to the contacts tiebreak. No infinite loop either way.
      if (remaining === 0) queue.push(next);
    }
  }

  return [...nodes].sort(
    (a, b) =>
      (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0) ||
      b.contacts - a.contacts ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Merge this poll's computed order into the accumulator: ids that already have
 * a slot keep it (in their existing relative order), new ids are appended in
 * computed order. Departed ids are KEPT as tombstones — their row stays
 * reserved (a temporary hole) so nothing below shifts. This matters at the
 * raw-mode top-15 boundary, where a marginal prefix oscillates in and out of
 * the cut every poll: dropping its slot would shift every row under it (new
 * positions → new paths → every particle on those rails snaps mid-flight).
 * Mutates `order` — it is the caller's cross-poll memory.
 */
function stableOrder(
  order: Map<SurfaceTier, string[]>,
  tier: SurfaceTier,
  computed: FlowGraphNode[],
): string[] {
  const known = order.get(tier) ?? [];
  const seen = new Set(known);
  const next = [
    ...known,
    ...computed.map((n) => n.id).filter((id) => !seen.has(id)),
  ];
  order.set(tier, next);
  return next;
}

function center(pos: XY): XY {
  return { x: pos.x + NODE_WIDTH / 2, y: pos.y + NODE_HEIGHT / 2 };
}

function polylineLength(points: XY[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (!a || !b) continue;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/** 0, -14, +14, -28, +28 … so parallel edges in one channel don't overlap. */
function channelOffset(index: number): number {
  if (index === 0) return 0;
  const step = Math.ceil(index / 2) * CHANNEL_OFFSET;
  return index % 2 === 1 ? -step : step;
}

export function layoutTiers({
  nodes,
  edges,
  order,
}: {
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
  /** Cross-poll row memory (see `stableOrder`); mutated in place. */
  order: Map<SurfaceTier, string[]>;
}): TierLayout {
  const positions: Record<string, XY> = {};
  const tierOf = new Map<string, SurfaceTier>();

  TIERS.forEach((tier, tierIndex) => {
    const inTier = nodes.filter((n) => n.tier === tier);
    if (inTier.length === 0) return;
    const ordered = stableOrder(order, tier, orderTier(inTier, edges));
    ordered.forEach((id, rowIndex) => {
      positions[id] = {
        x: tierIndex * COLUMN_X,
        y: TOP_MARGIN + rowIndex * ROW_PITCH,
      };
      tierOf.set(id, tier);
    });
  });

  // Group edges by the channel they share, so parallel runs can be fanned out.
  const channels = new Map<string, string[]>();
  const channelOf = (edge: FlowGraphEdge): string => {
    const from = tierOf.get(edge.from);
    const to = tierOf.get(edge.to);
    return from === to ? `lane:${from}` : `tier:${from}->${to}`;
  };
  for (const edge of edges) {
    if (!positions[edge.from] || !positions[edge.to]) continue;
    const key = channelOf(edge);
    const list = channels.get(key);
    if (list) list.push(flowEdgeId(edge));
    else channels.set(key, [flowEdgeId(edge)]);
  }
  // The fan-out index must be traffic-independent: the API orders edges by
  // volume, so following insertion order would re-route (and visibly restart)
  // an edge whenever counts wobble across a poll. Ids are stable; sort on them.
  for (const list of channels.values()) list.sort();

  const routes: Record<string, FlowRoute> = {};
  for (const edge of edges) {
    const sourcePos = positions[edge.from];
    const targetPos = positions[edge.to];
    if (!sourcePos || !targetPos || edge.from === edge.to) continue;
    const id = flowEdgeId(edge);
    const offset = channelOffset(
      Math.max(0, (channels.get(channelOf(edge)) ?? []).indexOf(id)),
    );

    const sameTier = tierOf.get(edge.from) === tierOf.get(edge.to);
    const { points, handles } = sameTier
      ? routeIntraTier(sourcePos, targetPos, offset)
      : routeInterTier(sourcePos, targetPos, offset);

    routes[id] = {
      points,
      d: roundedPath(points, CORNER_RADIUS),
      length: polylineLength(points),
      handles,
    };
  }

  return { positions, routes };
}

/** Same column: down the spine, or out around a gutter for a back-edge. */
function routeIntraTier(
  sourcePos: XY,
  targetPos: XY,
  offset: number,
): { points: XY[]; handles: FlowHandles } {
  const start = { x: center(sourcePos).x, y: sourcePos.y + NODE_HEIGHT };
  const end = { x: center(targetPos).x, y: targetPos.y };
  const handles: FlowHandles = { source: "out-b", target: "in-t" };

  if (end.y > start.y) {
    const midY = (start.y + end.y) / 2;
    return {
      points: [
        start,
        { x: start.x + offset, y: midY },
        { x: end.x + offset, y: midY },
        end,
      ],
      handles,
    };
  }

  // Target sits at or above the source — detour into the right-hand gutter so
  // the line never gets painted across the cards it climbs past.
  const lane = sourcePos.x + NODE_WIDTH + LANE_GUTTER + offset;
  return {
    points: [
      start,
      { x: start.x, y: start.y + STUB },
      { x: lane, y: start.y + STUB },
      { x: lane, y: end.y - STUB },
      { x: end.x, y: end.y - STUB },
      end,
    ],
    handles,
  };
}

/** Across columns: right handle → left handle, turning at the mid-gutter. */
function routeInterTier(
  sourcePos: XY,
  targetPos: XY,
  offset: number,
): { points: XY[]; handles: FlowHandles } {
  const start = { x: sourcePos.x + NODE_WIDTH, y: center(sourcePos).y };
  const end = { x: targetPos.x, y: center(targetPos).y };
  const midX = (start.x + end.x) / 2 + offset;
  return {
    points: [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end],
    handles: { source: "out-r", target: "in-l" },
  };
}
