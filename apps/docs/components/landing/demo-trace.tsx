"use client";

import { ChevronDown, Workflow } from "lucide-react";
import { useEffect, useState } from "react";
import { JourneyShot } from "@/components/clips/journey-trace";
import { PillBadge } from "@/components/ds/badge";
import { buildDemoTraceSpec } from "@/components/hogsend/demo-trace-specs";
import { cn } from "@/lib/cn";

/**
 * DemoTrace — the "what just ran" band beneath the home live-demo grid,
 * COLLAPSED to a single disclosure row by default and auto-expanded the first
 * time the visitor fires an event (the expert payoff arrives after the magic
 * moment, not as default-visible code). Reuses the marketing journey-trace
 * vocabulary (real journey code on the left, the run executing on the right:
 * event → PostHog identify → in-app send → Discord mirror) in ONE-SHOT mode:
 * it replays from the top each time the visitor fires an event in the sibling
 * column (`nonce` bumps), so you SEE the event route, the journey run, the
 * visitor identified on PostHog, the item land, and the event mirrored to
 * Discord — synced to the button they clicked.
 *
 * All four traces are faithful to the journeys the production site actually
 * runs (hogsend-dogfood/src/journeys/docs-inapp-demo.ts) — see
 * demo-trace-specs.ts.
 */
export function DemoTrace({
  event,
  nonce,
  signedUp,
  name,
}: {
  event: string | null;
  nonce: number;
  signedUp: boolean;
  name?: string;
}) {
  const spec = buildDemoTraceSpec(event ?? "demo.welcome", name);
  // Collapsed until the visitor either fires an event (auto-open, below) or
  // opens it themselves.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (nonce > 0) setOpen(true);
  }, [nonce]);

  const hint =
    nonce === 0
      ? signedUp
        ? "Fire an event above to replay it here ↑"
        : "Sign up, then fire an event to watch it run ↑"
      : "Replays each time you fire an event ↑";

  return (
    <div className="mt-6">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="demo-trace-band"
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "flex w-full flex-wrap items-center justify-between gap-3 border border-white/[0.08] px-5 py-4 text-left transition-colors hover:border-white/15",
          open ? "rounded-t-xl border-b-0" : "rounded-xl",
        )}
      >
        <span className="flex flex-wrap items-center gap-3">
          <span className="kicker block">Step by step</span>
          <PillBadge>
            <Workflow className="size-3.5" strokeWidth={1.5} />
            What just ran
          </PillBadge>
          {nonce > 0 && event ? (
            <code className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 font-mono text-[11px] text-white/55 leading-none">
              {event}
            </code>
          ) : null}
        </span>
        <span className="flex items-center gap-2 text-[12px] text-white/40 leading-5">
          {open ? hint : "See the journey code behind it"}
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 transition-transform",
              open && "rotate-180",
            )}
            strokeWidth={1.5}
          />
        </span>
      </button>

      {open ? (
        <div
          id="demo-trace-band"
          className="overflow-hidden rounded-b-xl border border-white/[0.08]"
        >
          <JourneyShot spec={spec} playToken={nonce} />
        </div>
      ) : null}
    </div>
  );
}
