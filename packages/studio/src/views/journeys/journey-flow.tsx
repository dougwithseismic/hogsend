import { useQuery } from "@tanstack/react-query";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  type EdgeTypes,
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
import { toCanvas, toJpeg, toPng, toSvg } from "html-to-image";
import {
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  FileCode2,
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
  useRef,
  useState,
} from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  ChatGptIcon,
  ClaudeIcon,
  PerplexityIcon,
} from "@/components/brand-icons";
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
  openFileInEditor,
  qk,
} from "@/lib/admin-api";
import { config } from "@/lib/config";
import { downloadDataUrl } from "@/lib/download";
import { toMermaid } from "@/lib/mermaid";
import { cn } from "@/lib/utils";
import { buildEdgePath, layoutGraph, type XY } from "./flow-layout";

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
    digest: { rail: "#39c5cf", kind: "Digest" },
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
  positions: Record<string, XY>,
): HogFlowNode[] {
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

function buildRfEdges(
  graph: JourneyGraph,
  edgePoints: Record<string, XY[]>,
): Edge[] {
  return graph.edges.map((edge) => {
    const { stroke, dashed } = edgeAppearance(edge.kind);
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.label ? { label: edge.label } : {}),
      type: "dagre",
      data: { points: edgePoints[edge.id] },
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

type DagreEdgeData = { points?: XY[] };

/**
 * Custom edge that draws dagre's routed waypoints (with rounded corners)
 * instead of a plain smoothstep between handles — so a skip-edge arcs cleanly
 * around the cards it jumps over rather than being painted straight across
 * them. `style`/`markerEnd` arrive from the edge object (per-kind stroke, dash,
 * arrow); the label is rendered here at the polyline midpoint.
 */
function DagreEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  style,
  label,
  data,
}: EdgeProps) {
  const { path, labelX, labelY } = buildEdgePath({
    points: (data as DagreEdgeData | undefined)?.points,
    sourceX,
    sourceY,
    targetX,
    targetY,
  });
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {label ? (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute rounded bg-[#0a0606]/90 px-1.5 py-0.5 text-[11px] text-white/75"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

// Stable module-scope reference — same rationale as `nodeTypes`.
const edgeTypes: EdgeTypes = { dagre: DagreEdge };

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

// --- AI chat deep links ----------------------------------------------------

/**
 * Brand preamble prepended to every AI prompt — mirrors the hogsend.com hero so
 * a shared chat carries provenance.
 */
const AI_PROMPT_PREAMBLE =
  "From hogsend.com — the code-first lifecycle marketing framework. " +
  "Build your growth engine in code.";

/** Cap for the URL-ENCODED query (mermaid inflates ~2–3× when encoded). */
const AI_QUERY_MAX = 6000;

const AI_TRUNCATION_NOTE =
  "\n%% …diagram truncated to fit the chat URL — use the toolbar's Copy Mermaid for the full source.";

function buildAiPrompt(graph: JourneyGraph): string {
  const head =
    `${AI_PROMPT_PREAMBLE}\n\n` +
    "Here is a lifecycle journey defined in code (Mermaid). " +
    "Explain what it does and suggest improvements:\n\n";
  const meta =
    `\n\nJourney: \`${graph.journeyId}\` — ` +
    `${graph.nodes.length} nodes, ${graph.edges.length} edges.`;
  const wrap = (body: string) => `${head}\`\`\`mermaid\n${body}\n\`\`\`${meta}`;
  const fits = (body: string) =>
    encodeURIComponent(wrap(body)).length <= AI_QUERY_MAX;

  let body = toMermaid(graph);
  if (!fits(body)) {
    while (body.length > 0 && !fits(`${body}${AI_TRUNCATION_NOTE}`)) {
      body = body.slice(0, Math.max(0, body.length - 250));
    }
    body = `${body}${AI_TRUNCATION_NOTE}`;
  }
  return wrap(body);
}

type AiTarget = "claude" | "chatgpt" | "perplexity";

function aiChatUrl(target: AiTarget, prompt: string): string {
  const q = encodeURIComponent(prompt);
  switch (target) {
    case "claude":
      return `https://claude.ai/new?q=${q}`;
    case "chatgpt":
      return `https://chatgpt.com/?q=${q}`;
    case "perplexity":
      return `https://www.perplexity.ai/search?q=${q}`;
  }
}

type AiTargetDef = {
  id: AiTarget;
  label: string;
  Icon: (props: { className?: string }) => ReactNode;
  /** Brand tint for the mark. */
  color: string;
};

const AI_TARGETS: readonly AiTargetDef[] = [
  { id: "claude", label: "Claude", Icon: ClaudeIcon, color: "#d97757" },
  { id: "chatgpt", label: "ChatGPT", Icon: ChatGptIcon, color: "#ededed" },
  {
    id: "perplexity",
    label: "Perplexity",
    Icon: PerplexityIcon,
    color: "#20b8cd",
  },
];

const AI_STORAGE_KEY = "hs.studio.ai-share";

type SplitItem<T extends string> = {
  id: T;
  label: string;
  Icon?: (props: { className?: string }) => ReactNode;
  /** Brand tint for the mark, if any. */
  color?: string;
};

/**
 * The crimzon split button: a primary that fires the last-picked option
 * (persisted per browser under `storageKey`) and a caret that reveals the rest.
 * Outside-click / Escape close the menu. Shared by the "Ask AI" and "Export"
 * toolbar actions so they stay pixel-identical.
 */
function SplitButton<T extends string>({
  items,
  storageKey,
  defaultId,
  onAct,
  renderLabel,
  caretLabel,
  primaryIcon,
}: {
  items: readonly SplitItem<T>[];
  storageKey: string;
  defaultId: T;
  onAct: (id: T) => void;
  renderLabel: (item: SplitItem<T>) => string;
  caretLabel: string;
  primaryIcon?: {
    Icon: (props: { className?: string }) => ReactNode;
    color?: string;
  };
}) {
  const isKnown = useCallback(
    (v: string | null): v is T => !!v && items.some((i) => i.id === v),
    [items],
  );
  const [selected, setSelected] = useState<T>(() => {
    try {
      const v = localStorage.getItem(storageKey);
      if (isKnown(v)) return v;
    } catch {
      // localStorage can throw (privacy mode) — fall back to the default.
    }
    return defaultId;
  });
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      // `Node` is shadowed by React Flow's node type — reach for the DOM one.
      const target = e.target;
      if (
        rootRef.current &&
        target instanceof globalThis.Node &&
        !rootRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = items.find((i) => i.id === selected) ?? items[0];
  if (!current) return null;

  const choose = (id: T) => {
    setSelected(id);
    try {
      localStorage.setItem(storageKey, id);
    } catch {
      // best-effort persistence
    }
    setOpen(false);
    onAct(id);
  };

  const primary =
    primaryIcon ??
    (current.Icon ? { Icon: current.Icon, color: current.color } : undefined);
  const PrimaryIcon = primary?.Icon;

  return (
    <div ref={rootRef} className="relative inline-flex">
      <Button
        variant="outline"
        size="sm"
        className="rounded-r-none pr-2.5"
        onClick={() => onAct(current.id)}
      >
        {PrimaryIcon ? (
          <span
            className="inline-flex"
            style={primary?.color ? { color: primary.color } : undefined}
          >
            <PrimaryIcon className="h-3.5 w-3.5" />
          </span>
        ) : null}
        {renderLabel(current)}
      </Button>
      <Button
        variant="outline"
        size="sm"
        aria-label={caretLabel}
        aria-expanded={open}
        className="rounded-l-none border-l-0 px-1.5"
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </Button>
      {open ? (
        <div className="absolute right-0 top-full z-20 mt-1 min-w-[10rem] overflow-hidden rounded-md border border-hairline-faint bg-raised shadow-lg">
          {items.map((item) => {
            const Icon = item.Icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => choose(item.id)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-white/80 transition-colors hover:bg-white/5"
              >
                {Icon ? (
                  <span
                    className="inline-flex"
                    style={item.color ? { color: item.color } : undefined}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                ) : null}
                {renderLabel(item)}
                {item.id === selected ? (
                  <Check className="ml-auto h-3 w-3 text-accent" />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** Ask-an-AI split button — real brand marks, sticky choice. */
function AiShareButton({ graph }: { graph: JourneyGraph }) {
  const { toast } = useToast();
  const openTarget = useCallback(
    (target: AiTarget) => {
      try {
        window.open(
          aiChatUrl(target, buildAiPrompt(graph)),
          "_blank",
          "noopener,noreferrer",
        );
      } catch {
        toast({ variant: "error", title: "Could not open the AI chat" });
      }
    },
    [graph, toast],
  );

  return (
    <SplitButton<AiTarget>
      items={AI_TARGETS}
      storageKey={AI_STORAGE_KEY}
      defaultId="claude"
      onAct={openTarget}
      renderLabel={(item) => `Ask ${item.label}`}
      caretLabel="Choose an AI"
    />
  );
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

function SendNodePreview({
  template,
  templatePath,
}: {
  template: string;
  templatePath?: string;
}) {
  const { toast } = useToast();
  const query = useQuery({
    queryKey: qk.templatePreview(template),
    queryFn: () => getTemplatePreview(template),
  });
  const openHref = `${config.baseUrl}/v1/admin/templates/${encodeURIComponent(
    template,
  )}/preview?format=html`;
  const canOpenIde = config.isLocalhost && !!templatePath;
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <SectionHeading>Email preview</SectionHeading>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              window.open(openHref, "_blank", "noopener,noreferrer")
            }
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Preview
          </Button>
          {canOpenIde ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (!templatePath) return;
                openFileInEditor(templatePath).catch(() => {
                  toast({
                    variant: "error",
                    title: "Couldn't open your editor",
                  });
                });
              }}
            >
              <FileCode2 className="h-3.5 w-3.5" />
              Open in IDE
            </Button>
          ) : null}
        </div>
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
          <SendNodePreview
            template={templateKey}
            templatePath={metric.templatePath}
          />
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

// --- Export ----------------------------------------------------------------

/**
 * Shared html-to-image options — structurally a subset of the package's
 * (non-re-exported) `Options`, so it stays assignable to toPng/toJpeg/toSvg/
 * toCanvas.
 */
type CaptureOptions = {
  backgroundColor: string;
  width: number;
  height: number;
  style: { width: string; height: string; transform: string };
};

/** Frame every node into the same fixed 1400x900 box the PNG export used. */
function captureFlowImage(
  getNodes: () => Node[],
): { node: HTMLElement; options: CaptureOptions } | null {
  const node = document.querySelector<HTMLElement>(".react-flow__viewport");
  if (!node) return null;
  const width = 1400;
  const height = 900;
  const bounds = getNodesBounds(getNodes());
  const transform = getViewportForBounds(bounds, width, height, 0.3, 2, 0.15);
  return {
    node,
    options: {
      backgroundColor: "#050101",
      width,
      height,
      style: {
        width: `${width}px`,
        height: `${height}px`,
        transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.zoom})`,
      },
    },
  };
}

/** html-to-image has no `toWebp` — render to a canvas, then encode WebP. */
async function toWebp(
  node: HTMLElement,
  options: CaptureOptions,
): Promise<string> {
  const canvas = await toCanvas(node, options);
  return canvas.toDataURL("image/webp", 0.92);
}

type ExportFormat = "png" | "jpeg" | "webp" | "svg";

type ExportFormatDef = SplitItem<ExportFormat> & {
  ext: string;
  encode: (node: HTMLElement, options: CaptureOptions) => Promise<string>;
};

// JPEG relies on the solid `backgroundColor` in CaptureOptions ("#050101").
const EXPORT_FORMATS: readonly ExportFormatDef[] = [
  { id: "png", label: "PNG", ext: "png", encode: toPng },
  { id: "jpeg", label: "JPEG", ext: "jpg", encode: toJpeg },
  { id: "webp", label: "WebP", ext: "webp", encode: toWebp },
  { id: "svg", label: "SVG", ext: "svg", encode: toSvg },
];

const EXPORT_STORAGE_KEY = "hs.studio.export-format";

/** Export the flow as an image — split button, format persisted per browser. */
function ExportButton({ graph }: { graph: JourneyGraph }) {
  const { getNodes } = useReactFlow();
  const { toast } = useToast();

  const runExport = useCallback(
    async (id: ExportFormat) => {
      const format =
        EXPORT_FORMATS.find((f) => f.id === id) ?? EXPORT_FORMATS[0];
      if (!format) return;
      const capture = captureFlowImage(getNodes);
      if (!capture) return;
      try {
        const dataUrl = await format.encode(capture.node, capture.options);
        downloadDataUrl(
          `journey-${graph.journeyId}-flow.${format.ext}`,
          dataUrl,
        );
      } catch {
        toast({ variant: "error", title: `${format.label} export failed` });
      }
    },
    [getNodes, graph.journeyId, toast],
  );

  return (
    <SplitButton<ExportFormat>
      items={EXPORT_FORMATS}
      storageKey={EXPORT_STORAGE_KEY}
      defaultId="png"
      onAct={(id) => void runExport(id)}
      renderLabel={(item) => `Export ${item.label}`}
      caretLabel="Choose an image format"
      primaryIcon={{ Icon: ImageDown }}
    />
  );
}

// --- Toolbar ---------------------------------------------------------------

function FlowToolbar({ graph }: { graph: JourneyGraph }) {
  const { fitView } = useReactFlow();
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

  // Feature B — open the journey source file in the developer's editor. Dev-only:
  // the engine (same machine) auto-detects the running editor and spawns it.
  const source = graph.source;
  const canOpenInEditor = config.isLocalhost && !!source?.path;
  const onOpenInEditor = useCallback(() => {
    if (!source?.path) return;
    openFileInEditor(source.path, source.line).catch(() => {
      toast({
        variant: "error",
        title: "Couldn't open your editor",
        description: "The dev server must be running on this machine.",
      });
    });
  }, [source, toast]);

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

      {/* Feature A — ask an AI about this journey (split button, real logos) */}
      <AiShareButton graph={graph} />

      {/* Export the flow — split button with PNG/JPEG/WebP/SVG */}
      <ExportButton graph={graph} />

      {/* Feature B — open the journey file in your editor (local dev only) */}
      {canOpenInEditor ? (
        <Button variant="outline" size="sm" onClick={onOpenInEditor}>
          <FileCode2 className="h-3.5 w-3.5" />
          Open in IDE
        </Button>
      ) : null}
    </div>
  );
}

// --- Canvas + inline resizable side panel ---------------------------------

function JourneyFlowCanvas({ data }: { data: JourneyGraphResponse }) {
  const { graph, metrics } = data;
  const { fitView } = useReactFlow();

  const graphLayout = useMemo(
    () =>
      layoutGraph({
        nodes: graph.nodes.map((n) => ({ id: n.id, type: n.type })),
        edges: graph.edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
        })),
      }),
    [graph],
  );
  const rfNodes = useMemo(
    () => buildRfNodes(graph, metrics, graphLayout.positions),
    [graph, metrics, graphLayout],
  );
  const rfEdges = useMemo(
    () => buildRfEdges(graph, graphLayout.edgePoints),
    [graph, graphLayout],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(rfNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(rfEdges);

  const flowWrapRef = useRef<HTMLDivElement>(null);

  // Re-sync when a refetch produces a new graph/metrics (idempotent under
  // StrictMode — setState with the same value is a no-op).
  useEffect(() => setNodes(rfNodes), [rfNodes, setNodes]);
  useEffect(() => setEdges(rfEdges), [rfEdges, setEdges]);

  // Fit the graph once the pane actually has real dimensions. The canvas lives
  // in a react-resizable-panels Panel whose size is set async (ResizeObserver),
  // so a mount-time fitView measures a near-zero box and shrinks the whole
  // journey to a speck that never grows back. Refitting on every real resize
  // (mount, panel settle, divider drag) keeps the diagram filling the card.
  useEffect(() => {
    const el = flowWrapRef.current;
    if (!el) return;
    let raf = 0;
    const refit = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (el.clientWidth > 0 && el.clientHeight > 0) {
          fitView({ padding: 0.15 });
        }
      });
    };
    const observer = new ResizeObserver(refit);
    observer.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [fitView]);

  // Refit when a refetch swaps in a new graph (pane size unchanged, so the
  // observer above won't fire).
  useEffect(() => {
    if (rfNodes.length === 0) return;
    const raf = requestAnimationFrame(() => fitView({ padding: 0.15 }));
    return () => cancelAnimationFrame(raf);
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

      {/* The fixed height MUST live on this wrapper, not on PanelGroup —
          react-resizable-panels forces an inline `height: 100%` on the group,
          which overrides any height class on it, so a bare `h-[…]` there is
          silently ignored and the card collapses to content height. */}
      <div className="h-[820px] overflow-hidden rounded-md border border-hairline-faint bg-black/20">
        <PanelGroup direction="horizontal" className="h-full">
          <Panel defaultSize={62} minSize={40}>
            {/* Re-lock when the pointer leaves so wheel-scroll returns to the
              page (a "pane-blur" lock), plus the explicit Lock button. The
              wrapper isn't a control — the overlay button + Lock button are. */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-leave re-locks pan/zoom; the interactive affordances are the overlay + Lock buttons */}
            <div
              ref={flowWrapRef}
              className="relative h-full"
              onMouseLeave={() => setInteractive(false)}
            >
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
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
