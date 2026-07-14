import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { Globe } from "lucide-react";
import type { FlowGraphNode } from "@/lib/admin-api";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * A place in the growth machine — same crimzon card language as the journey
 * flow's nodes, sized to `NODE_WIDTH`/`NODE_HEIGHT` in `tier-layout.ts` (the
 * layout centres handles on those dimensions, so they must stay in lockstep).
 *
 * Four handles: horizontal (left/right) carries flow ACROSS tiers, vertical
 * (top/bottom) carries it WITHIN a tier. The layout picks which pair an edge
 * uses; both exist on every node so either routing works.
 */

export type SurfaceNodeData = { node: FlowGraphNode };
export type SurfaceRfNode = Node<SurfaceNodeData, "surface">;

const HANDLE_CLASS = "!h-1.5 !w-1.5 !border-0 !bg-white/25";

export function SurfaceNode({ data, selected }: NodeProps<SurfaceRfNode>) {
  const { node } = data;
  return (
    <div
      className={cn(
        "h-[88px] w-[240px] rounded-md border bg-white/[0.015] px-3 py-2",
        "text-white/90 transition-colors",
        selected
          ? "border-accent"
          : "border-hairline-faint hover:border-white/15",
      )}
    >
      <Handle
        id="in-l"
        type="target"
        position={Position.Left}
        className={HANDLE_CLASS}
      />
      <Handle
        id="in-t"
        type="target"
        position={Position.Top}
        className={HANDLE_CLASS}
      />

      <div className="flex items-center gap-1.5">
        <Globe className="h-3 w-3 shrink-0 text-white/40" />
        <span className="eyebrow text-[11px] text-white/40">Surface</span>
      </div>
      <p
        className="mt-0.5 truncate text-[13px] font-medium leading-snug text-white/90"
        title={node.name}
      >
        {node.name}
      </p>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="font-display text-base leading-none text-white">
          {formatNumber(node.contacts)}
        </span>
        <span className="text-[11px] text-white/45">
          {node.contacts === 1 ? "contact" : "contacts"}
        </span>
        <span className="ml-auto font-mono text-[10px] text-white/35">
          {formatNumber(node.events)} events
        </span>
      </div>

      <Handle
        id="out-r"
        type="source"
        position={Position.Right}
        className={HANDLE_CLASS}
      />
      <Handle
        id="out-b"
        type="source"
        position={Position.Bottom}
        className={HANDLE_CLASS}
      />
    </div>
  );
}
