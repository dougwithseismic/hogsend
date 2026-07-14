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
function reconcile(
  data: FlowGraphResponse,
  layout: TierLayout,
  prevNodes: Map<string, SurfaceRfNode>,
  prevEdges: Map<string, FlowRfEdge>,
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
    const prev = prevEdges.get(id);
    const sameBucket =
      prev !== undefined &&
      strokeWidthFor(prev.data?.transitions ?? 0) ===
        strokeWidthFor(edge.transitions) &&
      particleCountFor(prev.data?.transitions ?? 0) ===
        particleCountFor(edge.transitions);
    if (prev && sameBucket && prev.data?.d === route.d) {
      edges.push(prev);
      continue;
    }
    if (import.meta.env.DEV && prev && sameBucket) {
      // Tripwire: the geometry moved under a stable graph — every particle on
      // this edge just restarted. If this fires on an idle poll, the layout
      // stopped being a pure function of the (stable) row order.
      console.debug("[flow] edge path changed without a bucket change", id);
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
      },
    };
    prevEdges.set(id, next);
    edges.push(next);
  }

  return { nodes, edges };
}

/** Only what the card actually paints. */
function sameNodeVisuals(a: FlowGraphNode, b: FlowGraphNode): boolean {
  return (
    a.name === b.name &&
    a.contacts === b.contacts &&
    a.events === b.events &&
    a.kind === b.kind &&
    a.tier === b.tier
  );
}

function FlowCanvasInner({ data }: { data: FlowGraphResponse }) {
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
      ),
    [data],
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

export function FlowCanvas({ data }: { data: FlowGraphResponse }) {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner data={data} />
    </ReactFlowProvider>
  );
}
