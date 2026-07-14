import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import {
  CircleDollarSign,
  Filter,
  GitBranch,
  Globe,
  type LucideIcon,
} from "lucide-react";
import type { FlowGraphNode, FlowNodeKind } from "@/lib/admin-api";
import { formatCurrency, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { NODE_HEIGHT, NODE_WIDTH } from "./tier-layout";

/**
 * A place in the growth machine — same crimzon card language as the journey
 * flow's nodes, sized to `NODE_WIDTH`/`NODE_HEIGHT` in `tier-layout.ts` (the
 * layout centres handles on those dimensions, so they must stay in lockstep —
 * hence the inline style rather than a duplicated Tailwind size).
 *
 * Four handles: horizontal (left/right) carries flow ACROSS tiers, vertical
 * (top/bottom) carries it WITHIN a tier. The layout picks which pair an edge
 * uses; both exist on every node so either routing works.
 *
 * Curated mode adds three overlays:
 * - the heat strip — a bar across the bottom edge, width = conversion rate;
 * - money — attributed revenue when the ledger credited this node, else the
 *   direct revenue that landed on it (never the sum: they double-count);
 * - the chips — "N stuck" (the thing an operator acts on) and "N live".
 */

export type SurfaceNodeData = { node: FlowGraphNode };
export type SurfaceRfNode = Node<SurfaceNodeData, "surface">;

const HANDLE_CLASS = "!h-1.5 !w-1.5 !border-0 !bg-white/25";

const KIND_ICON: Record<FlowNodeKind, LucideIcon> = {
  surface: Globe,
  journey: GitBranch,
  funnelStage: Filter,
  builtin: CircleDollarSign,
};

const KIND_LABEL: Record<FlowNodeKind, string> = {
  surface: "Surface",
  journey: "Journey",
  funnelStage: "Funnel stage",
  builtin: "Revenue",
};

/**
 * The money to show, and which kind it is. Attributed (the ledger's fractional
 * credit for conversions this node touched) wins when present — it's the causal
 * claim. Direct (money that landed AT the node) is the fallback. Adding them
 * would count one sale twice, so we never do.
 *
 * A multi-currency node shows its largest amount (the drill-down breaks it
 * out) — a 240px card cannot honestly render three currencies.
 */
function primaryMoney(node: FlowGraphNode) {
  const heat = node.heat;
  if (!heat) return null;
  const attributed = heat.attributedRevenue.length > 0;
  const pool = attributed ? heat.attributedRevenue : heat.directRevenue;
  // Currency tiebreak: two equal amounts must not flip the card between
  // "$500" and "€500" across polls.
  const top = [...pool].sort(
    (a, b) => b.amount - a.amount || a.currency.localeCompare(b.currency),
  )[0];
  if (!top) return null;
  return { ...top, attributed, currencies: pool.length };
}

export function SurfaceNode({ data, selected }: NodeProps<SurfaceRfNode>) {
  const { node } = data;
  const Icon = KIND_ICON[node.kind];
  const money = primaryMoney(node);
  const rate = node.heat?.conversionRate ?? null;
  const stuck = node.dwell?.stuckContacts ?? 0;

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md border bg-white/[0.015] px-3 py-2",
        "text-white/90 transition-colors",
        selected
          ? "border-accent"
          : "border-hairline-faint hover:border-white/15",
      )}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
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
        <Icon className="h-3 w-3 shrink-0 text-white/40" />
        <span className="eyebrow text-[11px] text-white/40">
          {KIND_LABEL[node.kind]}
        </span>
        {money ? (
          <span
            className="ml-auto shrink-0 font-mono text-[10px] text-white/55"
            title={`${money.attributed ? "Attributed" : "Direct"} revenue${
              money.currencies > 1 ? " (largest of several currencies)" : ""
            }`}
          >
            {formatCurrency(money.amount, money.currency, {
              maximumFractionDigits: 0,
            })}
          </span>
        ) : null}
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

      {stuck > 0 || node.live !== null || rate !== null ? (
        <div className="mt-1.5 flex items-center gap-1">
          {stuck > 0 ? (
            <span
              className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent"
              title={`Idle here for more than ${node.dwell?.thresholdHours ?? 48}h`}
            >
              {formatNumber(stuck)} stuck
            </span>
          ) : null}
          {node.live !== null ? (
            <span
              className="rounded bg-white/[0.07] px-1.5 py-0.5 text-[10px] font-medium text-white/60"
              title="Contacts enrolled in this journey right now"
            >
              {formatNumber(node.live)} live
            </span>
          ) : null}
          {rate !== null ? (
            <span className="ml-auto shrink-0 font-mono text-[10px] text-white/35">
              {(rate * 100).toFixed(0)}% conv
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Heat strip. Absent (not zero-width) when the rate is unmeasured — a
          hairline at 0% reads as "measured, nobody converted", which is a
          different and much worse claim than "not measured". */}
      {rate !== null ? (
        <div
          className="absolute bottom-0 left-0 h-[2px] bg-accent/70"
          style={{ width: `${Math.min(100, Math.max(0, rate * 100))}%` }}
          title={`${(rate * 100).toFixed(1)}% of the contacts here converted`}
        />
      ) : null}

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
