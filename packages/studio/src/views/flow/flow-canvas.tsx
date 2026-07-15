import {
  Background,
  BackgroundVariant,
  Controls,
  type EdgeTypes,
  type Node,
  type NodeTypes,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import { Lock, MousePointerClick } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { FlowGraphNode, FlowGraphResponse } from "@/lib/admin-api";
import type { XY } from "@/views/journeys/flow-layout";
import {
  FlowEdge,
  type FlowRfEdge,
  particleCountFor,
  strokeWidthFor,
} from "./flow-edge";
import { laneColor } from "./lane-colors";
import {
  flowEdgeId,
  layoutMap,
  type MapLayout,
  mergeBidirectional,
} from "./map-layout";
import { SurfaceNode, type SurfaceRfNode } from "./surface-node";

// Module-scope, per React Flow's rule: a fresh object here re-instantiates
// every node/edge component on each render (and kills the CSS animations).
const nodeTypes: NodeTypes = { surface: SurfaceNode };
const edgeTypes: EdgeTypes = { flow: FlowEdge };

/**
 * The complete visual signature of an edge under the current lane selection —
 * width bucket, particle count (0 when dimmed), colour, and dimmed flag. Two
 * edges with the same key paint byte-identically, so a poll that doesn't move
 * this signature reuses the previous object and its animations survive.
 */
function edgeVisualKey(
  weight: number,
  reverseWeight: number | null,
  color: string | null,
): string {
  const combined = weight + (reverseWeight ?? 0);
  const dimmed = color !== null && combined === 0;
  const fwd = dimmed || weight <= 0 ? 0 : particleCountFor(weight);
  const rev =
    dimmed || reverseWeight === null || reverseWeight <= 0
      ? 0
      : particleCountFor(reverseWeight);
  return `${strokeWidthFor(combined)}:${fwd}:${rev}:${color ?? ""}:${dimmed ? 1 : 0}`;
}

/**
 * Reconcile the polled graph against what's already on screen.
 *
 * React Flow subscribes per element with `Object.is`, so handing back the
 * PREVIOUS object for an unchanged element skips its re-render entirely —
 * which is the only reason a particle animation survives a poll. Anything
 * that changes what's painted (position, traffic bucket, layout epoch) mints
 * a new object; anything else does not. A node the operator dragged keeps its
 * manual position across polls (`manual` wins over the auto-layout).
 */
function reconcile(
  data: FlowGraphResponse,
  layout: MapLayout,
  manual: Map<string, XY>,
  prevNodes: Map<string, SurfaceRfNode>,
  prevEdges: Map<string, FlowRfEdge>,
  selectedLane: string | null,
): { nodes: SurfaceRfNode[]; edges: FlowRfEdge[] } {
  const nodes: SurfaceRfNode[] = [];
  for (const node of data.nodes) {
    const position = manual.get(node.id) ?? layout.positions[node.id];
    if (!position) continue;
    const prev = prevNodes.get(node.id);
    if (
      prev &&
      prev.position.x === position.x &&
      prev.position.y === position.y &&
      sameNodeVisuals(prev.data.node, node)
    ) {
      nodes.push(prev);
      continue;
    }
    const next: SurfaceRfNode = {
      id: node.id,
      type: "surface",
      position,
      data: { node },
    };
    prevNodes.set(node.id, next);
    nodes.push(next);
  }

  // Bidirectional pairs render as ONE rail carrying dots both ways.
  const { merged } = mergeBidirectional(data.edges);
  const edges: FlowRfEdge[] = [];
  for (const edge of merged) {
    const id = edge.id;
    // With a lane selected, the buckets are driven by THAT lane's count (0 =
    // this edge carries none of it) and the rail takes the lane colour; with no
    // lane, total transitions drive the neutral-white resting map. Explicit
    // null check: a falsy-but-real lane id must still select.
    const weight =
      selectedLane !== null
        ? (edge.forward.lanes?.[selectedLane] ?? 0)
        : edge.forward.transitions;
    const reverseWeight = edge.reverse
      ? selectedLane !== null
        ? (edge.reverse.lanes?.[selectedLane] ?? 0)
        : edge.reverse.transitions
      : null;
    const color = selectedLane !== null ? laneColor(selectedLane) : null;
    const waypoints = layout.edgePoints[id];
    const prev = prevEdges.get(id);
    const sameStyle =
      prev !== undefined &&
      edgeVisualKey(
        prev.data?.weight ?? 0,
        prev.data?.reverseWeight ?? null,
        prev.data?.color ?? null,
      ) === edgeVisualKey(weight, reverseWeight, color);
    // Waypoints are compared by REFERENCE — the layout memo re-produces the
    // same object until the node/edge SET changes, so an idle poll reuses the
    // previous edge and its animations survive. Endpoint moves (drag) reach
    // the edge through React Flow's own props, not through this object.
    if (prev && sameStyle && prev.data?.waypoints === waypoints) {
      edges.push(prev);
      continue;
    }
    const next: FlowRfEdge = {
      id,
      source: edge.from,
      target: edge.to,
      sourceHandle: "out-r",
      targetHandle: "in-l",
      type: "flow",
      data: {
        waypoints,
        transitions: edge.forward.transitions,
        contacts: edge.forward.contacts,
        weight,
        reverseTransitions: edge.reverse?.transitions ?? null,
        reverseWeight,
        color,
      },
    };
    prevEdges.set(id, next);
    edges.push(next);
  }

  return { nodes, edges };
}

/**
 * Only what the card actually paints — including every P2 overlay. Compare the
 * PAINTED value, not the raw one: the heat strip and the "% conv" label are
 * rounded, so a conversion rate that wobbles in the 4th decimal between polls
 * must NOT mint a new node object (that would restart the card's transitions
 * for a change nobody can see).
 */
function sameNodeVisuals(a: FlowGraphNode, b: FlowGraphNode): boolean {
  return (
    a.name === b.name &&
    a.contacts === b.contacts &&
    a.events === b.events &&
    a.kind === b.kind &&
    a.tier === b.tier &&
    a.live === b.live &&
    (a.dwell?.stuckContacts ?? 0) === (b.dwell?.stuckContacts ?? 0) &&
    (a.dwell?.thresholdHours ?? 0) === (b.dwell?.thresholdHours ?? 0) &&
    paintedRate(a) === paintedRate(b) &&
    sameMoney(a.heat?.attributedRevenue, b.heat?.attributedRevenue) &&
    sameMoney(a.heat?.directRevenue, b.heat?.directRevenue)
  );
}

/** The conversion rate as the card paints it: 2dp (the strip is 240px wide). */
function paintedRate(node: FlowGraphNode): number | null {
  const rate = node.heat?.conversionRate;
  return rate === null || rate === undefined ? null : Math.round(rate * 10_000);
}

function sameMoney(
  a: { amount: number; currency: string }[] | undefined,
  b: { amount: number; currency: string }[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((money, i) => {
    const other = b[i];
    return (
      other !== undefined &&
      money.currency === other.currency &&
      Math.round(money.amount) === Math.round(other.amount)
    );
  });
}

function FlowCanvasInner({
  data,
  selectedLane,
  onNodeSelect,
  onPaneSelect,
}: {
  data: FlowGraphResponse;
  selectedLane: string | null;
  onNodeSelect?: (nodeId: string) => void;
  onPaneSelect?: () => void;
}) {
  const { fitView } = useReactFlow();
  // Cross-poll memory: previous element objects (identity reuse) and the
  // operator's manual drag positions (they beat the auto-layout until the
  // node leaves the map).
  const prevNodesRef = useRef<Map<string, SurfaceRfNode>>(new Map());
  const prevEdgesRef = useRef<Map<string, FlowRfEdge>>(new Map());
  const manualPosRef = useRef<Map<string, XY>>(new Map());

  // The layout is a pure function of the node/edge SET — counts wiggling
  // between polls must not move anything, so the memo keys on ids only.
  const layoutKey = useMemo(
    () =>
      `${data.nodes
        .map((n) => n.id)
        .sort()
        .join(",")}|${data.edges.map((e) => flowEdgeId(e)).join(",")}`,
    [data],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: layoutKey IS the dependency that matters — it changes exactly when the node/edge set does
  const layout = useMemo(
    () => layoutMap({ nodes: data.nodes, edges: data.edges }),
    [layoutKey],
  );

  const { nodes: rfNodes, edges: rfEdges } = useMemo(
    () =>
      reconcile(
        data,
        layout,
        manualPosRef.current,
        prevNodesRef.current,
        prevEdgesRef.current,
        selectedLane,
      ),
    [data, layout, selectedLane],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(rfNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(rfEdges);
  useEffect(() => setNodes(rfNodes), [rfNodes, setNodes]);
  useEffect(() => setEdges(rfEdges), [rfEdges, setEdges]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const fittedRef = useRef<string | null>(null);
  const [interactive, setInteractive] = useState(false);

  // Fit when the pane first has real dimensions, again when the VISIBLE
  // node/edge set changes (a new node deserves to be on screen), and again
  // when the CONTAINER is materially resized (the drill-down panel mounting
  // shrinks the canvas ~a third — without a refit the rightmost nodes slide
  // under the panel, hiding exactly the card the operator clicked). Never on
  // a counts-only poll.
  const lastWidthRef = useRef(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || rfNodes.length === 0) return;
    let raf = 0;
    const tryFit = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const width = el.clientWidth;
        if (width <= 0 || el.clientHeight <= 0) return;
        const resized = Math.abs(width - lastWidthRef.current) > 48;
        if (fittedRef.current === layoutKey && !resized) return;
        fitView({ padding: 0.15, duration: fittedRef.current ? 300 : 0 });
        fittedRef.current = layoutKey;
        lastWidthRef.current = width;
      });
    };
    const observer = new ResizeObserver(tryFit);
    observer.observe(el);
    tryFit();
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [fitView, rfNodes.length, layoutKey]);

  // A drag is the operator overriding the auto-layout — remember it so the
  // next poll's reconcile doesn't snap the card back.
  const onNodeDragStop = (_: unknown, node: Node) => {
    manualPosRef.current.set(node.id, { ...node.position });
    const prev = prevNodesRef.current.get(node.id);
    if (prev) {
      prevNodesRef.current.set(node.id, { ...prev, position: node.position });
    }
  };

  return (
    // The wrapper deliberately does NOT re-lock on pointer-leave: the
    // drill-down panel lives beside the canvas, and a round-trip to it would
    // re-lock every time. Locking is the explicit Lock button only.
    <div
      ref={wrapRef}
      className="relative h-full min-h-[480px] overflow-hidden rounded-md border border-hairline-faint bg-black/20"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        // Drill-down: a node click surfaces WHO is there (panel lives OUTSIDE
        // this tree, so selection never re-mints an edge/node object). A pane
        // click deselects.
        onNodeClick={(_, node) => onNodeSelect?.(node.id)}
        onPaneClick={() => onPaneSelect?.()}
        onNodeDragStop={onNodeDragStop}
        minZoom={0.15}
        nodesConnectable={false}
        edgesFocusable={false}
        // Interaction lock — while locked the wheel scrolls the PAGE.
        zoomOnScroll={interactive}
        zoomOnPinch={interactive}
        zoomOnDoubleClick={interactive}
        panOnDrag={interactive}
        panOnScroll={false}
        // Rearranging the machine is part of reading it: edges anchor to the
        // LIVE handle coordinates (flow-edge builds its path per render), so
        // rails follow a dragged card, and the drag sticks across polls via
        // the manual-position memory above.
        nodesDraggable={interactive}
        preventScrolling={interactive}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="rgba(255,255,255,0.09)"
        />
        <Controls showInteractive={false} />
      </ReactFlow>

      {interactive ? (
        <Button
          variant="outline"
          size="sm"
          className="absolute right-2 top-2 z-10 bg-raised/80 backdrop-blur-sm"
          onClick={() => setInteractive(false)}
        >
          <Lock className="h-3.5 w-3.5" />
          Lock
        </Button>
      ) : (
        <button
          type="button"
          aria-label="Click to interact with the flow map"
          className="absolute inset-0 z-10 flex cursor-pointer items-center justify-center bg-ink/20"
          onClick={() => setInteractive(true)}
        >
          <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline-faint bg-raised/80 px-3 py-1.5 text-xs text-white/70 backdrop-blur-sm">
            <MousePointerClick className="h-3.5 w-3.5" />
            Click to interact
          </span>
        </button>
      )}
    </div>
  );
}

export function FlowCanvas({
  data,
  selectedLane = null,
  onNodeSelect,
  onPaneSelect,
}: {
  data: FlowGraphResponse;
  selectedLane?: string | null;
  onNodeSelect?: (nodeId: string) => void;
  onPaneSelect?: () => void;
}) {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner
        data={data}
        selectedLane={selectedLane}
        onNodeSelect={onNodeSelect}
        onPaneSelect={onPaneSelect}
      />
    </ReactFlowProvider>
  );
}
