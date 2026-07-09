import dagre from "@dagrejs/dagre";
import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  getNodesBounds,
  getViewportForBounds,
  MiniMap,
  type Node,
  Position,
  ReactFlow,
} from "@xyflow/react";
import { useMemo, useRef, useState } from "react";
import "@xyflow/react/dist/style.css";
import { useQuery } from "@tanstack/react-query";
import { toPng } from "html-to-image";
import {
  BarChart3,
  Check,
  Copy,
  ExternalLink,
  GitBranch,
  ImageDown,
  Settings2,
  SquareArrowOutUpRight,
  TriangleAlert,
  X,
} from "lucide-react";
import { EmptyState, ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import {
  getJourneyGraph,
  getJourneyTemplates,
  getTemplatePreview,
  type JourneyGraphData,
  type JourneyGraphNode,
  type JourneyTemplate,
  listJourneyStates,
  qk,
} from "@/lib/admin-api";
import { formatNumber, formatRelative } from "@/lib/format";
import {
  buildSourceLink,
  getSourceLinkConfig,
  IDE_PRESETS,
  type OpenMode,
  type SourceLinkConfig,
  setSourceLinkConfig,
} from "@/lib/ide-links";
import { mermaidLiveUrl } from "@/lib/mermaid-live";
import type { FlowEdgeData } from "./flow-edges";
import { FLOW_EDGE_TYPES } from "./flow-edges";
import type { FlowNodeMetrics } from "./flow-nodes";
import { FLOW_NODE_TYPES, FLOW_NODE_WIDTH } from "./flow-nodes";

/**
 * The "Flow" tab on the journey detail page. Renders the journey's authored
 * control flow as a read-only, dagre-laid canvas of crimson nodes with live
 * counts overlaid. Clicking a node opens a side panel with kind-specific
 * detail — email nodes preview their template, every node deep-links to the
 * authored source. Falls back to a metadata skeleton when no rich graph
 * manifest has been generated.
 */

// Node box width fed to dagre = the exact rendered width (fixed in flow-nodes).
const NODE_WIDTH = FLOW_NODE_WIDTH;
// Nominal height, used only for PNG-export framing bounds.
const NODE_HEIGHT = 96;

/**
 * Estimate a node's rendered height so dagre reserves the right vertical space
 * (the fix for overlapping ranks). Deliberately GENEROUS — over-reserving just
 * adds a little gap, whereas under-reserving overlaps. Mirrors the rendered
 * card: kind row + up to 2 wrapped label lines + optional detail + optional
 * metrics overlay (email nodes when the Metrics toggle is on).
 */
function estimateNodeHeight(
  node: JourneyGraphNode,
  showMetrics: boolean,
): number {
  let h = 46; // vertical padding + kind/icon row
  const lines = Math.min(
    2,
    Math.max(1, Math.ceil((node.label.length || 1) / 22)),
  );
  h += lines * 19;
  if (node.detail) h += 17;
  if (showMetrics && node.kind === "email") h += 34;
  return h;
}

/** Canvas layout direction. Persisted per-user in localStorage. */
type LayoutMode = "TB" | "LR" | "compact";
const LAYOUT_KEY = "hogsend.studio.flow.layout";
function getLayout(): LayoutMode {
  if (typeof localStorage === "undefined") return "TB";
  const v = localStorage.getItem(LAYOUT_KEY);
  return v === "LR" || v === "compact" ? v : "TB";
}
function persistLayout(mode: LayoutMode): void {
  if (typeof localStorage !== "undefined")
    localStorage.setItem(LAYOUT_KEY, mode);
}

/**
 * Run dagre over the graph to assign x/y positions to each node, tuned per
 * layout mode. `compact` uses the tight-tree ranker with smaller separation
 * for dense journeys; `LR` flows left→right (handles move to the sides). Each
 * node is sized with its real width + an estimated height so ranks never
 * overlap and edges route in the gaps between them.
 */
function layoutGraph(
  graph: JourneyGraphData,
  mode: LayoutMode,
  showMetrics: boolean,
): {
  nodes: Node[];
  edges: Edge[];
  fallback: boolean;
} {
  const horizontal = mode === "LR";
  const compact = mode === "compact";

  // Build the dagre graph. Separations are tuned so branch arms and edge label
  // chips get breathing room without ballooning large journeys.
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: horizontal ? "LR" : "TB",
    nodesep: compact ? 28 : 58,
    ranksep: compact ? 56 : 96,
    edgesep: compact ? 12 : 26,
    ranker: compact ? "tight-tree" : "network-simplex",
    marginx: 28,
    marginy: 28,
  });
  g.setDefaultEdgeLabel(() => ({}));
  const heights = new Map<string, number>();
  for (const node of graph.nodes) {
    const h = estimateNodeHeight(node, showMetrics);
    heights.set(node.id, h);
    g.setNode(node.id, { width: NODE_WIDTH, height: h });
  }
  for (const edge of graph.edges) {
    // Passing the label reserves space so branch-arm labels don't overlap.
    g.setEdge(edge.from, edge.to, edge.label ? { label: edge.label } : {});
  }

  // dagre assumes a DAG; a cyclic graph (e.g. from a buggy extractor or a
  // hand-edited manifest) can throw or produce broken positions. Fall back to
  // a simple stack so the canvas always renders SOMETHING.
  let fallback = false;
  const positions = new Map<string, { x: number; y: number }>();
  try {
    dagre.layout(g);
    for (const node of graph.nodes) {
      const p = g.node(node.id);
      if (p) positions.set(node.id, { x: p.x, y: p.y });
    }
  } catch {
    fallback = true;
    graph.nodes.forEach((node, i) => {
      positions.set(
        node.id,
        horizontal
          ? { x: i * (NODE_WIDTH + 70), y: 0 }
          : { x: 0, y: i * (NODE_HEIGHT + 48) },
      );
    });
  }

  // Handle placement follows the flow direction so edges attach cleanly.
  const targetPosition = horizontal ? Position.Left : Position.Top;
  const sourcePosition = horizontal ? Position.Right : Position.Bottom;

  const nodes: Node[] = graph.nodes.map((node) => {
    const positioned = positions.get(node.id);
    const h = heights.get(node.id) ?? NODE_HEIGHT;
    // dagre gives centers; ReactFlow wants top-left — offset by half the node's
    // OWN width/height so variable-height nodes still center on their rank.
    return {
      id: node.id,
      type: "journeyNode",
      position: {
        x: (positioned?.x ?? 0) - NODE_WIDTH / 2,
        y: (positioned?.y ?? 0) - h / 2,
      },
      sourcePosition,
      targetPosition,
      data: { node },
      draggable: false,
      connectable: false,
    };
  });

  // Semantic edges: kind → color, label → chip, both rendered by the custom
  // journeyEdge component. `live` is attached later (needs counts).
  //
  // Crucially, we thread dagre's OWN routed waypoints into each edge — dagre
  // bends multi-rank edges AROUND the nodes between their endpoints. Without
  // these, ReactFlow would draw a straight line from source to target that
  // slices through any node in the column (e.g. a `branch → end` edge cutting
  // through the email/connector nodes on the fall-through path). Points are in
  // dagre's coordinate space, which equals ReactFlow flow-space here (we only
  // offset each node center→top-left), so they drop in directly.
  const edges: Edge[] = graph.edges.map((edge, i) => {
    const routed = fallback ? undefined : g.edge(edge.from, edge.to);
    const points = routed?.points?.map((p) => ({ x: p.x, y: p.y }));
    return {
      id: `e${i}-${edge.from}-${edge.to}`,
      source: edge.from,
      target: edge.to,
      type: "journeyEdge",
      data: {
        kind: edge.kind,
        label: edge.label,
        live: false,
        points,
      } satisfies FlowEdgeData,
    };
  });

  return { nodes, edges, fallback };
}

