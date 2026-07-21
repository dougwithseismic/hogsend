"use client";

import {
  ArrowDown,
  ArrowUp,
  Building2,
  ChevronDown,
  CreditCard,
  Globe,
  Heart,
  Info,
  LayoutGrid,
  type LucideIcon,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Star,
  Users,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { CopyButton } from "@/components/ds/copy-button";
import { cn } from "@/lib/cn";
import {
  ProductCard,
  ProductCardFooter,
  ProductCardHeader,
  ProductLabel,
  ProductTag,
} from "./product-card";

/**
 * Contact groups.
 *
 * LEFT — the RESULT: a rich Acme account dashboard (identity, KPI stats, a
 * usage/health panel beside an activity chart, properties + tags, and a member
 * roster) the way Studio reads a group back. Built from the shared product-card
 * kit — near-black surface, hairline dividers, one crimzon accent (no rainbow).
 * RIGHT — the CODE: the real `@hogsend/js` / `@hogsend/client` calls that write
 * and read it, tabbed with a copy button, inside the shared card kit.
 *
 * `CodeHighlight` is an async RSC, so the highlighted snippets are rendered in
 * the page and handed in as `code` nodes.
 */

/* -- shared tokens (aligned to the product-card kit) ---------------------- */
/** Crimzon text-on-dark, the kit's soft accent (avatars, deltas, values). */
const ACCENT = "text-[#f8a08f]";
const BAR_GRADIENT = "linear-gradient(90deg, #f64838 0%, #ff9a6c 100%)";
/** Inner sub-panel: hairline border on a barely-lit fill, kit dividers. */
const PANEL = "rounded-lg border border-white/[0.08] bg-white/[0.02]";

/* -- members -------------------------------------------------------------- */
interface Member {
  name: string;
  email: string;
  role: "admin" | "member";
  events: string;
  delta: { dir: "up" | "down"; value: string };
  lastSeen: string;
}

const MEMBERS: Member[] = [
  {
    name: "Bill Chen",
    email: "bill@acme.com",
    role: "admin",
    events: "1,240",
    delta: { dir: "up", value: "18%" },
    lastSeen: "2h ago",
  },
  {
    name: "Derek Vaughn",
    email: "derek@acme.com",
    role: "member",
    events: "430",
    delta: { dir: "up", value: "6%" },
    lastSeen: "1d ago",
  },
  {
    name: "Bob Portis",
    email: "bob@acme.com",
    role: "member",
    events: "210",
    delta: { dir: "down", value: "4%" },
    lastSeen: "3d ago",
  },
];

/* -- activity chart data (May run, ~1.24k events by the 17th) ------------- */
const ACTIVITY = [
  340, 300, 450, 540, 500, 660, 740, 690, 830, 760, 900, 1030, 970, 1150, 1290,
  1450, 1330, 1240,
];
const CHART_MAX = 1500;
const CHART_PTS = ACTIVITY.map((v, i) => ({
  x: (i / (ACTIVITY.length - 1)) * 100,
  y: 100 - (v / CHART_MAX) * 100,
}));
const CHART_LINE = CHART_PTS.map(
  (p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`,
).join(" ");
const CHART_AREA = `${CHART_LINE} L100,100 L0,100 Z`;

/* -- small parts ---------------------------------------------------------- */

/** Directional trend chip — crimzon for a rise, muted for a dip. */
function Delta({ dir, value }: { dir: "up" | "down"; value: string }) {
  const up = dir === "up";
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 font-medium text-[12px] tabular-nums",
        up ? ACCENT : "text-white/40",
      )}
    >
      <Icon className="size-3" strokeWidth={2.75} />
      {value}
    </span>
  );
}

/** One KPI tile in the stats strip. */
function StatTile({
  icon: Icon,
  label,
  value,
  delta,
  caption,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  delta?: ReactNode;
  caption: string;
}) {
  return (
    <div className="px-4 py-3.5">
      <div className="flex items-center gap-1.5 text-white/50">
        <Icon className="size-3.5 shrink-0" strokeWidth={1.75} />
        <span className="text-[12px] tracking-[-0.01em]">{label}</span>
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="font-semibold text-[22px] text-white leading-none tracking-[-0.02em]">
          {value}
        </span>
        {delta}
      </div>
      <p className="mt-1.5 text-[11px] text-white/35">{caption}</p>
    </div>
  );
}

/** Labeled usage/health bar with a leading icon and warm gradient fill. */
function UsageBar({
  icon: Icon,
  label,
  value,
  valueMuted,
  fraction,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  valueMuted?: string;
  fraction: number;
}) {
  return (
    <div>
      <div className="flex items-center gap-2.5">
        <Icon className="size-3.5 shrink-0 text-white/45" strokeWidth={1.75} />
        <span className="text-[12.5px] text-white/70 tracking-[-0.01em]">
          {label}
        </span>
        <span className="ml-auto font-mono text-[11.5px] tabular-nums">
          <span className="text-white/75">{value}</span>
          {valueMuted ? (
            <span className="text-white/35">{valueMuted}</span>
          ) : null}
        </span>
      </div>
      <div className="mt-2 ml-6 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className="h-full rounded-full"
          style={{
            width: `${Math.round(fraction * 100)}%`,
            background: BAR_GRADIENT,
          }}
        />
      </div>
    </div>
  );
}

/** One property row: icon + key on the left, value on the right. */
function PropRow({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-3.5 shrink-0 text-white/40" strokeWidth={1.75} />
      <span className="text-[12px] text-white/55">{label}</span>
      <span className="ml-auto truncate font-mono text-[12px] text-white/75">
        {value}
      </span>
    </div>
  );
}

/** A tag chip. `tone` picks the accent; `add` renders the trailing +. */
function Chip({
  children,
  tone = "neutral",
  add = false,
}: {
  children?: ReactNode;
  tone?: "crimzon" | "neutral";
  add?: boolean;
}) {
  const tones: Record<string, string> = {
    crimzon: "border-[#f64838]/30 bg-[#f64838]/[0.08] text-[#f8a08f]",
    neutral: "border-white/12 bg-white/[0.03] text-white/55",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-[5px] border px-2 py-1 font-mono text-[11px]",
        tones[tone],
      )}
    >
      {add ? <Plus className="size-3" strokeWidth={2} /> : children}
    </span>
  );
}

function RoleBadge({ role }: { role: "admin" | "member" }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-[5px] border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em]",
        role === "admin"
          ? "border-[#f64838]/40 bg-[#f64838]/[0.08] text-[#f8a08f]"
          : "border-white/12 bg-white/[0.03] text-white/50",
      )}
    >
      {role}
    </span>
  );
}

/** One member roster row. Avatar tint tracks role, not a per-person color. */
function MemberRow({ m }: { m: Member }) {
  return (
    <tr className="border-white/[0.08] border-t transition-colors hover:bg-white/[0.02]">
      <td className="py-2.5 pr-2 pl-4">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-full font-semibold text-[11px]",
              m.role === "admin"
                ? "bg-[#f64838]/20 text-[#f8a08f]"
                : "bg-white/[0.08] text-white/70",
            )}
          >
            {m.name.slice(0, 1)}
          </span>
          <span className="truncate font-medium text-[13px] text-white tracking-[-0.02em]">
            {m.name}
          </span>
        </div>
      </td>
      <td className="px-2 py-2.5 font-mono text-[11.5px] text-white/40">
        {m.email}
      </td>
      <td className="px-2 py-2.5">
        <span className="flex items-center gap-1.5">
          <span className="font-mono text-[12px] text-white/75 tabular-nums">
            {m.events}
          </span>
          <Delta dir={m.delta.dir} value={m.delta.value} />
        </span>
      </td>
      <td className="px-2 py-2.5 font-mono text-[11.5px] text-white/40">
        {m.lastSeen}
      </td>
      <td className="px-2 py-2.5">
        <RoleBadge role={m.role} />
      </td>
      <td className="py-2.5 pr-3 pl-1 text-right">
        <button
          type="button"
          aria-label={`Actions for ${m.name}`}
          className="text-white/30 transition-colors hover:text-white/70"
        >
          <MoreHorizontal className="size-4" strokeWidth={2} />
        </button>
      </td>
    </tr>
  );
}

/* -- code column ---------------------------------------------------------- */
type CodeTab = "browser" | "server";
const CODE_TABS: Array<{ key: CodeTab; filename: string }> = [
  { key: "browser", filename: "browser — @hogsend/js" },
  { key: "server", filename: "server — @hogsend/client" },
];

type GroupAccountSwitcherProps = {
  code: Record<CodeTab, ReactNode>;
  raw: Record<CodeTab, string>;
};

export function GroupAccountSwitcher({ code, raw }: GroupAccountSwitcherProps) {
  const [tab, setTab] = useState<CodeTab>("server");

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      {/* LEFT — the account dashboard, in the product-card kit, hero-lit. */}
      <div className="relative">
        {/* Crimzon aura behind the card — ambient hero glow, on-palette. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -inset-4"
          style={{
            background:
              "radial-gradient(55% 45% at 26% 4%, rgba(246,72,56,0.20), transparent 70%), radial-gradient(45% 40% at 55% 102%, rgba(246,72,56,0.16), transparent 72%)",
            filter: "blur(22px)",
          }}
        />
        <ProductCard className="relative border-[#2c1e24] shadow-[0_24px_70px_-32px_rgba(246,72,56,0.5)]">
          {/* Warm wash across the top of the card. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-44"
            style={{
              background:
                "radial-gradient(85% 130% at 2% 0%, rgba(246,72,56,0.14) 0%, transparent 62%)",
            }}
          />

          {/* Identity header. */}
          <div className="relative flex items-center gap-3.5 border-white/[0.08] border-b px-4 py-3.5">
            <span
              aria-hidden="true"
              className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-[#f64838]/25 bg-[#f64838]/15 font-semibold text-[20px] text-[#f8a08f]"
            >
              A
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="truncate font-semibold text-[19px] text-white tracking-[-0.02em]">
                  Acme Inc
                </p>
                <ProductTag tone="crimzon" pulse>
                  pro
                </ProductTag>
              </div>
              <code className="mt-0.5 block truncate font-mono text-[11.5px] text-white/40">
                Company · acme.com · ID: grp_8f4a72e9
              </code>
            </div>
            <button
              type="button"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[13px] text-white/80 transition-colors hover:bg-white/[0.06]"
            >
              Actions
              <ChevronDown className="size-3.5 text-white/50" strokeWidth={2} />
            </button>
          </div>

          {/* Body — a stack of framed sub-panels. */}
          <div className="relative flex flex-col gap-3 p-3">
            {/* KPI stats. */}
            <div
              className={cn(
                PANEL,
                "grid grid-cols-4 divide-x divide-white/[0.08]",
              )}
            >
              <StatTile
                icon={Users}
                label="Members"
                value="3"
                delta={<Delta dir="up" value="50%" />}
                caption="vs last 30 days"
              />
              <StatTile
                icon={CreditCard}
                label="MRR"
                value="$4.2k"
                delta={<Delta dir="up" value="8.3%" />}
                caption="vs last 30 days"
              />
              <StatTile
                icon={Users}
                label="Customer since"
                value="Mar '25"
                caption="32 days"
              />
              {/* Health score — ring gauge. */}
              <div className="px-4 py-3.5">
                <div className="flex items-center gap-1.5 text-white/50">
                  <Info className="size-3.5 shrink-0" strokeWidth={1.75} />
                  <span className="text-[12px] tracking-[-0.01em]">
                    Health score
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-2.5">
                  <div
                    className="relative size-11 shrink-0 rounded-full"
                    style={{
                      background:
                        "conic-gradient(#f64838 0% 92%, rgba(255,255,255,0.08) 92% 100%)",
                    }}
                  >
                    <div className="absolute inset-[3px] flex items-center justify-center rounded-full bg-[#101014]">
                      <span className="font-semibold text-[13px] text-white tabular-nums">
                        92
                      </span>
                    </div>
                  </div>
                  <div>
                    <p className="font-medium text-[13px] text-white/85 leading-tight">
                      Excellent
                    </p>
                    <p className="mt-0.5 flex items-center gap-0.5 text-[11px] text-[#f8a08f]">
                      <ArrowUp className="size-2.5" strokeWidth={2.75} />6 pts
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Usage & health | activity chart. */}
            <div
              className={cn(
                PANEL,
                "grid grid-cols-2 divide-x divide-white/[0.08]",
              )}
            >
              <div className="p-4">
                <ProductLabel>Usage &amp; Health</ProductLabel>
                <div className="mt-4 flex flex-col gap-3.5">
                  <UsageBar
                    icon={Users}
                    label="Seats used"
                    value="42"
                    valueMuted=" / 50"
                    fraction={0.84}
                  />
                  <UsageBar
                    icon={Star}
                    label="Feature adoption"
                    value="78%"
                    fraction={0.78}
                  />
                  <UsageBar
                    icon={Heart}
                    label="Account health"
                    value="92%"
                    fraction={0.92}
                  />
                  <UsageBar
                    icon={MessageSquare}
                    label="Team engagement"
                    value="68%"
                    fraction={0.68}
                  />
                </div>
              </div>

              <div className="p-4">
                <div className="flex items-center justify-between gap-2">
                  <ProductLabel>Activity (events)</ProductLabel>
                  <span className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] text-white/60">
                    Last 30 days
                    <ChevronDown
                      className="size-3 text-white/40"
                      strokeWidth={2}
                    />
                  </span>
                </div>
                <div className="mt-4 flex gap-2">
                  <div className="flex h-[132px] flex-col justify-between py-px text-right font-mono text-[10px] text-white/30">
                    <span>1.5k</span>
                    <span>1k</span>
                    <span>500</span>
                    <span>0</span>
                  </div>
                  <div className="relative min-w-0 flex-1">
                    <svg
                      viewBox="0 0 100 100"
                      preserveAspectRatio="none"
                      className="h-[132px] w-full"
                      aria-hidden="true"
                    >
                      <title>Activity chart</title>
                      <defs>
                        <linearGradient
                          id="acme-area"
                          x1="0"
                          y1="0"
                          x2="0"
                          y2="1"
                        >
                          <stop
                            offset="0%"
                            stopColor="#f64838"
                            stopOpacity="0.35"
                          />
                          <stop
                            offset="100%"
                            stopColor="#f64838"
                            stopOpacity="0"
                          />
                        </linearGradient>
                        <linearGradient
                          id="acme-line"
                          x1="0"
                          y1="0"
                          x2="1"
                          y2="0"
                        >
                          <stop offset="0%" stopColor="#f64838" />
                          <stop offset="100%" stopColor="#ff9a6c" />
                        </linearGradient>
                      </defs>
                      {[0, 33.33, 66.66, 100].map((y) => (
                        <line
                          key={y}
                          x1="0"
                          y1={y}
                          x2="100"
                          y2={y}
                          stroke="rgba(255,255,255,0.05)"
                          strokeWidth="0.5"
                          vectorEffect="non-scaling-stroke"
                        />
                      ))}
                      <path d={CHART_AREA} fill="url(#acme-area)" />
                      <path
                        d={CHART_LINE}
                        fill="none"
                        stroke="url(#acme-line)"
                        strokeWidth="1.75"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                      />
                    </svg>

                    {/* End-of-series dots + callout. */}
                    {CHART_PTS.slice(-2).map((p) => (
                      <span
                        key={p.x}
                        className="absolute size-2 rounded-full border-2 border-[#101014] bg-white"
                        style={{
                          left: `${p.x}%`,
                          top: `${p.y}%`,
                          transform: "translate(-50%, -50%)",
                        }}
                      />
                    ))}
                    <span
                      className="absolute right-0 rounded-md border border-white/15 bg-[#15151c] px-1.5 py-0.5 font-mono text-[11px] text-white tabular-nums shadow-lg"
                      style={{
                        top: `${CHART_PTS[CHART_PTS.length - 1].y}%`,
                        transform: "translateY(-50%)",
                      }}
                    >
                      1,240
                    </span>
                  </div>
                </div>
                <div className="mt-2 flex justify-between pl-9 font-mono text-[10px] text-white/30">
                  <span>Apr 19</span>
                  <span>Apr 26</span>
                  <span>May 3</span>
                  <span>May 10</span>
                  <span>May 17</span>
                </div>
              </div>
            </div>

            {/* Properties | tags. */}
            <div className="grid grid-cols-2 gap-3">
              <div className={cn(PANEL, "p-4")}>
                <ProductLabel>Properties</ProductLabel>
                <div className="mt-3 grid grid-cols-2">
                  <div className="flex flex-col gap-3 pr-4">
                    <PropRow icon={LayoutGrid} label="Plan" value="pro" />
                    <PropRow icon={Users} label="Seats" value="42" />
                  </div>
                  <div className="flex flex-col gap-3 border-white/[0.08] border-l pl-4">
                    <PropRow
                      icon={Building2}
                      label="Industry"
                      value="Developer tools"
                    />
                    <PropRow icon={Globe} label="Region" value="us-east-1" />
                  </div>
                </div>
              </div>

              <div className={cn(PANEL, "p-4")}>
                <ProductLabel>Tags</ProductLabel>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Chip tone="crimzon">production</Chip>
                  <Chip tone="neutral">high-engagement</Chip>
                  <Chip tone="neutral">beta-access</Chip>
                  <Chip tone="neutral" add />
                </div>
              </div>
            </div>

            {/* Members roster. */}
            <div className={cn(PANEL, "overflow-hidden")}>
              <div className="px-4 pt-3.5 pb-1">
                <ProductLabel>Members (3)</ProductLabel>
              </div>
              <table className="w-full border-collapse">
                <thead>
                  <tr className="text-left">
                    <th className="pb-1.5 pl-4 font-mono text-[9.5px] text-white/30 uppercase tracking-[0.06em]">
                      Member
                    </th>
                    <th className="px-2 pb-1.5 font-mono text-[9.5px] text-white/30 uppercase tracking-[0.06em]">
                      Email
                    </th>
                    <th className="px-2 pb-1.5 font-mono text-[9.5px] text-white/30 uppercase tracking-[0.06em]">
                      Events (30d)
                    </th>
                    <th className="px-2 pb-1.5 font-mono text-[9.5px] text-white/30 uppercase tracking-[0.06em]">
                      Last seen
                    </th>
                    <th className="px-2 pb-1.5 font-mono text-[9.5px] text-white/30 uppercase tracking-[0.06em]">
                      Role
                    </th>
                    <th className="pb-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {MEMBERS.map((m) => (
                    <MemberRow key={m.email} m={m} />
                  ))}
                </tbody>
              </table>
              <Link
                href="/articles/hogsend-0-50-the-big-one"
                className="flex items-center justify-center gap-1.5 border-white/[0.08] border-t py-2.5 text-[12px] text-white/50 transition-colors hover:text-white/80"
              >
                View all members
                <span aria-hidden="true">→</span>
              </Link>
            </div>
          </div>
        </ProductCard>
      </div>

      {/* RIGHT — the real code, in the same card. */}
      <ProductCard>
        <ProductCardHeader
          title="acme.com"
          tag={<ProductTag>company</ProductTag>}
          description="One (type, key) is the account. The browser associates events; the server writes properties and members."
        />

        <div className="flex items-center border-white/[0.08] border-b">
          <div
            role="tablist"
            aria-label="Where the group is written"
            className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {CODE_TABS.map((t) => {
              const isActive = t.key === tab;
              return (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setTab(t.key)}
                  className={cn(
                    "shrink-0 whitespace-nowrap border-b-2 px-2.5 py-2.5 font-mono text-[11px] tracking-wide outline-none transition-colors",
                    isActive
                      ? "border-[#f64838] text-white/80"
                      : "border-transparent text-white/40 hover:text-white/70",
                  )}
                >
                  {t.filename}
                </button>
              );
            })}
          </div>
          <span className="shrink-0 border-white/[0.06] border-l px-2">
            <CopyButton value={raw[tab]} />
          </span>
        </div>

        <div className="ps-code max-h-[300px] overflow-auto px-4 py-3.5 text-[12.5px]">
          {code[tab]}
        </div>

        <ProductCardFooter>
          <ProductLabel className="mb-1.5">
            {tab === "browser"
              ? "publishable — associate only"
              : "secret — writes properties"}
          </ProductLabel>
          <p className="text-[12px] text-white/50 leading-[1.5]">
            {tab === "browser"
              ? "A pk_ key can attach a contact's events to the account, never write its properties."
              : "Group properties and memberships are secret-key writes, enforced at the route."}
          </p>
        </ProductCardFooter>
      </ProductCard>

      <div className="flex flex-wrap items-center justify-between gap-3 lg:col-span-2">
        <p className="max-w-[640px] text-white/55 text-sm tracking-[-0.02em]">
          Journeys are person-scoped today — group-level journeys are a later
          phase, not a fine-print surprise.
        </p>
        <Link
          href="/articles/hogsend-0-50-the-big-one"
          className="font-medium text-white text-sm tracking-[-0.025em] hover:opacity-70"
        >
          Read the 0.50 write-up →
        </Link>
      </div>
    </div>
  );
}
