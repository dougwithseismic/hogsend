"use client";

import { NotificationFeed, useHogsend, useHogsendFeed } from "@hogsend/react";
import { ArrowRight, Bell, Check } from "lucide-react";
import { useState } from "react";
import { PillBadge, TagPill } from "@/components/ds/badge";
import { Card } from "@/components/ds/card";
import { cn } from "@/lib/cn";

/**
 * The in-app half of the home live demo. Gated on the sign-up in the sibling
 * column (`InAppDemoBody` lifts `signedUp` + `name` from the qualifier/email
 * form) — NOT anonymous: you fire real lifecycle events only once you've signed
 * up, and the events carry the name you gave. The feed still renders the
 * recipient-scoped `in_app` feed (the same one the nav bell polls).
 *
 * Only rendered when `isHogsendConfigured`, so `useHogsend` always has context.
 */

/** Each `event` MUST match a deployed demo journey trigger (t.hogsend.com). */
const ACTIONS = [
  {
    event: "demo.welcome",
    label: "Send me a welcome",
    hint: "personalized onboarding item",
  },
  {
    event: "demo.launch_announcement",
    label: "Launch announcement",
    hint: "broadcast-style item with a link",
  },
  {
    event: "demo.trial_ending",
    label: "Trial-ending nudge",
    hint: "lifecycle nudge with a CTA",
  },
  {
    event: "demo.survey",
    label: "In-app survey",
    hint: "an NPS card you answer in the feed",
  },
] as const;

const STEPS = [
  "You fired a first-party event (source: inapp) keyed to your id.",
  "The engine resolved your id to a canonical contact key and routed it.",
  "A journey triggered on the event, read your name, and called sendFeedItem.",
  "It landed in the feed below — and in the bell ↗ in the top nav.",
] as const;

export function InAppDemoLive({
  signedUp,
  name,
}: {
  signedUp: boolean;
  name?: string;
}) {
  const { client, capture } = useHogsend();
  const { refetch, metadata } = useHogsendFeed();
  const [step, setStep] = useState(-1);
  const [firing, setFiring] = useState<string | null>(null);

  async function fire(event: string) {
    if (!signedUp || firing !== null) return;
    setFiring(event);
    setStep(0);
    try {
      // 1) capture the first-party event, carrying the signed-up name
      await capture(event, name ? { name } : {});
      setStep(1);
      // 2) flush so it hits the engine immediately (capture is batched)
      await client.flush();
      setStep(2);
      // 3) give the journey a beat to insert the item, then refetch so the feed
      //    + bell badge update instantly (the poll backstops it regardless)
      await new Promise((resolve) => window.setTimeout(resolve, 900));
      setStep(3);
      await refetch();
    } catch {
      // A transient network failure must not brick the demo.
      setStep(-1);
    } finally {
      setFiring(null);
    }
  }

  return (
    <Card className="flex flex-col p-0">
      {/* zone 1 — header */}
      <div className="border-white/[0.08] border-b p-6">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <span className="kicker block">In-app, live</span>
          <PillBadge>
            <Bell className="size-3.5" strokeWidth={1.5} />
            {signedUp ? "Signed up — fire away" : "Sign up first"}
          </PillBadge>
        </div>
        <h3 className="font-display text-2xl text-white tracking-[-0.02em]">
          …then fire an event, watch your bell
        </h3>
        <p className="mt-1.5 text-sm text-white/55 leading-6">
          {signedUp
            ? `You're in${name ? `, ${name}` : ""} — fire a real lifecycle event and a journey turns it into a notification in the feed below and the bell ↗ in the top nav.`
            : "Sign up on the left, then fire a real lifecycle event — a journey turns it into a notification here and in the bell ↗ in the top nav."}
        </p>
      </div>

      {/* zone 2 — action buttons (gated until signed up) */}
      <div className="flex flex-col gap-2 border-white/[0.08] border-b p-6">
        {signedUp ? null : (
          <p className="mb-1 text-[12px] text-white/40 leading-5">
            Sign up on the left to fire real lifecycle messages.
          </p>
        )}
        {ACTIONS.map((action) => (
          <button
            key={action.event}
            type="button"
            disabled={firing !== null || !signedUp}
            onClick={() => fire(action.event)}
            className={cn(
              "group inline-flex h-12 items-center justify-between gap-2 rounded-[10px] border px-4 text-left text-sm transition-colors",
              "border-white/[0.08] bg-white/[0.04] text-white hover:border-white/15 hover:bg-white/[0.06]",
              "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-white/[0.08] disabled:hover:bg-white/[0.04]",
            )}
          >
            <span className="flex min-w-0 flex-col">
              <span className="font-medium">{action.label}</span>
              <span className="truncate font-mono text-[11px] text-white/35">
                capture("{action.event}"{name ? `, { name: "${name}" }` : ""})
              </span>
            </span>
            <ArrowRight
              aria-hidden="true"
              className="size-4 shrink-0 text-white/40 transition-transform group-hover:translate-x-0.5"
              strokeWidth={1.5}
            />
          </button>
        ))}
      </div>

      {/* zone 3 — the inline feed (the payoff) */}
      <div className="border-white/[0.08] border-b p-6">
        <p className="mb-3 text-[12px] text-white/40 leading-5">
          Your in-app feed — items land here in real time:
        </p>
        <NotificationFeed feedId="in_app" aria-label="In-app demo feed" />
      </div>

      {/* zone 4 — live narration */}
      <div className="p-6" role="status" aria-live="polite">
        <ol className="flex flex-col gap-2.5">
          {STEPS.map((text, i) => {
            const active = step === i;
            const done = step > i;
            return (
              <li key={text} className="flex items-start gap-3">
                <TagPill
                  accent={active || done}
                  className="mt-0.5 size-6 shrink-0 justify-center px-0 tabular-nums"
                >
                  {done ? <Check className="size-3" /> : i + 1}
                </TagPill>
                <span
                  className={cn(
                    "pt-0.5 text-[13px] leading-5 transition-colors",
                    active
                      ? "text-white"
                      : done
                        ? "text-white/60"
                        : "text-white/35",
                  )}
                >
                  {text}
                </span>
              </li>
            );
          })}
        </ol>
        <p className="mt-4 text-[12px] text-white/35 leading-5">
          Unread:{" "}
          <span className="font-mono text-accent tabular-nums">
            {metadata.unread_count ?? 0}
          </span>
          . Clicking a row emits{" "}
          <code className="font-mono text-white/55">inapp.item_clicked</code>{" "}
          and a <code className="font-mono text-white/55">link.clicked</code> —
          real first-party events a journey can react to.
        </p>
      </div>
    </Card>
  );
}
