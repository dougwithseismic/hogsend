"use client";

import Link from "next/link";
import { type ReactNode, useState } from "react";
import { CopyButton } from "@/components/ds/copy-button";
import { cn } from "@/lib/cn";
import {
  ProductCard,
  ProductCardFooter,
  ProductCardHeader,
  ProductCardSection,
  ProductLabel,
  ProductStat,
  ProductTag,
} from "./product-card";

/**
 * Contact groups, built from the same product-surface kit as the feature-flags
 * and impact sections (ProductCard + its header/section/stat/footer
 * primitives), so it reads as one system rather than a new card style.
 *
 * LEFT — the RESULT: an Acme account profile card (identity, stats,
 * properties, members) the way Studio reads a group back.
 * RIGHT — the CODE: the real `@hogsend/js` / `@hogsend/client` calls that
 * write and read it, tabbed with a copy button, inside the same card kit.
 *
 * `CodeHighlight` is an async RSC, so the highlighted snippets are rendered in
 * the page and handed in as `code` nodes.
 */

interface Member {
  name: string;
  email: string;
  role: "admin" | "member";
  tint: string;
  events: string;
  sessions: string;
  lastSeen: string;
  joined: string;
  /** 0–1 engagement, drives the popover meter. */
  health: number;
}

const MEMBERS: Member[] = [
  {
    name: "Bill Chen",
    email: "bill@acme.com",
    role: "admin",
    tint: "#f64838",
    events: "1,240",
    sessions: "86",
    lastSeen: "2h ago",
    joined: "Mar 2025",
    health: 0.94,
  },
  {
    name: "Derek Vaughn",
    email: "derek@acme.com",
    role: "member",
    tint: "#c98bff",
    events: "430",
    sessions: "38",
    lastSeen: "1d ago",
    joined: "Apr 2025",
    health: 0.71,
  },
  {
    name: "Bob Portis",
    email: "bob@acme.com",
    role: "member",
    tint: "#ff9a6c",
    events: "210",
    sessions: "15",
    lastSeen: "3d ago",
    joined: "Jun 2025",
    health: 0.52,
  },
];

/** Labeled horizontal usage bar with a warm gradient fill. */
function UsageBar({
  label,
  detail,
  fraction,
}: {
  label: string;
  detail: string;
  fraction: number;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] text-white/55 tracking-[-0.01em]">
          {label}
        </span>
        <span className="font-mono text-[11px] text-white/70 tabular-nums">
          {detail}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className="h-full rounded-full"
          style={{
            width: `${Math.round(fraction * 100)}%`,
            background: "linear-gradient(90deg, #f64838 0%, #ff9a6c 100%)",
          }}
        />
      </div>
    </div>
  );
}

const PROPERTIES: Array<[string, string]> = [
  ["plan", '"pro"'],
  ["seats", "42"],
  ["industry", '"Developer tools"'],
  ["region", '"us-east-1"'],
];

type CodeTab = "browser" | "server";
const CODE_TABS: Array<{ key: CodeTab; filename: string }> = [
  { key: "browser", filename: "browser — @hogsend/js" },
  { key: "server", filename: "server — @hogsend/client" },
];

