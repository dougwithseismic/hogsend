import { graphlib, layout } from "@dagrejs/dagre";
import type { FlowGraphEdge, FlowGraphNode } from "@/lib/admin-api";
import type { XY } from "@/views/journeys/flow-layout";

/**
 * Graph-first layout for the control room — the map is shaped by how nodes
 * actually LINK, not by lifecycle columns.
 *
 * The original design pinned every node into a fixed tier column
 * (acquisition → revenue). Run against a real registry that meant thirty
 * disconnected journey cards standing in a column pretending to be structure,
 * while the actual machine — surfaces linked by traffic — hid between them.
 * The redesign (2026-07-15, superseding the ticket's layout lock):
 *
 * - Only nodes that EARN canvas space are drawn by default: traffic, a live
 *   enrollment, a pile-up, or an edge. Everything else sits behind a
 *   "show all registered" toggle ({@link visibleFlow}).
 * - The connected graph is laid out left-to-right by dagre over the REAL
 *   edges — the same engine the journey graph uses — so flow reads as flow.
 *   Tier is a badge on the card, not a position law.
 * - Visible-but-unlinked nodes (traffic but no transitions yet) sit in a
 *   compact strip BELOW the flow, visibly apart: present, honest, not fake
 *   structure.
 * - Nodes are draggable; edges anchor to live handle coordinates (see
 *   flow-edge), so layout here only provides the STARTING positions.
 */

/** Node card footprint — surface-node.tsx sizes itself from these. */
export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 104;

/** Grid pitch for the unlinked strip. */
const STRIP_COLS = 4;
const STRIP_GAP_X = 48;
const STRIP_GAP_Y = 40;
/** Vertical gap separating the unlinked strip from the connected flow. */
const STRIP_MARGIN_TOP = 120;

/** Stable edge id — `from`→`to` is unique in the flow map. */
export function flowEdgeId(edge: Pick<FlowGraphEdge, "from" | "to">): string {
  return `${edge.from}->${edge.to}`;
}

/**
 * A bidirectional pair (docs→course AND course→docs) rendered as ONE rail
 * carrying dots BOTH ways — the Railway trick (two keyframe directions on a
 * shared path) instead of two parallel rails with an ugly return loop.
 * `forward` is the canonical direction (`from < to` lexicographically, or the
 * only direction that exists); `reverse` is the opposite flow when present.
 */
export interface MergedFlowEdge {
  id: string;
  from: string;
  to: string;
  forward: FlowGraphEdge;
  reverse: FlowGraphEdge | null;
}

/**
 * Merge opposite-direction edges into single bidirectional rails, plus a
 * routing table from EITHER direction's id to the merged rail (the live
 * particle layer publishes by direction; the rail decides which way the
 * pulse rides).
 */
export function mergeBidirectional(edges: FlowGraphEdge[]): {
  merged: MergedFlowEdge[];
  route: Map<string, { id: string; reverse: boolean }>;
} {
  const byId = new Map(edges.map((e) => [flowEdgeId(e), e]));
  const merged: MergedFlowEdge[] = [];
  const route = new Map<string, { id: string; reverse: boolean }>();
  const consumed = new Set<string>();

  for (const edge of edges) {
    const id = flowEdgeId(edge);
    if (consumed.has(id)) continue;
    const oppositeId = `${edge.to}->${edge.from}`;
    const opposite = byId.get(oppositeId);
    if (opposite && !consumed.has(oppositeId)) {
      // Canonical direction of a PAIR: lexicographically smaller `from`, so
      // both polls agree on which rail object owns the pair.
      const canonical = edge.from < edge.to ? edge : opposite;
      const other = canonical === edge ? opposite : edge;
      const canonicalId = flowEdgeId(canonical);
      merged.push({
        id: canonicalId,
        from: canonical.from,
        to: canonical.to,
        forward: canonical,
        reverse: other,
      });
      route.set(canonicalId, { id: canonicalId, reverse: false });
      route.set(flowEdgeId(other), { id: canonicalId, reverse: true });
      consumed.add(id);
      consumed.add(oppositeId);
      continue;
    }
    merged.push({
      id,
      from: edge.from,
      to: edge.to,
      forward: edge,
      reverse: null,
    });
    route.set(id, { id, reverse: false });
    consumed.add(id);
  }

  return { merged, route };
}

export interface VisibleFlow {
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
  /** Registered nodes hidden by the earn-your-canvas rule. */
  hiddenCount: number;
}

