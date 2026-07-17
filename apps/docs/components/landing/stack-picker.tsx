"use client";

import Link from "next/link";
import { type JSX, type ReactNode, useState } from "react";
import { type BrandKey, BrandLogo } from "@/components/ds/brand-logo";
import { AnalyticsEvent, capture } from "@/lib/analytics";
import { cn } from "@/lib/cn";

/** The closed set of sources the picker reports to analytics. */
export type StackSource =
  | "posthog"
  | "segment"
  | "stripe"
  | "clerk"
  | "supabase"
  | "intercom";

export type StackItem = {
  id: StackSource;
  label: string;
  /** Brand mark on the chip — only for brands we ship an SVG for. */
  brand?: BrandKey;
  /** One matter-of-fact line above the snippet. */
  blurb: string;
  /** The docs page the snippet was condensed from. */
  guideHref: string;
  /** Server-rendered (Shiki) code snippet — passed in from the RSC page. */
  snippet: ReactNode;
};

const CHIP_CLASS = cn(
  "inline-flex h-10 select-none items-center gap-2 rounded-[10px] border",
  "px-4 text-sm outline-none transition-colors duration-200",
);

/**
 * StackPicker — a chip row (PostHog / Segment / Stripe / Clerk / Supabase)
 * that swaps a short, real config snippet showing how events from that
 * source reach Hogsend. Snippets are highlighted server-side and passed in
 * as nodes; this component only handles selection. Every panel stays
 * mounted (hidden when inactive) so swaps are instant.
 */
export function StackPicker({
  items,
  className,
}: {
  items: StackItem[];
  className?: string;
}): JSX.Element | null {
  const [activeId, setActiveId] = useState(items[0]?.id);
  const active = items.find((item) => item.id === activeId) ?? items[0];

  if (!active) return null;

  function handleSelect(id: StackSource) {
    if (id !== activeId) {
      capture(AnalyticsEvent.STACK_SELECTED, { source: id });
    }
    setActiveId(id);
  }

  return (
    <div className={className}>
      {/* Chip row */}
      <div
        role="tablist"
        aria-orientation="horizontal"
        aria-label="Pick a source"
        className="flex flex-wrap gap-2"
      >
        {items.map((item) => {
          const isActive = item.id === active.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`stack-tab-${item.id}`}
              aria-selected={isActive}
              aria-controls={`stack-panel-${item.id}`}
              onClick={() => handleSelect(item.id)}
              className={cn(
                CHIP_CLASS,
                isActive
                  ? "border-accent/40 bg-accent-tint text-accent"
                  : cn(
                      "border-white/[0.08] bg-white/[0.02] text-white/60",
                      "hover:border-white/20 hover:text-white",
                      "focus-visible:border-white/20 focus-visible:text-white",
                    ),
              )}
            >
              {item.brand ? <BrandLogo brand={item.brand} height={14} /> : null}
              {item.label}
            </button>
          );
        })}
      </div>

      {/* Snippet panels — all mounted, inactive ones hidden. */}
      {items.map((item) => (
        <div
          key={item.id}
          role="tabpanel"
          id={`stack-panel-${item.id}`}
          aria-labelledby={`stack-tab-${item.id}`}
          hidden={item.id !== active.id}
          className="mt-6 overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.02]"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-white/[0.08] border-b px-5 py-4">
            <p className="text-sm text-white/60 leading-5">{item.blurb}</p>
            <Link
              href={item.guideHref}
              className="shrink-0 text-accent text-sm transition-colors hover:text-accent/80"
            >
              Full guide &rarr;
            </Link>
          </div>
          <div className="overflow-x-auto p-5">{item.snippet}</div>
        </div>
      ))}
    </div>
  );
}
