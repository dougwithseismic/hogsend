import { Handle, type NodeProps, Position } from "@xyflow/react";
import {
  Bell,
  CalendarClock,
  Circle,
  Clock,
  Flag,
  GitBranch,
  LogOut,
  type LucideIcon,
  Mail,
  Plug,
  Zap,
} from "lucide-react";
import { memo } from "react";
import { Badge } from "@/components/ui/badge";
import type { JourneyGraphKind, JourneyGraphNode } from "@/lib/admin-api";
import { formatNumber } from "@/lib/format";

/**
 * Custom ReactFlow nodes for the journey Flow tab. Each node is a small
 * crimzon card (border-hairline-faint, bg-white/[0.015]) with a kind icon row,
 * a label, an optional detail line, and a live-count badge top-right. Email
 * nodes optionally carry a sent/opened/clicked metrics row (the "Show
 * metrics" overlay toggle).
 *
 * Shapes are conveyed by border radius + accent rather than literal rhombus
 * geometry (ReactFlow nodes are rectangular); the icon + edge labels carry the
 * decision semantics.
 */

export interface FlowNodeMetrics {
  sent: number;
  opened: number;
  clicked: number;
}

/**
 * Fixed node width. Every node renders at exactly this width so the dagre pass
 * (which needs concrete box sizes to avoid overlap) can lay out against a known
 * value. Labels wrap to at most two lines; detail truncates — keeping height
 * bounded and predictable for the layout's height estimate.
 */
export const FLOW_NODE_WIDTH = 236;

interface FlowNodeData extends Record<string, unknown> {
  node: JourneyGraphNode;
  count?: number;
  metrics?: FlowNodeMetrics;
}

/** Per-kind visual config: icon + label + accent classes. */
const KIND_CONFIG: Record<
  JourneyGraphKind,
  { icon: LucideIcon; label: string; iconClass: string; ring: string }
> = {
  trigger: {
    icon: Zap,
    label: "Trigger",
    iconClass: "text-accent",
    ring: "rounded-full border-accent/40 bg-accent-tint",
  },
  email: {
    icon: Mail,
    label: "Email",
    iconClass: "text-accent",
    ring: "rounded-md border-accent/40 bg-gradient-to-b from-accent/[0.09] to-white/[0.02]",
  },
  inapp: {
    icon: Bell,
    label: "In-app",
    iconClass: "text-white/80",
    ring: "rounded-md",
  },
  connector: {
    icon: Plug,
    label: "Connector",
    iconClass: "text-white/70",
    ring: "rounded-md",
  },
  sleep: {
    icon: Clock,
    label: "Sleep",
    iconClass: "text-white/60",
    ring: "rounded-md bg-white/[0.04]",
  },
  schedule: {
    icon: CalendarClock,
    label: "Schedule",
    iconClass: "text-white/60",
    ring: "rounded-md bg-white/[0.04]",
  },
  wait: {
    icon: GitBranch,
    label: "Wait for event",
    iconClass: "text-accent",
    ring: "rounded-md border-accent/30",
  },
  branch: {
    icon: GitBranch,
    label: "Branch",
    iconClass: "text-white/80",
    ring: "rounded-md border-accent/30",
  },
  "trigger-event": {
    icon: Zap,
    label: "Emitted trigger",
    iconClass: "text-white/70",
    ring: "rounded-md",
  },
  checkpoint: {
    icon: Flag,
    label: "Checkpoint",
    iconClass: "text-white/60",
    ring: "rounded-[3px]",
  },
  exit: {
    icon: LogOut,
    label: "Exit",
    iconClass: "text-white/50",
    ring: "rounded-md",
  },
  end: {
    icon: Circle,
    label: "End",
    iconClass: "text-white/40",
    ring: "rounded-full",
  },
};

/** Rate as "62%" against a base, or an em-dash when the base is zero. */
function rate(part: number, base: number): string {
  if (base <= 0) return "—";
  return `${Math.round((part / base) * 100)}%`;
}

export const JourneyFlowNode = memo(function JourneyFlowNode({
  data,
  selected,
  sourcePosition,
  targetPosition,
}: NodeProps) {
  const { node, count, metrics } = data as FlowNodeData;
  const config = KIND_CONFIG[node.kind];
  const Icon = config.icon;
  // Handle placement follows the layout direction (set on the node by the
  // dagre pass): vertical layouts flow Top→Bottom, horizontal Left→Right.
  const targetPos = targetPosition ?? Position.Top;
  const sourcePos = sourcePosition ?? Position.Bottom;

  return (
    <div
      style={{ width: FLOW_NODE_WIDTH }}
      className={`relative border bg-white/[0.015] px-3 py-2 text-center transition-colors ${
        selected
          ? "border-accent/60 ring-1 ring-accent/40"
          : "border-hairline-faint hover:border-white/15"
      } ${config.ring}`}
    >
      {/* The trigger is the entry (no incoming) and `end` is terminal (no
          outgoing) — don't render a dangling handle dot for edges that can't
          exist. */}
      {node.kind !== "trigger" ? (
        <Handle
          type="target"
          position={targetPos}
          className="!h-2 !w-2 !border-0 !bg-white/30"
        />
      ) : null}
      {/* Live-count badge sits in the corner so it never offsets the centered
          label. */}
      {count !== undefined && count > 0 ? (
        <Badge
          variant="secondary"
          className="absolute top-1.5 right-1.5 text-[10px]"
        >
          {formatNumber(count)}
        </Badge>
      ) : null}
      <div className="flex items-center justify-center gap-1.5 text-[10px] text-white/40 uppercase tracking-wide">
        <Icon className={`h-3.5 w-3.5 ${config.iconClass}`} strokeWidth={1.5} />
        {config.label}
      </div>
      <div className="mt-1 line-clamp-2 text-sm leading-tight text-white/90">
        {node.label}
      </div>
      {node.detail ? (
        <div className="mt-0.5 truncate font-mono text-[11px] text-white/45">
          {node.detail}
        </div>
      ) : null}
      {metrics ? (
        <div className="mt-1.5 flex justify-center gap-3 border-t border-hairline-faint pt-1.5 text-[10px] text-white/55">
          <span>
            <span className="text-white/85">{formatNumber(metrics.sent)}</span>{" "}
            sent
          </span>
          <span>
            <span className="text-white/85">
              {rate(metrics.opened, metrics.sent)}
            </span>{" "}
            opened
          </span>
          <span>
            <span className="text-white/85">
              {rate(metrics.clicked, metrics.sent)}
            </span>{" "}
            clicked
          </span>
        </div>
      ) : null}
      {node.kind !== "end" ? (
        <Handle
          type="source"
          position={sourcePos}
          className="!h-2 !w-2 !border-0 !bg-white/30"
        />
      ) : null}
    </div>
  );
});

export const FLOW_NODE_TYPES = {
  journeyNode: JourneyFlowNode,
} as const;
