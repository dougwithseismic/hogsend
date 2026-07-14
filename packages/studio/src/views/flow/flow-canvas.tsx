import {
  Background,
  BackgroundVariant,
  Controls,
  type EdgeTypes,
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
import type {
  FlowGraphNode,
  FlowGraphResponse,
  SurfaceTier,
} from "@/lib/admin-api";
import {
  FlowEdge,
  type FlowRfEdge,
  particleCountFor,
  strokeWidthFor,
} from "./flow-edge";
import { laneColor } from "./lane-colors";
import { SurfaceNode, type SurfaceRfNode } from "./surface-node";
import { flowEdgeId, layoutTiers, type TierLayout } from "./tier-layout";

// Module-scope, per React Flow's rule: a fresh object here re-instantiates
// every node/edge component on each render (and kills the CSS animations).
const nodeTypes: NodeTypes = { surface: SurfaceNode };
const edgeTypes: EdgeTypes = { flow: FlowEdge };

/**
 * Reconcile the polled graph against what's already on screen.
 *
 * React Flow subscribes per element with `Object.is`, so handing back the
 * PREVIOUS object for an unchanged element skips its re-render entirely —
 * which is the only reason a particle animation survives a 30s poll. Anything
 * that changes what's painted (position, traffic bucket, path) mints a new
 * object; anything else (an events count nobody can see move, an unchanged
 * edge) does not.
 */
/**
 * The complete visual signature of an edge under the current lane selection —
 * width bucket, particle count (0 when dimmed), colour, and dimmed flag. Two
 * edges with the same key paint byte-identically, so a poll that doesn't move
 * this signature reuses the previous object and its animations survive.
 */
function edgeVisualKey(weight: number, color: string | null): string {
  const dimmed = color !== null && weight === 0;
  const particles = dimmed ? 0 : particleCountFor(weight);
  return `${strokeWidthFor(weight)}:${particles}:${color ?? ""}:${dimmed ? 1 : 0}`;
}

function reconcile(
  data: FlowGraphResponse,
  layout: TierLayout,
  prevNodes: Map<string, SurfaceRfNode>,
  prevEdges: Map<string, FlowRfEdge>,
  selectedLane: string | null,
): { nodes: SurfaceRfNode[]; edges: FlowRfEdge[] } {
  const nodes: SurfaceRfNode[] = [];
  for (const node of data.nodes) {
    const position = layout.positions[node.id];
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

  const edges: FlowRfEdge[] = [];
  for (const edge of data.edges) {
    const id = flowEdgeId(edge);
    const route = layout.routes[id];
    if (!route) continue;
    // With a lane selected, the buckets are driven by THAT lane's count (0 =
    // this edge carries none of it) and the rail takes the lane colour; with no
    // lane, total transitions drive the neutral-white resting map. Explicit
    // null check: a falsy-but-real lane id must still select.
    const weight =
      selectedLane !== null
        ? (edge.lanes?.[selectedLane] ?? 0)
        : edge.transitions;
    const color = selectedLane !== null ? laneColor(selectedLane) : null;
    const prev = prevEdges.get(id);
    const sameStyle =
      prev !== undefined &&
      edgeVisualKey(prev.data?.weight ?? 0, prev.data?.color ?? null) ===
        edgeVisualKey(weight, color);
    if (prev && sameStyle && prev.data?.d === route.d) {
      edges.push(prev);
      continue;
    }
    if (import.meta.env.DEV && prev && sameStyle) {
      // Tripwire: the geometry moved under a stable graph — every particle on
      // this edge just restarted. If this fires on an idle poll, the layout
      // stopped being a pure function of the (stable) row order.
      console.debug("[flow] edge path changed without a style change", id);
    }
    const next: FlowRfEdge = {
      id,
      source: edge.from,
      target: edge.to,
      sourceHandle: route.handles.source,
      targetHandle: route.handles.target,
      type: "flow",
      data: {
        d: route.d,
        length: route.length,
        transitions: edge.transitions,
        contacts: edge.contacts,
        weight,
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
}: {
  data: FlowGraphResponse;
  selectedLane: string | null;
}) {
  const { fitView } = useReactFlow();
  // Cross-poll memory: row slots (so nodes never jump) and the previous
  // element objects (so unchanged elements keep their identity).
  const orderRef = useRef<Map<SurfaceTier, string[]>>(new Map());
  const prevNodesRef = useRef<Map<string, SurfaceRfNode>>(new Map());
  const prevEdgesRef = useRef<Map<string, FlowRfEdge>>(new Map());

  const { nodes: rfNodes, edges: rfEdges } = useMemo(
    () =>
      reconcile(
        data,
        layoutTiers({
          nodes: data.nodes,
          edges: data.edges,
          order: orderRef.current,
        }),
        prevNodesRef.current,
        prevEdgesRef.current,
        selectedLane,
      ),
    [data, selectedLane],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(rfNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(rfEdges);
  useEffect(() => setNodes(rfNodes), [rfNodes, setNodes]);
  useEffect(() => setEdges(rfEdges), [rfEdges, setEdges]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const fittedRef = useRef(false);
  const [interactive, setInteractive] = useState(false);

  // Fit ONCE, when the pane first has real dimensions (it mounts inside a
  // flex/height container that measures async). Deliberately not on poll: a
  // refit every 30s would yank the viewport out from under the operator.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || fittedRef.current || rfNodes.length === 0) return;
    let raf = 0;
    const tryFit = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (fittedRef.current) return;
        if (el.clientWidth > 0 && el.clientHeight > 0) {
          fitView({ padding: 0.18 });
          fittedRef.current = true;
        }
      });
    };
    const observer = new ResizeObserver(tryFit);
    observer.observe(el);
    tryFit();
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [fitView, rfNodes.length]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer-leave re-locks pan/zoom; the affordances are the overlay + Lock buttons
    <div
      ref={wrapRef}
      className="relative h-[720px] overflow-hidden rounded-md border border-hairline-faint bg-black/20"
      onMouseLeave={() => setInteractive(false)}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        minZoom={0.15}
        nodesConnectable={false}
        edgesFocusable={false}
        // Interaction lock — while locked the wheel scrolls the PAGE.
        zoomOnScroll={interactive}
        zoomOnPinch={interactive}
        zoomOnDoubleClick={interactive}
        panOnDrag={interactive}
        panOnScroll={false}
        // Positions are a pure function of (order × tier) — a drag would
        // detach the rails (edges draw the layout path, not live handle
        // coords) and the next poll would snap the card back anyway.
        nodesDraggable={false}
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
}: {
  data: FlowGraphResponse;
  selectedLane?: string | null;
}) {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner data={data} selectedLane={selectedLane} />
    </ReactFlowProvider>
  );
}