/**
 * Normalize a template reference for joining graph nodes to observed
 * `email_sends.templateKey` values. Used as a FALLBACK only — the extractor
 * now resolves an exact `templateKey` for most nodes (see metricsForNode).
 */
function normalizeTemplateKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/^templates\./, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Find the observed send metrics for an email node, if any. */
function metricsForNode(
  node: JourneyGraphNode,
  templates: JourneyTemplate[] | undefined,
): FlowNodeMetrics | undefined {
  if (node.kind !== "email" || !templates?.length) return undefined;
  // Prefer the extractor's resolved `templateKey` — an exact join to
  // `email_sends.templateKey`. Fall back to the fuzzy normalize-and-match on
  // the authored ref only when the key couldn't be resolved statically.
  const match = node.templateKey
    ? (templates.find((t) => t.templateKey === node.templateKey) ??
      templates.find(
        (t) => normalizeTemplateKey(t.templateKey) === node.templateKey,
      ))
    : templates.find(
        (t) =>
          normalizeTemplateKey(t.templateKey) ===
          normalizeTemplateKey(node.detail ?? node.label),
      );
  if (!match) return undefined;
  return { sent: match.sent, opened: match.opened, clicked: match.clicked };
}

/** Legend mapping node kinds to their labels. */
const LEGEND: Array<{ kind: JourneyGraphNode["kind"]; label: string }> = [
  { kind: "trigger", label: "Trigger" },
  { kind: "email", label: "Email" },
  { kind: "inapp", label: "In-app" },
  { kind: "connector", label: "Connector" },
  { kind: "sleep", label: "Sleep" },
  { kind: "wait", label: "Wait for event" },
  { kind: "branch", label: "Branch" },
  { kind: "trigger-event", label: "Emitted trigger" },
  { kind: "checkpoint", label: "Checkpoint" },
  { kind: "exit", label: "Exit" },
  { kind: "end", label: "End" },
];

