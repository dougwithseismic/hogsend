import { useQuery } from "@tanstack/react-query";
import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  getNodesBounds,
  getViewportForBounds,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  type NodeTypes,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import { toPng } from "html-to-image";
import {
  Copy,
  ExternalLink,
  GitBranch,
  ImageDown,
  Lock,
  Maximize2,
  MousePointerClick,
  Share2,
} from "lucide-react";
import { deflate } from "pako";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { ErrorState, TableSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import {
  getJourneyGraph,
  getTemplatePreview,
  type JourneyGraph,
  type JourneyGraphEdge,
  type JourneyGraphNode,
  type JourneyGraphNodeType,
  type JourneyGraphResponse,
  type JourneyNodeMetric,
  qk,
} from "@/lib/admin-api";
import { config } from "@/lib/config";
import { downloadDataUrl } from "@/lib/download";
import { toMermaid } from "@/lib/mermaid";
import { cn } from "@/lib/utils";
import { layoutGraph } from "./flow-layout";

// --- Node visual language -------------------------------------------------

/**
 * Muted per-type hues on the crimzon page. Crimson (`#f64838`) is reserved for
 * decision nodes — waits, branches, decisions, triggers — so the eye lands on
 * where the journey forks. Everything else is a calm, distinct tint.
 */
const NODE_STYLE: Record<JourneyGraphNodeType, { rail: string; kind: string }> =
  {
    start: { rail: "#3fb950", kind: "Start" },
    sleep: { rail: "#6e7681", kind: "Sleep" },
    sleepUntil: { rail: "#6e7681", kind: "Sleep until" },
    wait: { rail: "#f64838", kind: "Wait for event" },
    branch: { rail: "#f64838", kind: "Branch" },
    decision: { rail: "#f64838", kind: "Decision" },
    send: { rail: "#d29922", kind: "Email" },
    connector: { rail: "#8957e5", kind: "Connector" },
    checkpoint: { rail: "#58a6ff", kind: "Checkpoint" },
    trigger: { rail: "#f64838", kind: "Trigger" },
    capture: { rail: "#bc8cff", kind: "Capture" },
    "end-completed": { rail: "#3fb950", kind: "Completed" },
    "end-exited": { rail: "#6e7681", kind: "Exited" },
    "end-failed": { rail: "#da3633", kind: "Failed" },
    unknown: { rail: "#6e7681", kind: "Helper" },
  };

type FlowNodeData = {
  node: JourneyGraphNode;
  metric: JourneyNodeMetric;
};

type HogFlowNode = Node<FlowNodeData, "hog">;

/**
 * A journey node card — same crimzon language as `components/ui/card.tsx`
 * (`bg-white/[0.015]`, `border-hairline-faint`, hover `border-white/15`,
 * `text-white/90`) with a colored left rail per node type. `decision` nodes
 * get a distinct accent-tinted pill + branch icon (the humanized question).
 */
function HogNode({ data, selected }: NodeProps<HogFlowNode>) {
  const { node, metric } = data;
  const style = NODE_STYLE[node.type];
  const isDecision = node.type === "decision";
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 text-white/90 transition-colors",
        isDecision ? "w-[210px]" : "w-[240px]",
        isDecision ? "border-accent/40 bg-accent/[0.06]" : "bg-white/[0.015]",
        selected
          ? "border-accent"
          : isDecision
            ? "border-accent/40 hover:border-accent/60"
            : "border-hairline-faint hover:border-white/15",
      )}
      style={isDecision ? undefined : { borderLeft: `3px solid ${style.rail}` }}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!h-1.5 !w-1.5 !border-0 !bg-white/25"
      />
      <div className="flex items-center gap-1.5">
        {isDecision ? (
          <GitBranch className="h-3 w-3 shrink-0 text-accent" />
        ) : (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: style.rail }}
          />
        )}
        <span className="eyebrow text-[11px] text-white/40">{style.kind}</span>
        {node.meta?.unstable ? (
          <span className="ml-auto rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-white/50">
            dynamic
          </span>
        ) : null}
      </div>
      <p
        className="mt-0.5 truncate text-[13px] font-medium leading-snug text-white/90"
        title={node.title}
      >
        {node.title}
      </p>
      {node.subtitle && !isDecision ? (
        <p
          className="truncate font-mono text-[11px] text-white/45"
          title={node.subtitle}
        >
          {node.subtitle}
        </p>
      ) : null}
      {metric.live > 0 || metric.failed > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {metric.live > 0 ? (
            <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
              {metric.live} here
            </span>
          ) : null}
          {metric.failed > 0 ? (
            <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-white/60">
              {metric.failed} failed
            </span>
          ) : null}
        </div>
      ) : null}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-1.5 !w-1.5 !border-0 !bg-white/25"
      />
    </div>
  );
}