/**
 * The earn-your-canvas rule: a node is drawn when it has traffic in the
 * window, a live enrollment, a pile-up, or touches an edge. An edge's
 * endpoints always qualify by construction (a transition implies classified
 * events at both ends), so edges never dangle.
 */
export function visibleFlow(
  data: { nodes: FlowGraphNode[]; edges: FlowGraphEdge[] },
  showAll: boolean,
): VisibleFlow {
  if (showAll) {
    return { nodes: data.nodes, edges: data.edges, hiddenCount: 0 };
  }
  const onEdge = new Set<string>();
  for (const edge of data.edges) {
    onEdge.add(edge.from);
    onEdge.add(edge.to);
  }
  const nodes = data.nodes.filter(
    (n) =>
      n.contacts > 0 ||
      (n.live ?? 0) > 0 ||
      (n.dwell?.stuckContacts ?? 0) > 0 ||
      onEdge.has(n.id),
  );
  return {
    nodes,
    edges: data.edges,
    hiddenCount: data.nodes.length - nodes.length,
  };
}

export interface MapLayout {
  positions: Record<string, XY>;
  /** dagre-routed node-avoiding waypoints per edge id. */
  edgePoints: Record<string, XY[]>;
}

const TIER_ORDER = { acquisition: 0, activation: 1, retention: 2, revenue: 3 };

/**
 * Positions for the visible graph: dagre LR over the connected component(s),
 * then the unlinked strip below. Deterministic for a given (node set, edge
 * set) — insertion order is sorted, and dagre is stable for stable input —
 * so a poll that changes only COUNTS re-produces identical positions and no
 * animation restarts.
 */
export function layoutMap(input: {
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
}): MapLayout {
  // Bidirectional pairs are ONE rail — laid out (and ranked by dagre) once,
  // not as an edge plus a return loop.
  const { merged } = mergeBidirectional(input.edges);
  const linked = new Set<string>();
  for (const edge of merged) {
    linked.add(edge.from);
    linked.add(edge.to);
  }
  // Sorted insertion: tier first (a soft left-to-right bias for ties dagre is
  // free to break), then id — NEVER traffic, which wiggles between polls.
  const connected = input.nodes
    .filter((n) => linked.has(n.id))
    .sort(
      (a, b) =>
        TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || a.id.localeCompare(b.id),
    );
  const isolated = input.nodes
    .filter((n) => !linked.has(n.id))
    .sort(
      (a, b) =>
        TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || a.id.localeCompare(b.id),
    );

  const positions: Record<string, XY> = {};
  const edgePoints: Record<string, XY[]> = {};
  let flowBottom = 0;

  if (connected.length > 0) {
    const g = new graphlib.Graph({ directed: true }).setDefaultEdgeLabel(
      () => ({}),
    );
    g.setGraph({
      rankdir: "LR",
      ranksep: 120,
      nodesep: 56,
      edgesep: 24,
      marginx: 32,
      marginy: 32,
    });
    for (const node of connected) {
      g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
    }
    for (const edge of merged) {
      // Unnamed edges: from→to is unique post-merge (no parallel edges), and
      // naming an edge requires a multigraph.
      g.setEdge(edge.from, edge.to);
    }
    layout(g);

    for (const node of connected) {
      const laid = g.node(node.id);
      if (!laid) continue;
      positions[node.id] = {
        x: laid.x - NODE_WIDTH / 2,
        y: laid.y - NODE_HEIGHT / 2,
      };
      flowBottom = Math.max(flowBottom, laid.y + NODE_HEIGHT / 2);
    }
    for (const edge of merged) {
      const laid = g.edge(edge.from, edge.to) as { points?: XY[] } | undefined;
      if (laid?.points?.length) {
        edgePoints[edge.id] = laid.points.map((p) => ({
          x: p.x,
          y: p.y,
        }));
      }
    }
  }

  // The unlinked strip: real activity, no transitions yet. A visibly separate
  // grid below the flow — present without pretending to be part of it.
  isolated.forEach((node, i) => {
    positions[node.id] = {
      x: 32 + (i % STRIP_COLS) * (NODE_WIDTH + STRIP_GAP_X),
      y:
        (connected.length > 0 ? flowBottom + STRIP_MARGIN_TOP : 32) +
        Math.floor(i / STRIP_COLS) * (NODE_HEIGHT + STRIP_GAP_Y),
    };
  });

  return { positions, edgePoints };
}