/** Approximate node fill per kind, for the framed PNG legend. */
const KIND_HEX: Record<JourneyGraphNode["kind"], string> = {
  trigger: "#f64838",
  email: "#f64838",
  inapp: "#d1d5db",
  connector: "#9ca3af",
  sleep: "#6b7280",
  schedule: "#6b7280",
  wait: "#f64838",
  branch: "#f64838",
  "trigger-event": "#f64838",
  checkpoint: "#9ca3af",
  exit: "#9ca3af",
  end: "#6b7280",
};

export function JourneyFlow({ journeyId }: { journeyId: string }) {
  const query = useQuery({
    queryKey: qk.journeyGraph(journeyId),
    queryFn: () => getJourneyGraph(journeyId),
  });

  if (query.isPending) {
    return <Skeleton className="h-[420px] w-full" />;
  }
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  }

  const {
    mermaid,
    graph,
    counts,
    sourceLevel,
    generatedAt,
    stale,
    staleReason,
  } = query.data;

  // Metadata-only skeleton: no authored control flow to show.
  if (sourceLevel === "metadata") {
    return (
      <EmptyState
        icon={GitBranch}
        title="No flow graph yet"
        description="Run `hogsend journeys graph --all` to generate the authored control flow, then reload."
      />
    );
  }

  return (
    <FlowCanvas
      journeyId={journeyId}
      mermaid={mermaid}
      graph={graph}
      counts={counts.perNode}
      generatedAt={generatedAt}
      stale={stale}
      staleReason={staleReason}
    />
  );
}

/** Copy-to-clipboard button with a transient "copied" check. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-6 px-1.5"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? (
        <Check className="h-3 w-3 text-emerald-400" strokeWidth={1.5} />
      ) : (
        <Copy className="h-3 w-3" strokeWidth={1.5} />
      )}
    </Button>
  );
}

/**
 * Settings for "open source" links. Two modes:
 *   - Repo link (default, easiest): paste your GitHub/GitLab blob base once and
 *     every node links there — works on any machine, shareable, no editor
 *     install needed.
 *   - Local IDE (power users): a `vscode://`-style scheme + your absolute
 *     checkout root (kept on-device, never sent to the server).
 */
function SourceLinkDialog({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (config: SourceLinkConfig) => void;
}) {
  const initial = getSourceLinkConfig();
  const [mode, setMode] = useState<OpenMode>(initial.mode);
  const [repoBaseUrl, setRepoBaseUrl] = useState(initial.repoBaseUrl);
  const matchedPreset =
    IDE_PRESETS.find((p) => p.template === initial.template)?.id ?? "custom";
  const [presetId, setPresetId] = useState(matchedPreset);
  const [template, setTemplate] = useState(initial.template);
  const [projectRoot, setProjectRoot] = useState(initial.projectRoot);

  const modes: Array<{ id: OpenMode; label: string }> = [
    { id: "repo", label: "Repo link" },
    { id: "ide", label: "Local IDE" },
  ];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Open source"
      description="Jump from a node to its authored source at the exact line."
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => {
              const config = { mode, repoBaseUrl, template, projectRoot };
              setSourceLinkConfig(config);
              onSave(config);
              onClose();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      {/* Mode toggle */}
      <div className="flex overflow-hidden rounded-md border border-hairline-faint">
        {modes.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setMode(m.id)}
            className={`flex-1 px-3 py-1.5 text-sm transition-colors ${
              mode === m.id
                ? "bg-accent-tint text-white"
                : "text-white/50 hover:bg-white/[0.04] hover:text-white/80"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === "repo" ? (
        <div className="space-y-1.5">
          <Label htmlFor="repo-base">Repository blob URL</Label>
          <Input
            id="repo-base"
            value={repoBaseUrl}
            onChange={(e) => setRepoBaseUrl(e.target.value)}
            placeholder="https://github.com/org/repo/blob/main"
          />
          <p className="text-xs text-white/40">
            The base for a source file at a branch. A node's path + line is
            appended, e.g.{" "}
            <code className="font-mono">…/blob/main/src/journeys/x.ts#L42</code>
            . Works anywhere and is shareable — no editor install needed.
          </p>
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="ide-preset">Editor</Label>
            <Select
              id="ide-preset"
              value={presetId}
              onChange={(e) => {
                const id = e.target.value;
                setPresetId(id);
                const preset = IDE_PRESETS.find((p) => p.id === id);
                if (preset) setTemplate(preset.template);
              }}
            >
              {IDE_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
              <option value="custom">Custom…</option>
            </Select>
          </div>

          {presetId === "custom" ? (
            <div className="space-y-1.5">
              <Label htmlFor="ide-template">URL template</Label>
              <Input
                id="ide-template"
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                placeholder="vscode://file{path}:{line}"
              />
              <p className="text-xs text-white/40">
                Placeholders: {"{path}"} (absolute), {"{line}"}, {"{relPath}"},{" "}
                {"{root}"}.
              </p>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="ide-root">Local project root</Label>
            <Input
              id="ide-root"
              value={projectRoot}
              onChange={(e) => setProjectRoot(e.target.value)}
              placeholder="/Users/you/code/my-app"
            />
            <p className="text-xs text-white/40">
              Absolute path to your checkout on this machine — kept on this
              device, never sent to the server. A `vscode://` link silently does
              nothing if the editor isn't installed.
            </p>
          </div>
        </>
      )}
    </Dialog>
  );
}