// Stable module-scope reference — re-creating this each render makes React Flow
// warn and re-instantiate node components.
const nodeTypes: NodeTypes = { hog: HogNode };

// --- IR → React Flow mapping ----------------------------------------------

function buildRfNodes(
  graph: JourneyGraph,
  metrics: JourneyGraphResponse["metrics"],
): HogFlowNode[] {
  const positions = layoutGraph({
    nodes: graph.nodes.map((n) => ({ id: n.id, type: n.type })),
    edges: graph.edges,
  });
  return graph.nodes.map((node) => ({
    id: node.id,
    type: "hog",
    position: positions[node.id] ?? { x: 0, y: 0 },
    data: {
      node,
      metric: metrics.nodes[node.id] ?? { live: 0, failed: 0 },
    },
  }));
}

/** Per-edge-kind stroke: `yes`/answered read positive/accent, `no` muted. */
function edgeAppearance(kind: JourneyGraphEdge["kind"]): {
  stroke: string;
  dashed: boolean;
} {
  switch (kind) {
    case "conditional-true":
      return { stroke: "#3fb950", dashed: false };
    case "conditional-false":
      return { stroke: "rgba(255,255,255,0.35)", dashed: true };
    case "timedOut":
      return { stroke: "#f64838", dashed: true };
    case "answered":
      return { stroke: "#f64838", dashed: false };
    default:
      return { stroke: "rgba(255,255,255,0.18)", dashed: false };
  }
}

function buildRfEdges(graph: JourneyGraph): Edge[] {
  return graph.edges.map((edge) => {
    const { stroke, dashed } = edgeAppearance(edge.kind);
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.label ? { label: edge.label } : {}),
      type: "smoothstep",
      labelStyle: { fill: "rgba(255,255,255,0.75)", fontSize: 11 },
      labelBgStyle: { fill: "#0a0606", fillOpacity: 0.9 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
      style: {
        stroke,
        strokeWidth: 1.5,
        ...(dashed ? { strokeDasharray: "5 4" } : {}),
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: stroke,
        width: 16,
        height: 16,
      },
    };
  });
}

// --- mermaid.live deep link ------------------------------------------------

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** mermaid.live `pako:` deep link — deflate(JSON state) → url-safe base64. */
function mermaidLiveUrl(code: string): string {
  const state = {
    code,
    mermaid: JSON.stringify({ theme: "dark" }, null, 2),
    autoSync: true,
    updateDiagram: true,
  };
  const bytes = deflate(new TextEncoder().encode(JSON.stringify(state)), {
    level: 9,
  });
  return `https://mermaid.live/edit#pako:${bytesToBase64Url(bytes)}`;
}

// --- Side-panel building blocks -------------------------------------------

function SectionHeading({ children }: { children: ReactNode }) {
  return <h4 className="eyebrow text-white/40">{children}</h4>;
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <span className="w-24 shrink-0 text-sm text-white/50">{label}</span>
      <div className="min-w-0 flex-1 text-sm text-white/90">{children}</div>
    </div>
  );
}

function formatDurationObject(d: Record<string, number>): string {
  const parts = Object.entries(d).map(([unit, n]) => {
    if (unit === "hours" && n >= 24 && n % 24 === 0) {
      const days = n / 24;
      return `${days} ${days === 1 ? "day" : "days"}`;
    }
    const base = unit.replace(/s$/, "");
    return `${n} ${n === 1 ? base : `${base}s`}`;
  });
  return parts.join(", ") || "—";
}

