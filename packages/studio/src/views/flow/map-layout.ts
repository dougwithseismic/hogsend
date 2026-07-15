import { graphlib, layout } from "@dagrejs/dagre";
import type { FlowGraphEdge, FlowGraphNode } from "@/lib/admin-api";
import type { XY } from "@/views/journeys/flow-layout";

/**
 * Band layout for the control room — the map is structured by what a node
 * IS, not by an opinionated lifecycle taxonomy.
 *
 * Four horizontal bands, top to bottom:
 *
 *   Sources   — traffic origins (`display: "source"` surfaces)
 *   Surfaces  — the product's touchpoints (site, docs, checkout, …)
 *   Pipeline  — funnel stages + the builtin revenue till
 *   Journeys  — the automations
 *
 * Traffic darts BETWEEN the bands: sources feed surfaces, surfaces feed the
 * pipeline, journeys reach back up into surfaces. Within a band, nodes are
 * ordered by the flow itself (a dagre pass over the real edges provides the
 * left-to-right ordering), so upstream still reads left and downstream right.
 *
 * `tier` is optional display metadata (a badge on the card) — it plays no
 * part in the structure. That's deliberate: everything else in Hogsend is
 * customizable, so the map's shape must come from facts (node kind), not
 * from a vocabulary an operator may not share.
 */

/** Per-kind card footprints — surface-node.tsx sizes itself from these. */
export function nodeSize(node: Pick<FlowGraphNode, "kind" | "display">): {
  width: number;
  height: number;
} {
  if (node.display === "source") return { width: 216, height: 64 };
  switch (node.kind) {
    case "surface":
      return { width: 264, height: 148 };
    case "journey":
      return { width: 248, height: 122 };
    case "builtin":
      return { width: 248, height: 130 };
    default:
      return { width: 236, height: 110 };
  }
}

/** The structural row a node lives in — derived from what it IS. */
export type FlowBand = "sources" | "surfaces" | "pipeline" | "journeys";

export const BAND_ORDER: FlowBand[] = [
  "sources",
  "surfaces",
  "pipeline",
  "journeys",
];

export const BAND_LABELS: Record<FlowBand, string> = {
  sources: "Sources",
  surfaces: "Surfaces",
  pipeline: "Pipeline",
  journeys: "Journeys",
};

export function bandOf(
  node: Pick<FlowGraphNode, "kind" | "display">,
): FlowBand {
  if (node.display === "source") return "sources";
  if (node.kind === "surface") return "surfaces";
  if (node.kind === "journey") return "journeys";
  return "pipeline";
}

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

/** A faint labeled box behind one band's nodes. */
export interface ClusterBox {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MapLayout {
  positions: Record<string, XY>;
  /** Band boxes (a band earns a box with ≥2 members). */
  clusters: ClusterBox[];
  /**
   * Which drawn box a node belongs to — the canvas parents these nodes to
   * their band box (React Flow subflow), so dragging the box moves the group.
   */
  clusterOf: Record<string, FlowBand>;
}

const MARGIN = 32;
const GAP_X = 48;
const GAP_Y = 40;
/** Vertical breathing room between bands — the space traffic darts across. */
const BAND_GAP = 130;
/** Wrap a band into a new row past this width, so one band can't sprawl. */
const MAX_ROW_WIDTH = 1720;

/**
 * Band positions: nodes grouped into their structural row, ordered WITHIN
 * the row by the flow itself — a dagre LR pass over the real edges yields
 * each connected node's x, so upstream reads left. Deterministic for a given
 * (node set, edge set): sorted inputs, stable dagre, no traffic in the keys.
 */
export function layoutMap(input: {
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
}): MapLayout {
  const { merged } = mergeBidirectional(input.edges);

  // Flow-informed x-ordering for connected nodes (unlinked nodes sort last).
  const xOrder = new Map<string, number>();
  const linked = new Set<string>();
  for (const edge of merged) {
    linked.add(edge.from);
    linked.add(edge.to);
  }
  const connected = input.nodes
    .filter((n) => linked.has(n.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (connected.length > 0) {
    const g = new graphlib.Graph({ directed: true }).setDefaultEdgeLabel(
      () => ({}),
    );
    g.setGraph({ rankdir: "LR", ranksep: 60, nodesep: 24 });
    for (const node of connected) {
      g.setNode(node.id, nodeSize(node));
    }
    for (const edge of merged) {
      g.setEdge(edge.from, edge.to);
    }
    layout(g);
    for (const node of connected) {
      const laid = g.node(node.id);
      if (laid) xOrder.set(node.id, laid.x);
    }
  }

  const positions: Record<string, XY> = {};
  const clusters: ClusterBox[] = [];
  const clusterOf: Record<string, FlowBand> = {};
  let y = MARGIN;

  for (const band of BAND_ORDER) {
    const members = input.nodes
      .filter((n) => bandOf(n) === band)
      .sort(
        (a, b) =>
          (xOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
            (xOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
          a.id.localeCompare(b.id),
      );
    if (members.length === 0) continue;

    const bandTop = y;
    let x = MARGIN;
    let rowHeight = 0;
    let maxRight = MARGIN;
    for (const node of members) {
      const size = nodeSize(node);
      if (x > MARGIN && x + size.width > MAX_ROW_WIDTH) {
        x = MARGIN;
        y += rowHeight + GAP_Y;
        rowHeight = 0;
      }
      positions[node.id] = { x, y };
      maxRight = Math.max(maxRight, x + size.width);
      rowHeight = Math.max(rowHeight, size.height);
      x += size.width + GAP_X;
    }
    const bandBottom = y + rowHeight;

    if (members.length >= 2) {
      clusters.push({
        id: `band#${band}`,
        label: BAND_LABELS[band],
        x: MARGIN,
        y: bandTop,
        width: maxRight - MARGIN,
        height: bandBottom - bandTop,
      });
      for (const node of members) {
        clusterOf[node.id] = band;
      }
    }
    y = bandBottom + BAND_GAP;
  }

  return { positions, clusters, clusterOf };
}
