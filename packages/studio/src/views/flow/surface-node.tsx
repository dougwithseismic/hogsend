import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import {
  CircleDollarSign,
  Filter,
  GitBranch,
  Globe,
  Lock,
  type LucideIcon,
  Signal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FlowGraphNode, FlowNodeKind } from "@/lib/admin-api";
import { formatCurrency, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { nodeSize } from "./map-layout";
import { particleBus } from "./particle-bus";

/**
 * A place in the growth machine. Each KIND wears its own chrome so the map
 * reads at a glance instead of as thirty identical rectangles:
 *
 * - `surface`  — a browser mockup: traffic-light dots + an address pill (the
 *   surface id), page title + stats below. A website LOOKS like a website.
 * - `journey`  — an automation card: branch icon header with a breathing
 *   green dot while anyone is enrolled.
 * - `funnelStage` — a plain measured-step card.
 * - `builtin`  — the till: gold-framed, revenue as the hero stat.
 *
 * Sizes come from `nodeSize()` in `map-layout.ts` (dagre ranks with the same
 * dimensions, so they must stay in lockstep — hence the inline style rather
 * than a duplicated Tailwind size).
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

export type SurfaceNodeData = {
  node: FlowGraphNode;
  /** The operator's base-currency lens label (#496); null = lens off. */
  fx: { baseCurrency: string; asOf: string | null } | null;
};
export type SurfaceRfNode = Node<SurfaceNodeData, "surface">;

// Invisible: the map is read-only, so the join dots are noise — but the
// Handle elements must still EXIST (React Flow anchors edge endpoints to
// them), so they're hidden, not removed.
const HANDLE_CLASS = "!h-1.5 !w-1.5 !border-0 !bg-transparent !opacity-0";

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

/** Gold — money everywhere on the map rides this colour. */
const GOLD = "#f0b429";

/** The address-pill text: the surface's own id, sans node-namespace prefix. */
function surfaceSlug(id: string): string {
  return id.replace(/^surface:/, "");
}

/**
 * The money to show, and which kind it is. Attributed (the ledger's fractional
 * credit for conversions this node touched) wins when present — it's the causal
 * claim. Direct (money that landed AT the node) is the fallback. Adding them
 * would count one sale twice, so we never do.
 *
 * A multi-currency node shows its largest amount (the drill-down breaks it
 * out) — a card this size cannot honestly render three currencies.
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

/** Mirrors flow-edge's spawn gate — no flashes/ticks under reduced motion. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

interface MoneyTick {
  key: number;
  label: string;
}

/** Violet — the traffic-source tint, distinct from lanes, gold and crimzon. */
const SOURCE_VIOLET = "#a78bfa";

/** All four join points — every variant must render them (edge anchors). */
function NodeHandles() {
  return (
    <>
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
    </>
  );
}

