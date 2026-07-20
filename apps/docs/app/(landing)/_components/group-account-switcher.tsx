"use client";

import Link from "next/link";
import { type ReactNode, useState } from "react";
import { CopyButton } from "@/components/ds/copy-button";
import { cn } from "@/lib/cn";
import {
  PRODUCT_MONO_VALUE_CLASS,
  PRODUCT_ROW_LIST_CLASS,
  ProductCard,
  ProductCardFooter,
  ProductCardHeader,
  ProductLabel,
  ProductTag,
  productRowClass,
  productRowLabelClass,
} from "./product-card";

/**
 * Contact groups, in the same interactive shape as the feature-flags section
 * above it: the LEFT column is the RESULT (a Studio-style account card for
 * acme.com), the RIGHT column is the real code + toggles that produce it.
 *
 * Flip a person's membership and the account card rolls them up live — the
 * `members` count and the member list react, exactly what `groups.addMember`
 * does in production. The code (browser association + server property/member
 * writes) is the genuine `@hogsend/js` / `@hogsend/client` API; the toggles
 * are a client-side preview of the same calls.
 *
 * `CodeHighlight` is an async RSC, so the highlighted snippets are rendered in
 * the page and handed in as `code` nodes.
 */

interface Member {
  id: string;
  name: string;
  email: string;
  role: "admin" | "member";
  tint: string;
}

const MEMBERS: Member[] = [
  {
    id: "bill",
    name: "Bill",
    email: "bill@acme.com",
    role: "admin",
    tint: "#f64838",
  },
  {
    id: "derek",
    name: "Derek",
    email: "derek@acme.com",
    role: "member",
    tint: "#c98bff",
  },
  {
    id: "bob",
    name: "Bob",
    email: "bob@acme.com",
    role: "member",
    tint: "#ff9a6c",
  },
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
  // Start with everyone rolled up; toggling is the "addMember / removeMember"
  // preview. The account itself never disappears — the group is the entity.
  const [members, setMembers] = useState<Record<string, boolean>>({
    bill: true,
    derek: true,
    bob: true,
  });

  const active = MEMBERS.filter((m) => members[m.id]);

  function toggle(id: string) {
    setMembers((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[1fr_400px]">
      {/* LEFT — the result: a Studio-style account card that rolls up. */}
      <div>
        <div className="overflow-hidden rounded-xl border border-[#f64838]/25 bg-[#f64838]/[0.05]">
          <div className="flex items-center gap-3 border-white/[0.07] border-b px-5 py-4">
            <span
              aria-hidden="true"
              className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/10 font-semibold text-[15px] text-white"
            >
              A
            </span>
            <div className="min-w-0">
              <p className="font-medium text-[16px] text-white">Acme</p>
              <p className="font-mono text-[11px] text-white/40">
                company · acme.com
              </p>
            </div>
          </div>

          <dl className="grid grid-cols-3 divide-x divide-white/[0.07]">
            {[
              ["plan", "pro"],
              ["seats", "42"],
              ["members", String(active.length)],
            ].map(([k, v]) => (
              <div key={k} className="px-4 py-3.5 text-center">
                <dt className="font-mono text-[10px] text-white/35 uppercase tracking-[0.06em]">
                  {k}
                </dt>
                <dd
                  aria-live={k === "members" ? "polite" : undefined}
                  className="mt-1 font-medium text-[18px] text-white tabular-nums"
                >
                  {v}
                </dd>
              </div>
            ))}
          </dl>

          <div className="border-white/[0.07] border-t px-4 py-4">
            <p className="mb-3 font-mono text-[10px] text-white/35 uppercase tracking-[0.06em]">
              Members
            </p>
            {active.length ? (
              <ul className="flex flex-col gap-2">
                {active.map((m) => (
                  <li
                    key={m.id}
                    className="flex items-center gap-3 rounded-lg border border-[var(--tw-border)] bg-white/[0.03] px-3 py-2"
                  >
                    <span
                      aria-hidden="true"
                      className="flex size-6 shrink-0 items-center justify-center rounded-full font-medium text-[10px] text-white"
                      style={{ backgroundColor: m.tint }}
                    >
                      {m.name.slice(0, 1)}
                    </span>
                    <span className="font-medium text-[13px] text-white/85">
                      {m.name}
                    </span>
                    <span className="truncate font-mono text-[11px] text-white/35">
                      {m.email}
                    </span>
                    <span className="ml-auto shrink-0 rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-[10px] text-white/45">
                      {m.role}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-lg border border-white/[0.07] border-dashed px-3 py-4 text-center text-[12px] text-white/35">
                No members yet — toggle someone in on the right.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* RIGHT — the code + the membership toggles that drive it. */}
      <ProductCard>
        <ProductCardHeader
          title="acme.com"
          tag={<ProductTag>company</ProductTag>}
          description="One (type, key) is the account. Add or remove a contact and the rollup on the left reacts — the same call your server makes."
        />

        <fieldset className={PRODUCT_ROW_LIST_CLASS}>
          {MEMBERS.map((m) => {
            const isActive = members[m.id];
            return (
              <button
                key={m.id}
                type="button"
                role="switch"
                aria-checked={isActive}
                onClick={() => toggle(m.id)}
                className={cn(
                  "flex items-center justify-between text-left outline-none transition-colors",
                  productRowClass(isActive),
                  !isActive && "hover:bg-white/[0.03]",
                )}
              >
                <span className="flex items-center gap-2.5">
                  <span
                    aria-hidden="true"
                    className="flex size-5 shrink-0 items-center justify-center rounded-full font-medium text-[9px] text-white"
                    style={{ backgroundColor: m.tint }}
                  >
                    {m.name.slice(0, 1)}
                  </span>
                  <span
                    className={cn(
                      "transition-colors",
                      productRowLabelClass(isActive),
                    )}
                  >
                    {m.email}
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  className={cn(
                    "relative h-[18px] w-8 shrink-0 rounded-full transition-colors",
                    isActive ? "bg-[#f64838]" : "bg-white/15",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 size-3.5 rounded-full bg-white transition-transform",
                      isActive ? "translate-x-[15px]" : "translate-x-0.5",
                    )}
                  />
                </span>
              </button>
            );
          })}
        </fieldset>

        <div className="flex items-center border-white/[0.08] border-t border-b">
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

        <div className="ps-code max-h-[240px] overflow-auto px-4 py-3.5 text-[12.5px]">
          {code[tab]}
        </div>

        <ProductCardFooter>
          <ProductLabel className="mb-1.5">rolled up to acme.com</ProductLabel>
          <div
            className={cn("flex items-center gap-2", PRODUCT_MONO_VALUE_CLASS)}
          >
            <span className="text-white/55">members</span>
            <span className="text-white/30">→</span>
            <span className="text-[#f8a08f] tabular-nums">{active.length}</span>
          </div>
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