/** One member table row + the stat-card popover that appears on hover. */
function MemberRow({ m }: { m: Member }) {
  return (
    <tr className="group border-white/[0.05] border-t transition-colors hover:bg-white/[0.03]">
      <td className="relative py-2 pr-2 pl-2.5">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="flex size-6 shrink-0 items-center justify-center rounded-full font-medium text-[10px] text-white"
            style={{ backgroundColor: m.tint }}
          >
            {m.name.slice(0, 1)}
          </span>
          <span className="min-w-0">
            <span className="block truncate font-medium text-[12.5px] text-white leading-tight tracking-[-0.02em]">
              {m.name}
            </span>
            <span className="block truncate font-mono text-[10.5px] text-white/35 leading-tight">
              {m.email}
            </span>
          </span>
        </div>

        {/* Hover popover — the member's individual stat card. */}
        <div className="pointer-events-none absolute bottom-[calc(100%-8px)] left-2 z-30 w-[248px] scale-95 opacity-0 transition-all duration-150 group-hover:scale-100 group-hover:opacity-100">
          <div className="overflow-hidden rounded-lg border border-[#1c1d22] bg-[#0c0c10] shadow-[0_20px_50px_-12px_rgba(0,0,0,0.85)]">
            <div
              aria-hidden="true"
              className="h-1"
              style={{
                background: `linear-gradient(90deg, ${m.tint} 0%, transparent 100%)`,
              }}
            />
            <div className="flex items-center gap-2.5 px-3.5 pt-3">
              <span
                aria-hidden="true"
                className="flex size-8 shrink-0 items-center justify-center rounded-full font-medium text-[12px] text-white"
                style={{ backgroundColor: m.tint }}
              >
                {m.name.slice(0, 1)}
              </span>
              <div className="min-w-0">
                <p className="truncate font-medium text-[13px] text-white leading-tight">
                  {m.name}
                </p>
                <p className="truncate font-mono text-[10.5px] text-white/40 leading-tight">
                  {m.role} · joined {m.joined}
                </p>
              </div>
            </div>
            <dl className="mt-3 grid grid-cols-3 divide-x divide-white/[0.06] border-white/[0.06] border-t">
              {[
                ["events", m.events],
                ["sessions", m.sessions],
                ["last seen", m.lastSeen],
              ].map(([k, v]) => (
                <div key={k} className="px-2 py-2.5 text-center">
                  <dt className="font-mono text-[9px] text-white/35 uppercase tracking-[0.05em]">
                    {k}
                  </dt>
                  <dd className="mt-0.5 font-medium text-[12px] text-white tabular-nums">
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="border-white/[0.06] border-t px-3.5 py-3">
              <UsageBar
                label="Engagement"
                detail={`${Math.round(m.health * 100)}%`}
                fraction={m.health}
              />
            </div>
          </div>
        </div>
      </td>
      <td className="px-2 py-2 text-right font-mono text-[11.5px] text-white/60 tabular-nums">
        {m.events}
      </td>
      <td className="px-2 py-2 text-right font-mono text-[11px] text-white/35">
        {m.lastSeen}
      </td>
      <td className="py-2 pr-2.5 pl-2 text-right">
        <ProductTag tone={m.role === "admin" ? "crimzon" : "neutral"}>
          {m.role}
        </ProductTag>
      </td>
    </tr>
  );
}

type GroupAccountSwitcherProps = {
  code: Record<CodeTab, ReactNode>;
  raw: Record<CodeTab, string>;
};

export function GroupAccountSwitcher({ code, raw }: GroupAccountSwitcherProps) {
  const [tab, setTab] = useState<CodeTab>("server");

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[1fr_420px]">
      {/* LEFT — the account profile, in the product-card kit. */}
      <ProductCard>
        {/* Identity — monogram + name; pro badge pinned top-right over a
            warm gradient wash. */}
        <div className="relative overflow-hidden border-white/[0.08] border-b px-4 py-3.5">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "linear-gradient(105deg, rgba(246,72,56,0.14) 0%, rgba(201,139,255,0.08) 45%, transparent 72%)",
            }}
          />
          <div className="relative flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] font-semibold text-[15px] text-white"
            >
              A
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-[15px] text-white tracking-[-0.02em]">
                Acme Inc
              </p>
              <code className="font-mono text-[11.5px] text-white/40">
                company · acme.com
              </code>
            </div>
          </div>
          {/* pinned top-right */}
          <div className="absolute top-3 right-3">
            <ProductTag tone="crimzon" pulse>
              pro
            </ProductTag>
          </div>
        </div>

        {/* Stats — the ProductStat primitive, three across. */}
        <ProductCardSection className="grid grid-cols-3 gap-4 border-white/[0.08] border-b">
          <ProductStat value="3" label="Members" />
          <ProductStat value="$4.2k" label="MRR" />
          <ProductStat value="Mar '25" label="Customer since" />
        </ProductCardSection>

        {/* Usage — labeled horizontal gradient bars. */}
        <ProductCardSection className="border-white/[0.08] border-b">
          <ProductLabel className="mb-3">Usage</ProductLabel>
          <div className="flex flex-col gap-3">
            <UsageBar label="Seats used" detail="42 / 50" fraction={0.84} />
            <UsageBar label="Feature adoption" detail="78%" fraction={0.78} />
            <UsageBar label="Account health" detail="92%" fraction={0.92} />
          </div>
        </ProductCardSection>

        {/* Properties — mono key/value rows. */}
        <ProductCardSection className="border-white/[0.08] border-b">
          <ProductLabel className="mb-2.5">Properties</ProductLabel>
          <dl className="flex flex-col gap-1.5">
            {PROPERTIES.map(([k, v]) => (
              <div
                key={k}
                className="flex items-baseline justify-between gap-3 font-mono text-[12px]"
              >
                <dt className="text-white/40">{k}</dt>
                <dd className="truncate text-white/75">{v}</dd>
              </div>
            ))}
          </dl>
        </ProductCardSection>

        {/* Members — a proper table; hover a row for the member's stat card. */}
        <ProductCardSection>
          <div className="mb-2 flex items-center justify-between">
            <ProductLabel>Members</ProductLabel>
            <span className="font-mono text-[10px] text-white/25">
              hover a row
            </span>
          </div>
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left">
                <th className="pb-1.5 pl-2.5 font-mono text-[9.5px] text-white/30 uppercase tracking-[0.06em]">
                  Member
                </th>
                <th className="pb-1.5 text-right font-mono text-[9.5px] text-white/30 uppercase tracking-[0.06em]">
                  Events
                </th>
                <th className="pb-1.5 text-right font-mono text-[9.5px] text-white/30 uppercase tracking-[0.06em]">
                  Last seen
                </th>
                <th className="pb-1.5 pr-2.5 text-right font-mono text-[9.5px] text-white/30 uppercase tracking-[0.06em]">
                  Role
                </th>
              </tr>
            </thead>
            <tbody>
              {MEMBERS.map((m) => (
                <MemberRow key={m.email} m={m} />
              ))}
            </tbody>
          </table>
        </ProductCardSection>
      </ProductCard>

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