export function SurfaceNode({ data, selected }: NodeProps<SurfaceRfNode>) {
  const { node, fx } = data;
  const Icon = KIND_ICON[node.kind];
  const size = nodeSize(node);
  const money = primaryMoney(node);
  const rate = node.heat?.conversionRate ?? null;
  const stuck = node.dwell?.stuckContacts ?? 0;
  const isBrowser = node.kind === "surface";
  const isTill = node.kind === "builtin";
  // The base-currency lens (#496) wins when it can serve: the SAME
  // attributed-beats-direct law as primaryMoney, converted into the
  // operator's reporting currency. Null (lens off / unconvertible) falls
  // back to the largest native currency.
  const baseMoney =
    fx && node.heat
      ? node.heat.attributedRevenue.length > 0
        ? node.heat.attributedRevenueBase
        : node.heat.directRevenueBase
      : null;

  // Money landing HERE rings the till: a gold flash on the card and a
  // floating "+$49.99" tick. LOCAL state fed by the particle bus (the same
  // decoupling as live edge pulses), so a sale re-renders exactly this card
  // and never disturbs the reconcile identity of anything else. The window
  // total in the card corner trues up on the next poll.
  const [flash, setFlash] = useState(false);
  const [ticks, setTicks] = useState<MoneyTick[]>([]);
  const tickKeyRef = useRef(0);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const unsubscribe = particleBus.subscribe(`node:${node.id}`, (payload) => {
      if (payload.value === null || payload.value <= 0) return;
      setFlash(true);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => setFlash(false), 900);
      tickKeyRef.current += 1;
      const amount = payload.currency
        ? formatCurrency(payload.value, payload.currency, {
            maximumFractionDigits: payload.value % 1 === 0 ? 0 : 2,
          })
        : formatNumber(payload.value);
      setTicks((prev) => [
        // Keep at most 3 concurrent ticks — a burst reads as a burst, not a
        // wall of text.
        ...prev.slice(-2),
        { key: tickKeyRef.current, label: `+${amount}` },
      ]);
    });
    return () => {
      unsubscribe();
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, [node.id]);

  // One money slot, whichever chrome hosts it: the base-currency lens beats
  // the largest native amount (same law as the drill-down).
  const moneySlot =
    baseMoney !== null && fx ? (
      <span
        className="ml-auto shrink-0 font-mono text-[10px] text-white/55"
        title={`≈ ${fx.baseCurrency} (operator base currency)${
          fx.asOf ? ` · rates as of ${fx.asOf}` : ""
        }`}
      >
        {formatCurrency(baseMoney, fx.baseCurrency, {
          maximumFractionDigits: 0,
        })}
      </span>
    ) : money ? (
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
    ) : null;

  if (node.display === "source") {
    // A traffic ORIGIN — an inlet, not a place contacts dwell. Slim chip in
    // its own violet register so paid/referral arrivals read instantly apart
    // from the product surfaces they feed.
    return (
      <div
        className={cn(
          "relative flex flex-col justify-center overflow-hidden rounded-md",
          "border bg-[#0e0b16] px-3 py-2 text-white/90 transition-colors",
          selected
            ? "border-accent"
            : "border-[#a78bfa]/25 hover:border-[#a78bfa]/45",
        )}
        style={{ width: size.width, height: size.height }}
      >
        <NodeHandles />
        <div className="flex items-center gap-1.5">
          <Signal className="h-3 w-3 shrink-0 text-[#a78bfa]/80" />
          <span
            className="eyebrow text-[10px]"
            style={{ color: `${SOURCE_VIOLET}99` }}
          >
            Source
          </span>
          {rate !== null ? (
            <span className="ml-auto shrink-0 font-mono text-[10px] text-white/35">
              {(rate * 100).toFixed(0)}% conv
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 flex items-baseline gap-1.5">
          <p
            className="truncate text-[13px] font-medium leading-snug"
            title={node.name}
          >
            {node.name}
          </p>
          <span className="ml-auto shrink-0 font-mono text-[11px] text-white/45">
            {formatNumber(node.contacts)}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative flex flex-col overflow-hidden rounded-lg border",
        "text-white/90 transition-colors",
        // OPAQUE backgrounds — rails pass UNDER cards, so any alpha here lets
        // the glow bleed through the card face. Raised near-black, with the
        // till's gold folded into the solid colour rather than layered on.
        isTill ? "bg-[#100b04]" : "bg-[#0d0909]",
        flash && "flow-node-flash",
        selected
          ? "border-accent"
          : isTill
            ? "border-[#f0b429]/25 hover:border-[#f0b429]/45"
            : "border-hairline-faint hover:border-white/20",
      )}
      style={{ width: size.width, height: size.height }}
    >
      <NodeHandles />

      {isBrowser ? (
        // Browser chrome: traffic lights + an address pill. The pill carries
        // the surface id — the closest thing the wire has to a URL — and the
        // kind·tier eyebrow moves into its tooltip.
        <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] bg-white/[0.04] px-2.5 py-1.5">
          <span className="flex shrink-0 gap-1" aria-hidden="true">
            <span className="h-[7px] w-[7px] rounded-full bg-[#ff5f57]/80" />
            <span className="h-[7px] w-[7px] rounded-full bg-[#febc2e]/80" />
            <span className="h-[7px] w-[7px] rounded-full bg-[#28c840]/80" />
          </span>
          <span
            className="flex h-[18px] min-w-0 flex-1 items-center gap-1 rounded bg-black/40 px-1.5"
            title={`${KIND_LABEL[node.kind]} · ${node.tier}`}
          >
            <Lock className="h-2.5 w-2.5 shrink-0 text-white/25" />
            <span className="truncate font-mono text-[10px] leading-none text-white/45">
              {surfaceSlug(node.id)}
            </span>
          </span>
          {moneySlot}
        </div>
      ) : (
        <div
          className={cn(
            "flex shrink-0 items-center gap-1.5 border-b px-2.5 py-1.5",
            isTill
              ? "border-[#f0b429]/15 bg-[#f0b429]/[0.08]"
              : "border-white/[0.06] bg-white/[0.03]",
          )}
        >
          <Icon
            className={cn(
              "h-3 w-3 shrink-0",
              isTill ? "text-[#f0b429]/70" : "text-white/40",
            )}
          />
          <span className="eyebrow truncate text-[11px] text-white/40">
            {/* Tier rides the eyebrow now that layout is graph-first — it
                names the lifecycle stage without dictating a column. The till
                skips it: "Revenue · revenue" says the word twice. */}
            {isTill
              ? KIND_LABEL[node.kind]
              : `${KIND_LABEL[node.kind]} · ${node.tier}`}
          </span>
          {node.kind === "journey" && (node.live ?? 0) > 0 ? (
            <span
              className="relative flex h-1.5 w-1.5 shrink-0"
              title="Contacts enrolled right now"
            >
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400/90" />
            </span>
          ) : null}
          {moneySlot}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col justify-center px-3 py-1.5">
        <p
          className="truncate text-[13px] font-medium leading-snug text-white/90"
          title={node.name}
        >
          {node.name}
        </p>

        {isTill && (baseMoney !== null || money) ? (
          // The revenue node is a TILL: cumulative value is the hero stat, the
          // contact count demotes to the corner. The base-currency lens (#496)
          // rules the total when it can serve — one honest number in the
          // operator's reporting currency; else the largest native currency.
          <div className="mt-1 flex items-baseline gap-1.5">
            <span
              className="font-display text-base leading-none"
              style={{ color: GOLD }}
            >
              {baseMoney !== null && fx
                ? formatCurrency(baseMoney, fx.baseCurrency, {
                    maximumFractionDigits: 0,
                  })
                : money
                  ? formatCurrency(money.amount, money.currency, {
                      maximumFractionDigits: 0,
                    })
                  : null}
            </span>
            <span className="text-[11px] text-white/45">
              {baseMoney !== null && fx
                ? `≈ ${fx.baseCurrency} this window`
                : `this window${money && money.currencies > 1 ? ` +${money.currencies - 1}` : ""}`}
            </span>
            <span className="ml-auto font-mono text-[10px] text-white/35">
              {formatNumber(node.contacts)}{" "}
              {node.contacts === 1 ? "contact" : "contacts"}
            </span>
          </div>
        ) : (
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
        )}

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
      </div>

      {/* Floating money ticks — one per landed sale, self-removing. */}
      {ticks.length > 0 ? (
        <div className="pointer-events-none absolute right-2 top-8">
          {ticks.map((tick) => (
            <div
              key={tick.key}
              className="flow-money-tick text-right font-mono text-[11px] font-medium text-[#f0b429]"
              onAnimationEnd={() =>
                setTicks((prev) => prev.filter((t) => t.key !== tick.key))
              }
            >
              {tick.label}
            </div>
          ))}
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
    </div>
  );
}
