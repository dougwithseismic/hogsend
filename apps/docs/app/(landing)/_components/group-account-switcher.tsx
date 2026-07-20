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
}

const MEMBERS: Member[] = [
  { name: "Bill Chen", email: "bill@acme.com", role: "admin", tint: "#f64838" },
  {
    name: "Derek Vaughn",
    email: "derek@acme.com",
    role: "member",
    tint: "#c98bff",
  },
  {
    name: "Bob Portis",
    email: "bob@acme.com",
    role: "member",
    tint: "#ff9a6c",
  },
];

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
        {/* Identity — matches the header divider/padding scale. */}
        <div className="flex items-center gap-3 border-white/[0.08] border-b px-4 py-3.5">
          <span
            aria-hidden="true"
            className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] font-semibold text-[15px] text-white"
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
          <ProductTag tone="crimzon" pulse>
            pro
          </ProductTag>
        </div>

        {/* Stats — the ProductStat primitive, three across. */}
        <ProductCardSection className="grid grid-cols-3 gap-4 border-white/[0.08] border-b">
          <ProductStat value="42" label="Seats" />
          <ProductStat value="3" label="Members" />
          <ProductStat value="$4.2k" label="MRR" />
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

        {/* Members — the row idiom, avatar + name + role. */}
        <ProductCardSection>
          <ProductLabel className="mb-2">Members</ProductLabel>
          <ul className="flex flex-col gap-0.5">
            {MEMBERS.map((m) => (
              <li
                key={m.email}
                className="flex items-center gap-3 rounded-[6px] px-2.5 py-2"
              >
                <span
                  aria-hidden="true"
                  className="flex size-7 shrink-0 items-center justify-center rounded-full font-medium text-[11px] text-white"
                  style={{ backgroundColor: m.tint }}
                >
                  {m.name.slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-[13px] text-white tracking-[-0.02em]">
                    {m.name}
                  </span>
                  <span className="block truncate font-mono text-[11px] text-white/35">
                    {m.email}
                  </span>
                </span>
                <ProductTag tone={m.role === "admin" ? "crimzon" : "neutral"}>
                  {m.role}
                </ProductTag>
              </li>
            ))}
          </ul>
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
