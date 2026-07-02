"use client";

import { Workflow } from "lucide-react";
import { JourneyShot } from "@/components/clips/journey-trace";
import { PillBadge } from "@/components/ds/badge";
import { buildDemoTraceSpec } from "@/components/hogsend/demo-trace-specs";

/**
 * DemoTrace — the full-width "what just ran" band beneath the home live-demo
 * grid. Reuses the marketing journey-trace vocabulary (real journey code on the
 * left, the run executing on the right: event → PostHog identify → in-app send →
 * Discord mirror) but in ONE-SHOT mode: it replays from the top each time the
 * visitor fires an event in the sibling column (`nonce` bumps), so you SEE the
 * event route, the journey run, the visitor identified on PostHog, the item
 * land, and the event mirrored to Discord — synced to the button they clicked.
 *
 * Idle (`nonce === 0`) it sits on the settled welcome run as a teaser. All four
 * traces are faithful to the journeys the production site actually runs
 * (hogsend-dogfood/src/journeys/docs-inapp-demo.ts) — see demo-trace-specs.ts.
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
  const hint =
    nonce === 0
      ? signedUp
        ? "Fire an event above to replay it here ↑"
        : "Sign up, then fire an event to watch it run ↑"
      : "Replays each time you fire an event ↑";

  return (
    <div className="mt-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="kicker block">Step by step</span>
          <PillBadge>
            <Workflow className="size-3.5" strokeWidth={1.5} />
            What just ran
          </PillBadge>
        </div>
        <p className="text-[12px] text-white/40 leading-5">{hint}</p>
      </div>

      <JourneyShot spec={spec} playToken={nonce} />

      <p className="mt-3 text-[12px] text-white/40 leading-5">
        Stage by stage — the real dogfood run: the journey{" "}
        <span className="text-white/60">identifies</span> you on{" "}
        <span className="text-white/60">PostHog</span> (your name, or your NPS
        score, becomes a person property), drops the item into your bell ↗
        above, and mirrors the event into the team&rsquo;s{" "}
        <span className="text-white/60">Discord</span>. Every item&rsquo;s link
        is tracked, so a click fires a real{" "}
        <code className="font-mono text-white/55">link.clicked</code> the engine
        turns into another item.
      </p>
    </div>
  );
}