/** Compact rendered preview of an email template for the node panel. */
function TemplatePreviewPanel({ node }: { node: JourneyGraphNode }) {
  const key = node.templateKey;
  const query = useQuery({
    queryKey: qk.templatePreview(key ?? ""),
    queryFn: () => getTemplatePreview(key as string),
    enabled: Boolean(key),
  });

  if (!key) {
    return (
      <div className="border-t border-hairline-faint pt-2 text-xs text-white/45">
        Template not resolved from source
        {node.templateRef ? (
          <>
            {" "}
            (<code className="font-mono text-white/55">{node.templateRef}</code>
            ) — it may be computed at runtime.
          </>
        ) : (
          "."
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1.5 border-t border-hairline-faint pt-2">
      <div className="text-[10px] uppercase tracking-wide text-white/40">
        Template preview
      </div>
      {query.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : query.isError || !query.data ? (
        <p className="text-xs text-white/45">
          Preview unavailable for <code className="font-mono">{key}</code> — it
          isn't in the email registry.
        </p>
      ) : (
        <>
          <div className="text-xs text-white/70">
            <span className="text-white/40">Subject: </span>
            {query.data.subject}
          </div>
          {/* Sandboxed, script-free preview: consumer-authored HTML must never
              execute inside Studio (same lesson as the docs Mermaid XSS pass). */}
          <div className="h-44 overflow-hidden rounded border border-hairline-faint bg-white">
            <iframe
              title={`Preview of ${key}`}
              srcDoc={query.data.html}
              sandbox=""
              className="h-[420px] w-[600px] origin-top-left"
              style={{ transform: "scale(0.44)", border: "0" }}
            />
          </div>
        </>
      )}
      {/* Jump to the full Templates page for this template (stats, send-test,
          full-size preview) — deep-linked by key. */}
      <a
        href={`/studio/templates?key=${encodeURIComponent(key)}`}
        className="inline-flex items-center gap-1 text-[11px] text-accent/90 hover:text-accent"
      >
        View in Templates
        <ExternalLink className="h-3 w-3" strokeWidth={1.5} />
      </a>
    </div>
  );
}

/**
 * Side panel for a clicked node. Kind-specific detail:
 *   - email: template preview + per-template send metrics
 *   - branch: condition + yes/no destinations
 *   - wait: event, timeout, users parked here
 *   - sleep/schedule: duration / when expression
 *   - trigger / trigger-event / exit: the event contract
 * Every node offers an "Open in IDE" deep link (or a copy fallback) to its
 * authored `file:line`.
 */
function NodePanel({
  journeyId,
  graph,
  node,
  count,
  metrics,
  onClose,
}: {
  journeyId: string;
  graph: JourneyGraphData;
  node: JourneyGraphNode;
  count: number | undefined;
  metrics: FlowNodeMetrics | undefined;
  onClose: () => void;
}) {
  const [linkConfig, setLinkConfig] = useState<SourceLinkConfig>(
    getSourceLinkConfig(),
  );
  const [ideOpen, setIdeOpen] = useState(false);

  const statesQuery = useQuery({
    queryKey: qk.journeyStates(journeyId, { node: node.countKey, limit: 8 }),
    queryFn: () =>
      listJourneyStates(journeyId, { node: node.countKey, limit: 8 }),
    enabled: Boolean(node.countKey),
  });

  const sourceFile = graph.sourceFile;
  const codePointer =
    sourceFile && node.sourceLine
      ? `${sourceFile}:${node.sourceLine}`
      : sourceFile;
  const sourceLink =
    sourceFile != null
      ? buildSourceLink({
          sourceFile,
          line: node.sourceLine,
          config: linkConfig,
        })
      : null;

  // Branch arms: outgoing edges labelled yes/no → their target node labels.
  const branchArms =
    node.kind === "branch"
      ? graph.edges
          .filter((e) => e.from === node.id)
          .map((e) => ({
            label: e.label ?? "→",
            target: graph.nodes.find((n) => n.id === e.to)?.label ?? e.to,
          }))
      : [];

  return (
    <div className="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto rounded-md border border-hairline-faint bg-white/[0.015] p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-white/40">
            {node.kind}
          </div>
          <div className="mt-0.5 text-sm text-white/90">{node.label}</div>
          {node.detail ? (
            <div className="mt-0.5 font-mono text-[11px] text-white/45">
              {node.detail}
            </div>
          ) : null}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-1.5"
          onClick={onClose}
        >
          <X className="h-3 w-3" strokeWidth={1.5} />
        </Button>
      </div>

      {count !== undefined && count > 0 ? (
        <div className="text-xs text-white/60">
          <span className="font-medium text-white/90">
            {formatNumber(count)}
          </span>{" "}
          user(s) currently here
        </div>
      ) : null}

      {/* Kind-specific detail. */}
      {node.kind === "email" ? <TemplatePreviewPanel node={node} /> : null}

      {node.kind === "branch" && branchArms.length > 0 ? (
        <div className="space-y-1 border-t border-hairline-faint pt-2 text-xs text-white/60">
          <div className="text-[10px] uppercase tracking-wide text-white/40">
            Branches to
          </div>
          {branchArms.map((arm) => (
            <div
              key={`${arm.label}-${arm.target}`}
              className="flex items-center justify-between gap-2"
            >
              <span className="shrink-0 rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-white/70">
                {arm.label}
              </span>
              <span className="min-w-0 truncate text-right text-white/80">
                {arm.target}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {node.kind === "wait" ? (
        <div className="space-y-1 border-t border-hairline-faint pt-2 text-xs text-white/60">
          <div className="flex justify-between gap-2">
            <span>Waits for</span>
            <span className="min-w-0 truncate font-mono text-white/85">
              {node.label}
            </span>
          </div>
          {node.detail ? (
            <div className="flex justify-between gap-2">
              <span>Timeout</span>
              <span className="text-white/85">
                {node.detail.replace(/^timeout /, "")}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {(node.kind === "sleep" || node.kind === "schedule") && node.detail ? (
        <div className="flex justify-between gap-2 border-t border-hairline-faint pt-2 text-xs text-white/60">
          <span>{node.kind === "sleep" ? "Duration" : "When"}</span>
          <span className="min-w-0 truncate font-mono text-white/85">
            {node.detail}
          </span>
        </div>
      ) : null}

      {node.kind === "trigger" ||
      node.kind === "trigger-event" ||
      node.kind === "exit" ? (
        <div className="flex justify-between gap-2 border-t border-hairline-faint pt-2 text-xs text-white/60">
          <span>
            {node.kind === "trigger"
              ? "Entry event"
              : node.kind === "exit"
                ? "Exit event"
                : "Emits"}
          </span>
          <span className="min-w-0 truncate font-mono text-white/85">
            {node.label}
          </span>
        </div>
      ) : null}

      {metrics ? (
        <div className="space-y-1 border-t border-hairline-faint pt-2 text-xs text-white/60">
          <div className="flex justify-between">
            <span>Sent</span>
            <span className="text-white/90">{formatNumber(metrics.sent)}</span>
          </div>
          <div className="flex justify-between">
            <span>Opened</span>
            <span className="text-white/90">
              {formatNumber(metrics.opened)}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Clicked</span>
            <span className="text-white/90">
              {formatNumber(metrics.clicked)}
            </span>
          </div>
        </div>
      ) : null}

      {codePointer ? (
        <div className="space-y-1.5 border-t border-hairline-faint pt-2">
          <div className="flex items-center gap-1.5">
            <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-white/55">
              {codePointer}
            </code>
            <CopyButton text={codePointer} />
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-1.5"
              aria-label="Open-source link settings"
              onClick={() => setIdeOpen(true)}
            >
              <Settings2 className="h-3 w-3" strokeWidth={1.5} />
            </Button>
          </div>
          {sourceLink ? (
            <a
              href={sourceLink.url}
              target={sourceLink.web ? "_blank" : undefined}
              rel={sourceLink.web ? "noopener" : undefined}
              className="inline-block"
            >
              <Button
                variant="outline"
                size="sm"
                className="h-6 gap-1 px-2 text-[11px]"
              >
                <ExternalLink className="h-3 w-3" strokeWidth={1.5} />
                {sourceLink.label}
              </Button>
            </a>
          ) : (
            <button
              type="button"
              className="text-[11px] text-white/40 underline-offset-2 hover:text-white/60 hover:underline"
              onClick={() => setIdeOpen(true)}
            >
              Set a repo URL to open the source
            </button>
          )}
        </div>
      ) : null}

      {node.countKey ? (
        <div className="border-t border-hairline-faint pt-2">
          <div className="mb-1.5 text-[10px] uppercase tracking-wide text-white/40">
            Parked here
          </div>
          {statesQuery.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : statesQuery.isError || !statesQuery.data ? (
            <p className="text-xs text-white/45">Could not load states.</p>
          ) : statesQuery.data.states.length === 0 ? (
            <p className="text-xs text-white/45">No users at this node.</p>
          ) : (
            <ul className="space-y-1.5">
              {statesQuery.data.states.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span className="min-w-0 truncate text-white/80">
                    {s.userEmail || s.userId}
                  </span>
                  <span className="shrink-0 text-white/40">
                    {formatRelative(s.updatedAt)}
                  </span>
                </li>
              ))}
              {statesQuery.data.total > statesQuery.data.states.length ? (
                <li className="text-[11px] text-white/40">
                  +{statesQuery.data.total - statesQuery.data.states.length}{" "}
                  more
                </li>
              ) : null}
            </ul>
          )}
        </div>
      ) : null}

      <SourceLinkDialog
        open={ideOpen}
        onClose={() => setIdeOpen(false)}
        onSave={setLinkConfig}
      />
    </div>
  );
}

/**
 * Export the current canvas as a deck-grade PNG: the graph bounds framed with a
 * title band (journey id + generated-at) on top and a kind legend on the
 * bottom, at 2× density. Best-effort — logs + toasts on failure via caller.
 */
async function exportPng(
  container: HTMLElement,
  nodes: Node[],
  journeyId: string,
  generatedAt: string | null,
): Promise<void> {
  const bounds = getNodesBounds(
    nodes.map((n) => ({ ...n, width: NODE_WIDTH, height: NODE_HEIGHT })),
  );
  const width = Math.min(Math.max(bounds.width + 120, 640), 4096);
  const height = Math.min(Math.max(bounds.height + 120, 480), 4096);
  const viewport = getViewportForBounds(bounds, width, height, 0.4, 2, 0.08);
  const el = container.querySelector<HTMLElement>(".react-flow__viewport");
  if (!el) return;

  const scale = 2;
  const graphUrl = await toPng(el, {
    backgroundColor: "#050101",
    width,
    height,
    pixelRatio: scale,
    style: {
      width: `${width}px`,
      height: `${height}px`,
      transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
    },
  });

  // Compose the frame: title band + graph + legend band, all at 2× density.
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("graph image failed to load"));
    img.src = graphUrl;
  });

  const pad = 24 * scale;
  const titleH = 64 * scale;
  const legendH = 44 * scale;
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height + titleH + legendH;
  const cx = canvas.getContext("2d");
  if (!cx) return;

  cx.fillStyle = "#050101";
  cx.fillRect(0, 0, canvas.width, canvas.height);

  // Title + timestamp.
  cx.textBaseline = "middle";
  cx.fillStyle = "#ffffff";
  cx.font = `600 ${20 * scale}px ui-sans-serif, system-ui, sans-serif`;
  cx.fillText(journeyId, pad, titleH * 0.42);
  cx.fillStyle = "rgba(255,255,255,0.5)";
  cx.font = `${12 * scale}px ui-sans-serif, system-ui, sans-serif`;
  const stamp = generatedAt
    ? `Generated ${formatRelative(generatedAt)}`
    : "Journey flow";
  cx.fillText(stamp, pad, titleH * 0.78);

  // Graph.
  cx.drawImage(img, 0, titleH);

  // Legend band.
  const legendY = titleH + img.height + legendH / 2;
  let lx = pad;
  cx.font = `${11 * scale}px ui-sans-serif, system-ui, sans-serif`;
  for (const item of LEGEND) {
    const dotR = 4 * scale;
    cx.fillStyle = KIND_HEX[item.kind];
    cx.beginPath();
    cx.arc(lx + dotR, legendY, dotR, 0, Math.PI * 2);
    cx.fill();
    cx.fillStyle = "rgba(255,255,255,0.65)";
    const text = item.label;
    cx.fillText(text, lx + dotR * 2 + 4 * scale, legendY);
    lx += dotR * 2 + 8 * scale + cx.measureText(text).width + 14 * scale;
    if (lx > canvas.width - pad) break; // don't overflow the frame
  }

  const a = document.createElement("a");
  a.setAttribute("download", `${journeyId}-flow.png`);
  a.setAttribute("href", canvas.toDataURL("image/png"));
  a.click();
}

function FlowCanvas({
  journeyId,
  mermaid,
  graph,
  counts,
  generatedAt,
  stale,
  staleReason,
}: {
  journeyId: string;
  mermaid: string;
  graph: JourneyGraphData;
  counts: Record<string, number>;
  generatedAt: string | null;
  stale: boolean;
  staleReason: string | null;
}) {
  const { toast } = useToast();
  const canvasRef = useRef<HTMLDivElement>(null);
  const [showMetrics, setShowMetrics] = useState(false);
  const [mermaidCopied, setMermaidCopied] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [layout, setLayoutMode] = useState<LayoutMode>(getLayout);

  const templatesQuery = useQuery({
    queryKey: qk.journeyTemplates(journeyId),
    queryFn: () => getJourneyTemplates(journeyId),
    enabled: showMetrics || selectedId !== null,
  });
  const templates = templatesQuery.data?.templates;

  const {
    nodes: rawNodes,
    edges: rawEdges,
    fallback,
  } = useMemo(
    () => layoutGraph(graph, layout, showMetrics),
    [graph, layout, showMetrics],
  );

  // Attach live counts to nodes. countKey is the single join contract with the
  // route's `perNode` (which groups by `journeyStates.currentNodeId`): the
  // extractor sets it to mirror the engine's write key for checkpoints,
  // waits, and the trigger ("start"). Nodes without a countKey (sleeps,
  // emails) correctly show no badge. Metrics attach to email nodes when the
  // overlay toggle is on.
  const nodes: Node[] = useMemo(() => {
    return rawNodes.map((n) => {
      const data = n.data as { node: JourneyGraphNode };
      const key = data.node.countKey;
      const count = key ? counts[key] : undefined;
      const metrics = showMetrics
        ? metricsForNode(data.node, templates)
        : undefined;
      return { ...n, data: { ...n.data, count, metrics } };
    });
  }, [rawNodes, counts, showMetrics, templates]);

  // Edges with live users at their source node get an animated flow dot.
  const edges: Edge[] = useMemo(() => {
    const liveNodeIds = new Set(
      rawNodes
        .filter((n) => {
          const key = (n.data as { node: JourneyGraphNode }).node.countKey;
          return key ? (counts[key] ?? 0) > 0 : false;
        })
        .map((n) => n.id),
    );
    return rawEdges.map((e) => ({
      ...e,
      data: { ...e.data, live: liveNodeIds.has(e.source) },
    }));
  }, [rawEdges, rawNodes, counts]);

  const selectedNode = selectedId
    ? (nodes.find((n) => n.id === selectedId)?.data as
        | { node: JourneyGraphNode; count?: number }
        | undefined)
    : undefined;

  async function copyMermaid() {
    if (!mermaid) return;
    try {
      await navigator.clipboard.writeText(mermaid);
      setMermaidCopied(true);
      window.setTimeout(() => setMermaidCopied(false), 1500);
      toast({
        title: "Copied Mermaid",
        description: "Journey diagram source copied to clipboard.",
      });
    } catch {
      toast({ variant: "error", title: "Copy failed" });
    }
  }

  function changeLayout(mode: LayoutMode) {
    setLayoutMode(mode);
    persistLayout(mode);
  }

  const LAYOUTS: Array<{ id: LayoutMode; label: string }> = [
    { id: "TB", label: "Top-down" },
    { id: "LR", label: "Left-right" },
    { id: "compact", label: "Compact" },
  ];

  return (
    <div className="space-y-4">
      {stale ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200/90">
          <TriangleAlert
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            strokeWidth={1.5}
          />
          <span>
            This graph may be out of date
            {staleReason ? ` — ${staleReason}` : ""}.
          </span>
        </div>
      ) : null}

      {/* Toolbar: generation info + layout selector left, canvas actions right. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-white/40">
            {generatedAt
              ? `Graph generated ${formatRelative(generatedAt)}`
              : "Graph from build manifest"}
          </span>
          <div className="flex overflow-hidden rounded-md border border-hairline-faint">
            {LAYOUTS.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => changeLayout(l.id)}
                className={`px-2 py-1 text-[11px] transition-colors ${
                  layout === l.id
                    ? "bg-accent/20 text-white"
                    : "text-white/50 hover:bg-white/[0.04] hover:text-white/80"
                }`}
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex gap-1.5">
          <Button
            variant="outline"
            size="sm"
            disabled={!mermaid}
            aria-label="Copy Mermaid diagram"
            onClick={() => void copyMermaid()}
          >
            {mermaidCopied ? (
              <Check className="h-4 w-4 text-emerald-400" strokeWidth={1.5} />
            ) : (
              <Copy className="h-4 w-4" strokeWidth={1.5} />
            )}
            {mermaidCopied ? "Copied" : "Mermaid"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!mermaid}
            aria-label="Open in mermaid.live"
            onClick={() => {
              window.open(mermaidLiveUrl(mermaid), "_blank", "noopener");
            }}
          >
            <SquareArrowOutUpRight className="h-4 w-4" strokeWidth={1.5} />
            mermaid.live
          </Button>
          <Button
            variant={showMetrics ? "default" : "outline"}
            size="sm"
            onClick={() => setShowMetrics((v) => !v)}
          >
            <BarChart3 className="h-4 w-4" strokeWidth={1.5} />
            Metrics
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (canvasRef.current) {
                exportPng(
                  canvasRef.current,
                  nodes,
                  journeyId,
                  generatedAt,
                ).catch(() =>
                  toast({ variant: "error", title: "PNG export failed" }),
                );
              }
            }}
          >
            <ImageDown className="h-4 w-4" strokeWidth={1.5} />
            PNG
          </Button>
        </div>
      </div>

      {/* The canvas — responsive height (floor 400px, cap 70vh so tall graphs
          scroll inside rather than dominating the page). A clicked node opens
          the side panel to the right. Keyed by layout so a mode switch
          remounts and re-runs fitView. */}
      <div className="flex gap-4">
        <div
          ref={canvasRef}
          className="h-[520px] min-h-[400px] max-h-[70vh] min-w-0 flex-1 overflow-hidden rounded-md border border-hairline-faint bg-white/[0.015]"
        >
          <ReactFlow
            key={layout}
            nodes={nodes}
            edges={edges}
            nodeTypes={FLOW_NODE_TYPES}
            edgeTypes={FLOW_EDGE_TYPES}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            onNodeClick={(_, node) => setSelectedId(node.id)}
            onPaneClick={() => setSelectedId(null)}
            zoomOnScroll
            panOnDrag
            fitView
            // Fill the canvas: let small graphs zoom up to ~1.5 so they don't
            // float tiny in the middle, but cap it so large (50+ node) journeys
            // don't shrink to illegibility — the user pans instead of squinting.
            fitViewOptions={{ padding: 0.16, minZoom: 0.3, maxZoom: 1.5 }}
            minZoom={0.2}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={20}
              size={1}
              color="rgba(255,255,255,0.06)"
            />
            <Controls
              className="!border-hairline-faint !bg-white/[0.04] !text-white/70"
              showInteractive={false}
            />
            {graph.nodes.length > 10 ? (
              <MiniMap
                pannable
                zoomable
                className="!border-hairline-faint !bg-[#0a0606]"
                nodeColor="rgba(255,255,255,0.12)"
                maskColor="rgba(5,1,1,0.75)"
              />
            ) : null}
          </ReactFlow>
        </div>
        {selectedNode ? (
          <NodePanel
            journeyId={journeyId}
            graph={graph}
            node={selectedNode.node}
            count={selectedNode.count}
            metrics={metricsForNode(selectedNode.node, templates)}
            onClose={() => setSelectedId(null)}
          />
        ) : null}
      </div>

      {/* Compact inline legend — dot + label per kind. */}
      <div className="flex flex-wrap gap-x-3.5 gap-y-1.5 text-xs text-white/50">
        {LEGEND.map((l) => (
          <span key={l.kind} className="inline-flex items-center gap-1.5">
            <span
              className="h-2 w-2 rounded-[3px]"
              style={{ background: KIND_HEX[l.kind] }}
            />
            {l.label}
          </span>
        ))}
      </div>

      {graph.disclaimer ? (
        <p className="text-xs text-white/45">{graph.disclaimer}</p>
      ) : null}
      {fallback ? (
        <p className="text-xs text-white/45">
          Layout engine could not arrange this graph (it may contain a cycle);
          showing a linear fallback.
        </p>
      ) : null}
    </div>
  );
}