function SendNodePreview({ template }: { template: string }) {
  const query = useQuery({
    queryKey: qk.templatePreview(template),
    queryFn: () => getTemplatePreview(template),
  });
  const openHref = `${config.baseUrl}/v1/admin/templates/${encodeURIComponent(
    template,
  )}/preview?format=html`;
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <SectionHeading>Email preview</SectionHeading>
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.open(openHref, "_blank", "noopener,noreferrer")}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Open
        </Button>
      </div>
      <p
        className="truncate font-mono text-[11px] text-white/45"
        title={template}
      >
        {template}
      </p>
      {query.isPending ? (
        <Skeleton className="h-[420px] w-full" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : (
        <div className="overflow-hidden rounded-lg border bg-white">
          <iframe
            title={`${template} preview`}
            srcDoc={query.data.html}
            sandbox=""
            className="h-[520px] w-full"
          />
        </div>
      )}
    </section>
  );
}

function NodeDetailBody({
  node,
  metric,
}: {
  node: JourneyGraphNode;
  metric: JourneyNodeMetric;
}) {
  const style = NODE_STYLE[node.type];
  const meta = node.meta;
  const templateKey = metric.templateKey ?? meta?.template;
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: style.rail }}
          />
          <span className="eyebrow text-white/50">{style.kind}</span>
        </div>
        <p className="font-display text-base leading-tight text-white tracking-[-0.02em]">
          {node.title}
        </p>
      </div>

      {node.type === "send" ? (
        templateKey ? (
          <SendNodePreview template={templateKey} />
        ) : (
          <p className="rounded-md border border-dashed border-white/15 p-3 text-sm text-white/60">
            No sends recorded yet — preview appears once this journey sends.
          </p>
        )
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-md border border-hairline-faint bg-white/[0.015] p-3">
          <p className="eyebrow text-white/50">Live here</p>
          <p className="mt-1 font-display text-lg text-white">{metric.live}</p>
        </div>
        <div className="rounded-md border border-hairline-faint bg-white/[0.015] p-3">
          <p className="eyebrow text-white/50">Failed here</p>
          <p className="mt-1 font-display text-lg text-white">
            {metric.failed}
          </p>
        </div>
      </div>

      <section className="space-y-2.5">
        <SectionHeading>Details</SectionHeading>
        <DetailRow label="Node id">
          <code className="break-all font-mono text-xs text-white/70">
            {node.id}
          </code>
        </DetailRow>
        {node.subtitle ? (
          <DetailRow label="Summary">{node.subtitle}</DetailRow>
        ) : null}
        {meta?.event ? (
          <DetailRow label="Event">
            <code className="font-mono text-xs text-accent">{meta.event}</code>
          </DetailRow>
        ) : null}
        {meta?.duration ? (
          <DetailRow label="Duration">
            {formatDurationObject(meta.duration)}
          </DetailRow>
        ) : null}
        {meta?.timeout ? (
          <DetailRow label="Timeout">
            {formatDurationObject(meta.timeout)}
          </DetailRow>
        ) : null}
        {templateKey ? (
          <DetailRow label="Template">
            <code className="font-mono text-xs text-white/80">
              {templateKey}
            </code>
          </DetailRow>
        ) : null}
        {meta?.idempotencyLabel ? (
          <DetailRow label="Idempotency">{meta.idempotencyLabel}</DetailRow>
        ) : null}
        {meta?.connectorId ? (
          <DetailRow label="Connector">{meta.connectorId}</DetailRow>
        ) : null}
        {meta?.action ? (
          <DetailRow label="Action">{meta.action}</DetailRow>
        ) : null}
        {typeof node.line === "number" ? (
          <DetailRow label="Source line">{node.line}</DetailRow>
        ) : null}
        {meta?.unstable ? (
          <DetailRow label="Note">
            <span className="text-white/60">
              Dynamic node id — live metrics may not attach.
            </span>
          </DetailRow>
        ) : null}
      </section>

      {meta?.conditions && meta.conditions.length > 0 ? (
        <section className="space-y-2">
          <SectionHeading>Conditions</SectionHeading>
          <pre className="max-h-48 overflow-auto rounded-md border bg-black/30 p-3 font-mono text-xs text-white/70">
            {JSON.stringify(meta.conditions, null, 2)}
          </pre>
        </section>
      ) : null}
    </div>
  );
}

