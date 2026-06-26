"use client";

import { NotificationFeed, useHogsend, useHogsendFeed } from "@hogsend/react";
import { ArrowRight, Bell, Check } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { PillBadge, TagPill } from "@/components/ds/badge";
import { Card } from "@/components/ds/card";
import { cn } from "@/lib/cn";

/**
 * The interactive half of the home-page live demo. Friction-free (no sign-up
 * gate): fire a real lifecycle event, watch a journey turn it into a
 * notification in the inline feed (and the nav bell — shared store). The
 * optional name only personalizes the copy; the feed stays keyed to one
 * anonymous id, this session.
 *
 * Only rendered by the server `InAppDemo` wrapper when `isHogsendConfigured`,
 * so the provider is always live here and `useHogsend` has context.
 */

/** Shared with the banner greeting + the /try demo, so the name carries over. */
const NAME_KEY = "hs-demo-name";

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

const FIELD_CLASS =
  "h-10 w-full rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 text-sm text-white transition-colors placeholder:text-white/30 focus:border-accent focus:outline-none";

export function InAppDemoLive({ codePanel }: { codePanel?: ReactNode }) {
  const { client, capture } = useHogsend();
  const { refetch, metadata } = useHogsendFeed();
  const [name, setName] = useState("");
  const [step, setStep] = useState(-1);
  const [firing, setFiring] = useState<string | null>(null);

  // Pre-fill the name client-side (avoids SSR mismatch — localStorage is
  // browser-only); a return visitor / someone who used the /try demo keeps it.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(NAME_KEY);
      if (saved) setName(saved);
    } catch {
      // Private mode / storage blocked — start fresh.
    }
  }, []);

  function onName(value: string) {
    setName(value);
    try {
      window.localStorage.setItem(NAME_KEY, value);
    } catch {
      // Best-effort — the in-session value still personalizes the demo.
    }
  }

  async function fire(event: string) {
    if (firing !== null) return;
    setFiring(event);
    setStep(0);
    try {
      // 1) capture the first-party event, carrying the name as a property
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
    <div className="relative grid gap-6 lg:grid-cols-[400px_minmax(0,1fr)]">
      {/* ── LEFT: the interactive panel ── */}
      <Card className="flex flex-col p-0">
        {/* zone 1 — header + optional name */}
        <div className="border-white/[0.08] border-b p-6">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <span className="kicker block">Live demo</span>
            <PillBadge>
              <Bell className="size-3.5" strokeWidth={1.5} />
              Anonymous, this session
            </PillBadge>
          </div>
          <h3 className="font-display text-2xl text-white tracking-[-0.02em]">
            Fire an event. Watch it land.
          </h3>
          <p className="mt-1.5 text-sm text-white/55 leading-6">
            No login. Fire a real lifecycle event and a journey turns it into a
            notification — in the feed below and the bell ↗ in the top nav. Your
            name just personalizes the copy.
          </p>
          <input
            type="text"
            value={name}
            onChange={(e) => onName(e.target.value)}
            placeholder="Your name (optional)"
            autoComplete="given-name"
            maxLength={80}
            aria-label="Your name — optional, personalizes the notification"
            className={cn("mt-4", FIELD_CLASS)}
          />
        </div>

        {/* zone 2 — action buttons */}
        <div className="flex flex-col gap-2 border-white/[0.08] border-b p-6">
          {ACTIONS.map((action) => (
            <button
              key={action.event}
              type="button"
              disabled={firing !== null}
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
            and a <code className="font-mono text-white/55">link.clicked</code>{" "}
            — real first-party events a journey can react to.
          </p>
        </div>
      </Card>

      {/* ── RIGHT: the code that just ran ── */}
      <div className="lg:sticky lg:top-24 lg:self-start">
        {codePanel}
        <p className="mt-3 text-[12px] text-white/40 leading-5">
          The journey that drops the welcome into your feed — the same code you
          scaffold. An event in, a notification keyed to one identity out.
        </p>
      </div>
    </div>
  );
}
