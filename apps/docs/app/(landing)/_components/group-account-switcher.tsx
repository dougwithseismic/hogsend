"use client";

import Link from "next/link";
import { type ReactNode, useState } from "react";
import { CopyButton } from "@/components/ds/copy-button";
import { cn } from "@/lib/cn";

/**
 * Contact groups, in the same code-forward shape as the feature-flags section
 * above it — but the interaction that fits groups is "read the code, see the
 * account", not a toggle. So the LEFT column is a high-fidelity Studio-style
 * profile card for the Acme account (properties, members, recent activity),
 * and the RIGHT column is the real `@hogsend/js` / `@hogsend/client` code that
 * writes and reads it, tabbed with a copy button.
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
  ["plan", "pro"],
  ["seats", "42"],
  ["industry", "Developer tools"],
  ["region", "us-east-1"],
  ["created", "Mar 2025"],
];

const ACTIVITY: Array<{ event: string; who: string; when: string }> = [
  { event: "report.created", who: "Bill", when: "2h ago" },
  { event: "seat.added", who: "Derek", when: "1d ago" },
  { event: "invoice.paid", who: "billing", when: "3d ago" },
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
      {/* LEFT — a high-fidelity account profile card, the way Studio reads it. */}
      <article className="overflow-hidden rounded-2xl border border-[var(--tw-border)] bg-[var(--tw-ink-high)] shadow-[0_24px_70px_-30px_rgba(0,0,0,0.8)]">
        {/* Cover band + identity */}
        <div className="relative">
          <div
            aria-hidden="true"
            className="h-20 w-full"
            style={{
              background:
                "linear-gradient(115deg, rgba(246,72,56,0.35) 0%, rgba(201,139,255,0.28) 55%, rgba(255,154,108,0.3) 100%)",
            }}
          />
          <div className="flex items-end gap-4 px-6 pb-4">
            <span
              aria-hidden="true"
              className="-mt-8 flex size-16 shrink-0 items-center justify-center rounded-2xl border border-white/15 bg-[#17141f] font-semibold text-2xl text-white shadow-lg"
            >
              A
            </span>
            <div className="flex min-w-0 flex-1 items-center justify-between gap-3 pb-1">
              <div className="min-w-0">
                <h3 className="truncate font-semibold text-[18px] text-white tracking-[-0.01em]">
                  Acme Inc
                </h3>
                <p className="font-mono text-[12px] text-white/45">
                  company · acme.com
                </p>
              </div>
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[#f64838]/30 bg-[#f64838]/[0.1] px-2.5 py-1 font-medium text-[11px] text-[#ff9a8a]">
                <span className="size-1.5 rounded-full bg-[#3ecf8e]" />
                pro
              </span>
            </div>
          </div>
        </div>

        {/* Stat strip */}
        <dl className="grid grid-cols-4 border-white/[0.07] border-y divide-x divide-white/[0.07]">
          {[
            ["seats", "42"],
            ["members", "3"],
            ["MRR", "$4.2k"],
            ["active 30d", "98%"],
          ].map(([k, v]) => (
            <div key={k} className="px-3 py-3 text-center">
              <dt className="font-mono text-[9.5px] text-white/35 uppercase tracking-[0.06em]">
                {k}
              </dt>
              <dd className="mt-1 font-semibold text-[16px] text-white tabular-nums">
                {v}
              </dd>
            </div>
          ))}
        </dl>

        <div className="grid gap-6 p-6 md:grid-cols-2">
          {/* Properties */}
          <section>
            <h4 className="font-mono text-[10px] text-white/35 uppercase tracking-[0.08em]">
              Properties
            </h4>
            <dl className="mt-3 space-y-2">
              {PROPERTIES.map(([k, v]) => (
                <div
                  key={k}
                  className="flex items-baseline justify-between gap-3 border-white/[0.05] border-b pb-2 last:border-0"
                >
                  <dt className="font-mono text-[11.5px] text-white/40">{k}</dt>
                  <dd className="truncate font-medium text-[12.5px] text-white/80">
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          {/* Recent activity */}
          <section>
            <h4 className="font-mono text-[10px] text-white/35 uppercase tracking-[0.08em]">
              Recent activity
            </h4>
            <ul className="mt-3 space-y-3">
              {ACTIVITY.map((a) => (
                <li key={a.event} className="flex items-start gap-2.5">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-[#f64838]/70" />
                  <div className="min-w-0">
                    <p className="truncate font-mono text-[12px] text-white/80">
                      {a.event}
                    </p>
                    <p className="text-[11px] text-white/35">
                      {a.who} · {a.when}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>

        {/* Members */}
        <section className="border-white/[0.07] border-t px-6 py-5">
          <div className="flex items-center justify-between">
            <h4 className="font-mono text-[10px] text-white/35 uppercase tracking-[0.08em]">
              Members
            </h4>
            <span className="font-mono text-[10px] text-white/30">
              3 people
            </span>
          </div>
          <ul className="mt-3 space-y-1.5">
            {MEMBERS.map((m) => (
              <li
                key={m.email}
                className="flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/[0.03]"
              >
                <span
                  aria-hidden="true"
                  className="flex size-7 shrink-0 items-center justify-center rounded-full font-medium text-[11px] text-white"
                  style={{ backgroundColor: m.tint }}
                >
                  {m.name.slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-[13px] text-white/85 leading-tight">
                    {m.name}
                  </span>
                  <span className="block truncate font-mono text-[11px] text-white/35 leading-tight">
                    {m.email}
                  </span>
                </span>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px]",
                    m.role === "admin"
                      ? "bg-[#f64838]/[0.12] text-[#ff9a8a]"
                      : "bg-white/[0.06] text-white/45",
                  )}
                >
                  {m.role}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </article>

      {/* RIGHT — the real code that writes and reads that account. */}
      <div className="overflow-hidden rounded-xl border border-[var(--tw-border)] bg-[var(--tw-ink-high)] shadow-xl">
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
                    "shrink-0 whitespace-nowrap border-b-2 px-2.5 py-3 font-mono text-[11px] tracking-wide outline-none transition-colors",
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

        <div className="ps-code overflow-auto px-4 py-4 text-[12.5px]">
          {code[tab]}
        </div>

        <div className="border-white/[0.07] border-t px-4 py-3">
          <p className="font-mono text-[10px] text-white/35 uppercase tracking-[0.06em]">
            {tab === "browser"
              ? "publishable — associate only"
              : "secret — writes properties"}
          </p>
          <p className="mt-1.5 text-[12px] text-white/50 leading-[1.5]">
            {tab === "browser"
              ? "A pk_ key can attach a contact's events to the account, never write its properties."
              : "Group properties and memberships are secret-key writes, enforced at the route."}
          </p>
        </div>
      </div>

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