/** Shown in the side panel before a node is picked: hint + a type legend. */
function NodePanelPlaceholder({ graph }: { graph: JourneyGraph }) {
  const types = useMemo(() => {
    const seen = new Set<JourneyGraphNodeType>();
    const ordered: JourneyGraphNodeType[] = [];
    for (const node of graph.nodes) {
      if (seen.has(node.type)) continue;
      seen.add(node.type);
      ordered.push(node.type);
    }
    return ordered;
  }, [graph]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-white/60">
        Select a node to inspect it — its metrics, config, and (for email nodes)
        the rendered template preview appear here.
      </p>
      <section className="space-y-2">
        <SectionHeading>Legend</SectionHeading>
        <ul className="space-y-1.5">
          {types.map((type) => (
            <li key={type} className="flex items-center gap-2 text-sm">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: NODE_STYLE[type].rail }}
              />
              <span className="text-white/70">{NODE_STYLE[type].kind}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// --- Toolbar ---------------------------------------------------------------

function FlowToolbar({ graph }: { graph: JourneyGraph }) {
  const { fitView, getNodes } = useReactFlow();
  const { toast } = useToast();

  const onCopyMermaid = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(toMermaid(graph));
      toast({
        title: "Mermaid copied",
        description: "Flowchart source is on your clipboard.",
      });
    } catch {
      toast({
        variant: "error",
        title: "Copy failed",
        description: "Clipboard permission was denied.",
      });
    }
  }, [graph, toast]);

  const onOpenMermaidLive = useCallback(() => {
    try {
      window.open(
        mermaidLiveUrl(toMermaid(graph)),
        "_blank",
        "noopener,noreferrer",
      );
    } catch {
      toast({ variant: "error", title: "Could not open mermaid.live" });
    }
  }, [graph, toast]);

  const onExportPng = useCallback(async () => {
    const viewport = document.querySelector<HTMLElement>(
      ".react-flow__viewport",
    );
    if (!viewport) return;
    const imageWidth = 1400;
    const imageHeight = 900;
    const bounds = getNodesBounds(getNodes());
    const transform = getViewportForBounds(
      bounds,
      imageWidth,
      imageHeight,
      0.3,
      2,
      0.15,
    );
    try {
      const dataUrl = await toPng(viewport, {
        backgroundColor: "#050101",
        width: imageWidth,
        height: imageHeight,
        style: {
          width: `${imageWidth}px`,
          height: `${imageHeight}px`,
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.zoom})`,
        },
      });
      downloadDataUrl(`journey-${graph.journeyId}-flow.png`, dataUrl);
    } catch {
      toast({ variant: "error", title: "PNG export failed" });
    }
  }, [getNodes, graph.journeyId, toast]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" onClick={() => fitView()}>
        <Maximize2 className="h-3.5 w-3.5" />
        Fit
      </Button>
      <Button variant="outline" size="sm" onClick={onCopyMermaid}>
        <Copy className="h-3.5 w-3.5" />
        Copy Mermaid
      </Button>
      <Button variant="outline" size="sm" onClick={onOpenMermaidLive}>
        <Share2 className="h-3.5 w-3.5" />
        mermaid.live
      </Button>
      <Button variant="outline" size="sm" onClick={onExportPng}>
        <ImageDown className="h-3.5 w-3.5" />
        Export PNG
      </Button>
    </div>
  );
}

// --- Canvas + inline resizable side panel ---------------------------------

function JourneyFlowCanvas({ data }: { data: JourneyGraphResponse }) {
  const { graph, metrics } = data;
  const { fitView } = useReactFlow();

  const rfNodes = useMemo(() => buildRfNodes(graph, metrics), [graph, metrics]);
  const rfEdges = useMemo(() => buildRfEdges(graph), [graph]);

  const [nodes, setNodes, onNodesChange] = useNodesState(rfNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(rfEdges);

  // Re-sync + re-fit when a refetch produces a new graph/metrics (idempotent
  // under StrictMode — setState with the same value is a no-op).
  useEffect(() => setNodes(rfNodes), [rfNodes, setNodes]);
  useEffect(() => setEdges(rfEdges), [rfEdges, setEdges]);
  useEffect(() => {
    if (rfNodes.length === 0) return;
    const t = window.setTimeout(() => fitView({ padding: 0.2 }), 0);
    return () => window.clearTimeout(t);
  }, [rfNodes, fitView]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [interactive, setInteractive] = useState(false);

  const selectedNode = selectedId
    ? (graph.nodes.find((n) => n.id === selectedId) ?? null)
    : null;
  const selectedMetric: JourneyNodeMetric =
    selectedId && metrics.nodes[selectedId]
      ? metrics.nodes[selectedId]
      : { live: 0, failed: 0 };

  const degraded = graph.degraded === true;
  const warnings = graph.warnings ?? [];

  return (
    <div className="space-y-3">
      <FlowToolbar graph={graph} />

      {degraded || warnings.length > 0 ? (
        <div className="rounded-md border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-white/70">
          {degraded ? (
            <p className="font-medium text-white/80">
              Showing a reduced graph — the journey source was unavailable.
            </p>
          ) : null}
          {warnings.length > 0 ? (
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-white/55">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <PanelGroup
        direction="horizontal"
        className="h-[480px] overflow-hidden rounded-md border border-hairline-faint bg-black/20"
      >
        <Panel defaultSize={62} minSize={40}>
          {/* Re-lock when the pointer leaves so wheel-scroll returns to the
              page (a "pane-blur" lock), plus the explicit Lock button. The
              wrapper isn't a control — the overlay button + Lock button are. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-leave re-locks pan/zoom; the interactive affordances are the overlay + Lock buttons */}
          <div
            className="relative h-full"
            onMouseLeave={() => setInteractive(false)}
          >
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeClick={(_, node) => setSelectedId(node.id)}
              onPaneClick={() => setSelectedId(null)}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              minZoom={0.2}
              nodesConnectable={false}
              edgesFocusable={false}
              // Interaction lock: while locked the wheel scrolls the PAGE
              // (`preventScrolling={false}`), not the canvas.
              zoomOnScroll={interactive}
              zoomOnPinch={interactive}
              zoomOnDoubleClick={interactive}
              panOnDrag={interactive}
              panOnScroll={false}
              nodesDraggable={interactive}
              preventScrolling={interactive}
              proOptions={{ hideAttribution: false }}
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
                aria-label="Click to interact with the diagram"
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
        </Panel>

        <PanelResizeHandle className="group relative flex w-2 items-center justify-center outline-none">
          <div className="h-full w-px bg-hairline-faint transition-colors group-hover:bg-accent/40 group-data-[resize-handle-state=drag]:bg-accent" />
        </PanelResizeHandle>

        <Panel defaultSize={38} minSize={24}>
          <aside className="h-full overflow-y-auto bg-white/[0.015] p-4">
            {selectedNode ? (
              <NodeDetailBody node={selectedNode} metric={selectedMetric} />
            ) : (
              <NodePanelPlaceholder graph={graph} />
            )}
          </aside>
        </Panel>
      </PanelGroup>
    </div>
  );
}

// --- Public view -----------------------------------------------------------

export function JourneyFlow({ journeyId }: { journeyId: string }) {
  const query = useQuery({
    queryKey: qk.journeyGraph(journeyId),
    queryFn: () => getJourneyGraph(journeyId),
  });

  if (query.isPending) return <TableSkeleton rows={4} />;
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  }

  return (
    <ReactFlowProvider>
      <JourneyFlowCanvas data={query.data} />
    </ReactFlowProvider>
  );
}
