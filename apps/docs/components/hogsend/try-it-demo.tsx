"use client";

import { useHogsend, useHogsendFeed } from "@hogsend/react";
import { ArrowRight, Bell, Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { PillBadge, TagPill } from "@/components/ds/badge";
import { Card } from "@/components/ds/card";
import { CodeWindow } from "@/components/ds/code-window";
import { cn } from "@/lib/cn";
import { isHogsendConfigured } from "./config";

/**
 * The three demo actions. `event` MUST match a registered demo journey trigger
 * (apps/api/src/journeys/demo-inapp.ts → DemoEvents.*).
 */
const ACTIONS = [
  {
    event: "demo.welcome",
    label: "Send me a welcome",
    hint: "personalized with your name",
  },
  {
    event: "demo.launch_announcement",
    label: "Send a launch announcement",
    hint: "broadcast-style item with a link",
  },
  {
    event: "demo.trial_ending",
    label: "Send a trial-ending nudge",
    hint: "lifecycle nudge with a CTA",
  },
] as const;

const STEPS = [
  "You fired a first-party event (source: inapp) carrying your anonymous id.",
  "The engine resolved your anon id to a canonical contact key and routed it.",
  "A journey triggered on that event, read your name, and called sendFeedItem.",
  "It landed in your bell ↗ — open it. Clicking the item fires inapp.item_clicked back into the loop.",
] as const;

const JOURNEY_SRC = `import { days } from "@hogsend/core";
import { defineJourney, sendFeedItem } from "@hogsend/engine";
import { DemoEvents } from "./constants/index.js";

export const demoWelcome = defineJourney({
  meta: {
    id: "demo-welcome",
    name: "Demo — In-app welcome",
    enabled: true,
    trigger: { event: DemoEvents.WELCOME }, // "demo.welcome"
    entryLimit: "unlimited",                // re-fire freely
    suppress: days(0),
  },
  run: async (user) => {
    const n = user.properties.name;
    const name = typeof n === "string" && n ? n : "there";
    await sendFeedItem({
      recipient: { anonymousId: user.id }, // your canonical key
      type: "welcome",
      title: \`Welcome, \${name} 👋\`,
      body: "You fired an event. A journey ran. This is the result.",
      actionUrl: "https://hogsend.com/docs/client-side/try",
      journeyStateId: user.stateId,
    });
  },
});`;

function GatedFallback() {
  return (
    <Card className="my-8 p-6">
      <div className="mb-3 flex items-center gap-3">
        <span className="kicker block">Live demo</span>
        <PillBadge>
          <Bell className="size-3.5" strokeWidth={1.5} />
          Offline here
        </PillBadge>
      </div>
      <p className="text-sm text-white/55 leading-6">
        The live demo is dormant on this build — no engine is wired in.
      </p>
      <p className="mt-2 text-[13px] text-white/40 leading-6">
        Set{" "}
        <code className="font-mono text-white/60">
          NEXT_PUBLIC_HOGSEND_API_URL
        </code>{" "}
        and a <code className="font-mono text-white/60">pk_</code> publishable
        key whose{" "}
        <code className="font-mono text-white/60">allowed_origins</code>{" "}
        includes this site, and the buttons go live.
      </p>
    </Card>
  );
}

export function TryItDemo() {
  if (!isHogsendConfigured) return <GatedFallback />;
  return <TryItDemoLive />;
}

function TryItDemoLive() {
  const { client, capture } = useHogsend();
  const { refetch, metadata } = useHogsendFeed();
  const [name, setName] = useState("");
  const [anonId, setAnonId] = useState("");
  const [step, setStep] = useState(-1);
  const [firing, setFiring] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Hydrate display-only values client-side (avoids SSR mismatch + reads
  // localStorage only in the browser). Pre-fills the name on a return visit.
  useEffect(() => {
    setAnonId(client.getDistinctId());
    const saved = window.localStorage.getItem("hs-demo-name");
    if (saved) setName(saved);
  }, [client]);

  function onName(value: string) {
    setName(value);
    window.localStorage.setItem("hs-demo-name", value);
  }

  function copyAnon() {
    if (!anonId) return;
    navigator.clipboard?.writeText(anonId).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  }

  async function fire(event: string) {
    setFiring(event);
    setStep(0);
    // 1) capture the first-party event, carrying the name as a property
    await capture(event, name ? { name } : {});
    setStep(1);
    // 2) flush so it hits the engine immediately (capture is batched)
    await client.flush();
    setStep(2);
    // 3) give the journey a beat to insert the feed item, then refetch so the
    //    bell badge updates instantly (the poll backstops it regardless)
    await new Promise((resolve) => window.setTimeout(resolve, 900));
    setStep(3);
    await refetch();
    setFiring(null);
  }

  return (
    <div className="relative my-8 not-prose">
      {/* red atmospheric bloom (the CodeWindow idiom) */}
      <div
        aria-hidden="true"
        className="-inset-x-12 -top-10 pointer-events-none absolute h-48"
        style={{
          background:
            "radial-gradient(55% 55% at 50% 0%, rgba(246,72,56,0.12), transparent 70%)",
          filter: "blur(40px)",
        }}
      />

      <div className="relative grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        {/* ── LEFT: the interactive panel ── */}
        <Card className="flex flex-col p-0">
          {/* zone 1 — header */}
          <div className="border-white/[0.08] border-b p-6">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <span className="kicker block">Live demo</span>
              <PillBadge>
                <Bell className="size-3.5" strokeWidth={1.5} />
                Anonymous · no login
              </PillBadge>
            </div>
            <h3 className="font-display text-white text-2xl tracking-[-0.02em]">
              Fire it. Watch your bell.
            </h3>
            <p className="mt-1.5 text-sm text-white/55 leading-6">
              A button here fires a first-party event. A journey turns it into a
              notification in the bell ↗ in the top nav — your feed, this
              session, no login.
            </p>
          </div>

          {/* zone 2 — identity + personalization */}
          <div className="border-white/[0.08] border-b p-6">
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={copyAnon}
                className="group inline-flex min-w-0 items-center gap-2 font-mono text-[11px] text-white/40 tracking-wide transition-colors hover:text-white/70"
                title="Copy your anonymous id"
              >
                <span className="truncate">
                  {anonId ? `anon: ${anonId}` : "anon: …"}
                </span>
                {copied ? (
                  <Check className="size-3 shrink-0 text-good" />
                ) : (
                  <Copy className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />
                )}
              </button>
              <TagPill>not identified</TagPill>
            </div>
            <label
              htmlFor="hs-demo-name"
              className="mt-4 block text-[13px] text-white/50"
            >
              Your name (sent as an event property — personalizes the item)
            </label>
            <input
              id="hs-demo-name"
              value={name}
              onChange={(e) => onName(e.target.value)}
              placeholder="e.g. Doug"
              className="mt-2 h-10 w-full rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 text-sm text-white transition-colors placeholder:text-white/30 focus:border-accent focus:outline-none"
            />
          </div>

          {/* zone 3 — action row */}
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
                  "disabled:cursor-not-allowed disabled:opacity-50",
                )}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{action.label}</span>
                  <span className="truncate font-mono text-[11px] text-white/35">
                    capture("{action.event}"
                    {name ? `, { name: "${name}" }` : ""})
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

          {/* zone 4 — live narration */}
          <div className="p-6">
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
              Unread in your bell:{" "}
              <span className="font-mono text-accent tabular-nums">
                {metadata.unread_count ?? 0}
              </span>
              . Each item carries an actionUrl — clicking the row emits{" "}
              <code className="font-mono text-white/55">
                inapp.item_clicked
              </code>
              , a real first-party event a journey can react to.
            </p>
          </div>
        </Card>

        {/* ── RIGHT: the code that just ran ── */}
        <div className="lg:sticky lg:top-24 lg:self-start">
          <CodeWindow
            filename="apps/api/src/journeys/demo-inapp.ts"
            code={JOURNEY_SRC}
          />
          <p className="mt-3 text-[12px] text-white/40 leading-5">
            This is the journey that drops the notification into your bell. It
            reads your name off the event and personalizes the title — same
            anonymous identity end to end, zero identify call.
          </p>
        </div>
      </div>
    </div>
  );
}
