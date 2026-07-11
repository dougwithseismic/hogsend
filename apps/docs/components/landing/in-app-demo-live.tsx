"use client";

import { NotificationFeed, useHogsend, useHogsendFeed } from "@hogsend/react";
import { ArrowRight, Bell, Check, Mail } from "lucide-react";
import { useState } from "react";
import { PillBadge } from "@/components/ds/badge";
import { Card } from "@/components/ds/card";
import { AnalyticsEvent, capture as trackEvent } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { DISCORD_INVITE_URL } from "@/lib/site";

/**
 * The in-app half of the home live demo. Gated on the sign-up in the sibling
 * column (`InAppDemoBody` lifts `signedUp` + `name`) — NOT anonymous: you fire
 * real lifecycle events only once you've signed up. The feed renders the
 * recipient-scoped `in_app` feed (the same one the nav bell polls).
 *
 * Staged, not simultaneous: ONE glowing primary action ("Send me a welcome"),
 * the other moments as a compact chip row, and the three landing surfaces
 * (feed / inbox / Discord) as tabs instead of stacked sections. Firing an
 * action auto-switches the tabs to where that action lands, so the payoff is
 * always in view. The four-beat pipeline stepper is the single narration
 * surface — the journey code itself lives in the sibling DemoTrace band.
 *
 * `wide` reflows the card into a two-up layout (controls | landing tabs) for
 * the full-width identified state (a return visitor doesn't need the sign-up
 * column, so `InAppDemoBody` drops it and hands this the whole row).
 *
 * Channels are real, not mocked: the capture actions land in your bell live
 * (and fan to PostHog + Discord in the dogfood), and "Email me a sample" sends
 * a REAL email from hello@hogsend.com via /api/sample. The Discord tab links
 * one identity across web and Discord.
 *
 * Only rendered when `isHogsendConfigured`, so `useHogsend` always has context.
 */

type DemoAction = {
  event: string;
  label: string;
  /** `capture` → first-party event onto the spine; `email` → real send. */
  kind: "capture" | "email";
};

/**
 * Each capture `event` MUST match a deployed demo journey trigger (t.hogsend.com);
 * the `email` action POSTs the signed-up address to /api/sample, which the
 * dogfood `sampleRequest` journey turns into a real "[Sample]" email.
 * The first entry is the glowing primary; the rest render as the chip row.
 */
const PRIMARY_ACTION: DemoAction = {
  event: "demo.welcome",
  label: "Send me a welcome",
  kind: "capture",
};

const MORE_ACTIONS: readonly DemoAction[] = [
  {
    event: "demo.launch_announcement",
    label: "Launch announcement",
    kind: "capture",
  },
  {
    event: "demo.trial_ending",
    label: "Trial-ending nudge",
    kind: "capture",
  },
  {
    event: "demo.survey",
    label: "In-app survey",
    kind: "capture",
  },
  {
    event: "demo.email",
    label: "Email me a sample",
    kind: "email",
  },
] as const;

/** The four beats of a fire, as a compact pipeline: chip labels on one row,
 * one narration line below that swaps as the run advances. */
const PIPELINE = [
  {
    label: "event",
    text: "You fired a first-party event keyed to your id.",
  },
  {
    label: "identity",
    text: "The engine resolved it to one contact — the same person across web, email, and Discord.",
  },
  {
    label: "journey",
    text: "A journey caught the event, read your name, and chose the response.",
  },
  {
    label: "landed",
    text: "Your bell rang ↗ and the item hit the feed — email and Discord fan out from the same trigger.",
  },
] as const;

/** The three surfaces a demo action lands on, as tabs. */
type PanelId = "feed" | "inbox" | "discord";

const PANELS: readonly { id: PanelId; label: string }[] = [
  { id: "feed", label: "Your feed" },
  { id: "inbox", label: "Your inbox" },
  { id: "discord", label: "Discord" },
] as const;

/** Channels on the roadmap — rendered as disabled "soon" tabs beside the live
 * surfaces so the multi-channel reach reads even before each one is wired in. */
const SOON_PANELS = ["Slack", "SMS", "Voice agent"] as const;

export function InAppDemoLive({
  signedUp,
  name,
  email,
  wide = false,
  onFire,
  onSignOut,
}: {
  signedUp: boolean;
  name?: string;
  /** The signed-in visitor's email — where "Email me a sample" sends. */
  email?: string;
  /** Full-width two-up layout for the identified state (no sign-up sibling). */
  wide?: boolean;
  /** Notify the parent which event was just fired so the trace band replays. */
  onFire?: (event: string) => void;
  /** Sign-out handler — rendered in the header when signed in. */
  onSignOut?: () => void;
}) {
  const { client, capture, isIdentified } = useHogsend();
  const { refetch } = useHogsendFeed();
  const [step, setStep] = useState(-1);
  const [firing, setFiring] = useState<string | null>(null);
  // The event whose item most recently landed — drives the "Bell rang ↗" /
  // "Sent ✓" cue for ~2.6s, then clears.
  const [landed, setLanded] = useState<string | null>(null);
  // The address the sample email went to — persists the inbox tab's "sent"
  // row for the session (unlike `landed`, which clears after the pulse).
  const [sampleSentTo, setSampleSentTo] = useState<string | null>(null);
  // The active landing tab. Firing an action switches to where it lands.
  const [panel, setPanel] = useState<PanelId>("feed");

  function selectPanel(id: PanelId) {
    if (id !== panel) {
      trackEvent(AnalyticsEvent.TAB_SELECTED, { tab: `live-demo-${id}` });
    }
    setPanel(id);
  }

  async function fire(event: string) {
    // Gate on isIdentified, not just signedUp: firing before the userToken has
    // landed captures on the anonymous id, so the item lands under a recipient
    // key the (soon-to-be-identified) bell never polls — the event fires but the
    // feed stays empty. Waiting for the identified client keeps write + read on
    // the same contact.
    if (!signedUp || !isIdentified || firing !== null) return;
    // Kick the trace band off the instant they click — it animates the journey
    // shape while the real capture/flush/refetch below lands the live item.
    onFire?.(event);
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
      // The unread count just climbed → the nav bell rings (nav-bell.tsx). Echo
      // that here, and pull the feed tab into view so the landing is visible.
      setLanded(event);
      setPanel("feed");
      window.setTimeout(
        () => setLanded((current) => (current === event ? null : current)),
        2600,
      );
    } catch {
      // A transient network failure must not brick the demo.
      setStep(-1);
    } finally {
      setFiring(null);
    }
  }

  /**
   * "Email me a sample" — POSTs the signed-up address to /api/sample, which
   * forwards `docs.sample_requested` to the dogfood; the `sampleRequest` journey
   * sends a REAL rendered "[Sample] Welcome to Hogsend" email (rate-limited per
   * hour per address). The trace band replays the email journey shape.
   */
  async function fireEmail() {
    if (!signedUp || firing !== null) return;
    const to = email ?? "";
    if (!to) return;
    onFire?.("demo.email");
    setFiring("demo.email");
    try {
      const res = await fetch("/api/sample", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: to,
          template: "activation/welcome",
          ...(name ? { name } : {}),
        }),
      });
      if (res.ok) {
        setLanded("demo.email");
        setSampleSentTo(to);
        setPanel("inbox");
        window.setTimeout(
          () =>
            setLanded((current) => (current === "demo.email" ? null : current)),
          2600,
        );
      }
    } catch {
      // Non-fatal — a transient failure must not brick the demo.
    } finally {
      setFiring(null);
    }
  }

  // ── zones (composed differently for `wide` vs the narrow single card) ──

  const header = (
    <div className="border-white/[0.08] border-b p-6">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="kicker block">In-app, live</span>
        <PillBadge>
          <Bell className="size-3.5" strokeWidth={1.5} />
          {signedUp ? "Signed up — fire away" : "Sign up first"}
        </PillBadge>
        {signedUp && onSignOut ? (
          <button
            type="button"
            onClick={onSignOut}
            className="ml-auto text-[13px] text-white/40 underline decoration-white/20 underline-offset-2 transition-colors hover:text-white/70"
          >
            Sign out
          </button>
        ) : null}
      </div>
      <h3 className="font-display text-2xl text-white tracking-[-0.02em]">
        {wide
          ? "Fire an event, watch your bell ring ↗"
          : "…then fire an event, watch your bell ring ↗"}
      </h3>
      <p className="mt-1.5 text-sm text-white/55 leading-6">
        {signedUp
          ? `You're in${name ? `, ${name}` : ""} — fire a real lifecycle event and a journey turns it into a notification. Your bell ↗ in the top nav rings, and the item drops into the feed.`
          : "Sign up on the left, then fire a real lifecycle event — a journey turns it into a notification. The bell ↗ in the top nav rings, and the item lands here in the feed."}
      </p>
    </div>
  );

  const primaryLanded = landed === PRIMARY_ACTION.event;
  const actions = (
    <div className="flex flex-col gap-3 border-white/[0.08] border-b p-6">
      {signedUp && !isIdentified ? (
        <p className="text-[12px] text-white/40 leading-5">
          Connecting you to the live feed…
        </p>
      ) : null}
      <button
        type="button"
        disabled={firing !== null || !signedUp || !isIdentified}
        onClick={() => fire(PRIMARY_ACTION.event)}
        className={cn(
          "group inline-flex items-center justify-between gap-2 rounded-[10px] border px-4 py-3.5 text-left text-sm transition-colors",
          "border-white/[0.08] bg-white/[0.04] text-white hover:border-white/15 hover:bg-white/[0.06]",
          "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-white/[0.08] disabled:hover:bg-white/[0.04]",
          signedUp &&
            "border-accent/70 bg-accent/[0.08] shadow-[0_0_22px_-2px_rgba(246,72,56,0.55)] hover:border-accent",
        )}
      >
        <span className="font-medium">{PRIMARY_ACTION.label}</span>
        {primaryLanded ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-1 font-medium text-[11px] text-accent">
            <Bell className="size-3" strokeWidth={2} />
            Bell rang ↗
          </span>
        ) : (
          <ArrowRight
            aria-hidden="true"
            className="size-4 shrink-0 text-white/40 transition-transform group-hover:translate-x-0.5"
            strokeWidth={1.5}
          />
        )}
      </button>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-white/40">Or another moment:</span>
        {MORE_ACTIONS.map((action) => {
          const isEmail = action.kind === "email";
          const justLanded = landed === action.event;
          return (
            <button
              key={action.event}
              type="button"
              disabled={
                firing !== null || !signedUp || (!isEmail && !isIdentified)
              }
              onClick={() => (isEmail ? fireEmail() : fire(action.event))}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] transition-colors",
                "border-white/[0.08] bg-white/[0.03] text-white/70 hover:border-white/20 hover:text-white",
                "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-white/[0.08] disabled:hover:text-white/70",
                justLanded && "border-accent/50 bg-accent/[0.08] text-white",
              )}
            >
              {justLanded ? (
                <Check
                  className="size-3 text-accent"
                  strokeWidth={2}
                  aria-hidden="true"
                />
              ) : null}
              {action.label}
            </button>
          );
        })}
      </div>
    </div>
  );

  const feedPanel = (
    <>
      <p className="mb-3 text-[12px] text-white/40 leading-5">
        Items land here in real time — clicking one fires a real{" "}
        <code className="font-mono text-white/55">link.clicked</code> a journey
        can react to.
      </p>
      <NotificationFeed feedId="in_app" aria-label="In-app demo feed" />
    </>
  );

  // The email payoff, made visible: a small inbox mock that fills in as real
  // sends land. Row one is the welcome series the sign-up itself triggered;
  // row two lights up when "Email me a sample" actually sends.
  const inboxPanel = (
    <>
      <ul className="flex flex-col gap-2">
        <li
          className={cn(
            "flex items-start gap-3 rounded-[10px] border px-4 py-3",
            signedUp
              ? "border-white/[0.08] bg-white/[0.03]"
              : "border-white/[0.06] border-dashed opacity-60",
          )}
        >
          <Mail
            className="mt-0.5 size-4 shrink-0 text-white/45"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <span className="flex min-w-0 flex-col">
            <span className="font-medium text-sm text-white">
              Welcome to Hogsend 👋
            </span>
            <span className="text-[12px] text-white/40 leading-5">
              {signedUp
                ? "hello@hogsend.com — sent when you signed up; it opens the welcome series."
                : "Sign up and the welcome series starts here."}
            </span>
          </span>
        </li>
        <li
          className={cn(
            "flex items-start gap-3 rounded-[10px] border px-4 py-3 transition-colors",
            sampleSentTo
              ? "border-accent/50 bg-accent/[0.07]"
              : "border-white/[0.06] border-dashed opacity-60",
            landed === "demo.email" && "animate-pulse",
          )}
        >
          <Mail
            className={cn(
              "mt-0.5 size-4 shrink-0",
              sampleSentTo ? "text-accent" : "text-white/45",
            )}
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <span className="flex min-w-0 flex-col">
            <span className="font-medium text-sm text-white">
              [Sample] Welcome to Hogsend
            </span>
            <span className="text-[12px] text-white/40 leading-5">
              {sampleSentTo
                ? `hello@hogsend.com — just sent to ${sampleSentTo}. Open your inbox: that's the activation/welcome template, rendered for you.`
                : "Click “Email me a sample” above and the send lands here — and in your real inbox."}
            </span>
          </span>
        </li>
      </ul>
      <p className="mt-3 text-[12px] text-white/35 leading-5">
        React Email templates from the scaffold —{" "}
        <a href="/emails" className="text-white/60 hover:text-white">
          see all 13 →
        </a>
      </p>
    </>
  );

  const discordPanel = (
    <>
      <h4 className="font-display text-lg text-white tracking-[-0.01em]">
        Link your account — get it in Discord and your bell
      </h4>
      <p className="mt-1.5 text-[13px] text-white/55 leading-6">
        Join the Hogsend Discord and run{" "}
        <code className="font-mono text-white/70">/link</code>. The dogfood
        matches the email you signed up with, grants your role, and drops a “You
        linked your Discord” item into{" "}
        <span className="text-white/70">this exact bell</span> — one identity,
        web and Discord, no extra code.
      </p>
      <a
        href={DISCORD_INVITE_URL}
        target="_blank"
        rel="noreferrer"
        onClick={() =>
          trackEvent(AnalyticsEvent.DISCORD_LINK_CLICKED, {
            placement: "live-demo",
          })
        }
        className="group mt-4 inline-flex h-11 select-none items-center justify-center gap-2 rounded-[10px] border border-accent/60 bg-accent/[0.08] px-5 font-medium text-sm text-white transition-colors hover:border-accent hover:bg-accent/[0.14] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        Get your Discord invite
        <ArrowRight
          aria-hidden="true"
          className="size-4 shrink-0 transition-transform group-hover:translate-x-0.5"
          strokeWidth={2}
        />
      </a>
      <p className="mt-2 text-[12px] text-white/35 leading-5">
        Then type <code className="font-mono text-white/55">/link</code> in any
        channel.{" "}
        {signedUp ? null : "Sign up first so /link can match your email."}
      </p>
    </>
  );

  // The landing surfaces as one tabbed zone — the ds hairline-underline tab
  // idiom in miniature. Firing an action switches to the tab where it lands.
  const landing = (
    <div className="min-w-0 border-white/[0.08] border-b">
      <div
        role="tablist"
        aria-label="Where it lands"
        className="flex items-center gap-x-4 overflow-x-auto border-white/[0.08] border-b px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {PANELS.map((p) => {
          const isActive = panel === p.id;
          return (
            <button
              key={p.id}
              type="button"
              role="tab"
              id={`live-demo-tab-${p.id}`}
              aria-selected={isActive}
              aria-controls={`live-demo-panel-${p.id}`}
              onClick={() => selectPanel(p.id)}
              className={cn(
                "-mb-px shrink-0 border-b py-3 text-sm tracking-[-0.02em] transition-colors",
                isActive
                  ? "border-accent text-white"
                  : "border-transparent text-white/50 hover:text-white",
              )}
            >
              {p.label}
            </button>
          );
        })}
        {SOON_PANELS.map((label) => (
          <button
            key={label}
            type="button"
            role="tab"
            aria-disabled="true"
            disabled
            title="Coming soon"
            className="-mb-px flex shrink-0 cursor-not-allowed items-baseline gap-1 border-transparent border-b py-3 text-sm text-white/30 tracking-[-0.02em]"
          >
            {label}
            <span className="font-mono text-[9px] text-white/25 uppercase tracking-[0.06em]">
              soon
            </span>
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`live-demo-panel-${panel}`}
        aria-labelledby={`live-demo-tab-${panel}`}
        className="p-6"
      >
        {panel === "feed"
          ? feedPanel
          : panel === "inbox"
            ? inboxPanel
            : discordPanel}
      </div>
    </div>
  );

  const narration = (
    <div
      className="border-white/[0.08] border-b p-6"
      role="status"
      aria-live="polite"
    >
      <ol className="flex items-center">
        {PIPELINE.map((beat, i) => {
          const active = step === i;
          const done = step > i;
          return (
            <li
              key={beat.label}
              className={cn("flex items-center", i > 0 && "min-w-0 flex-1")}
            >
              {i > 0 ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "mx-1.5 h-px min-w-2 flex-1 transition-colors",
                    done || active ? "bg-accent/50" : "bg-white/10",
                  )}
                />
              ) : null}
              <span
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] leading-none transition-colors",
                  active
                    ? "border-accent bg-accent/10 text-white"
                    : done
                      ? "border-accent/40 text-white/70"
                      : "border-white/10 text-white/40",
                )}
              >
                {done ? (
                  <Check
                    className="size-3 text-accent"
                    aria-hidden="true"
                    strokeWidth={2}
                  />
                ) : null}
                {beat.label}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 min-h-10 text-[13px] text-white/55 leading-5">
        {step >= 0
          ? PIPELINE[Math.min(step, PIPELINE.length - 1)]?.text
          : signedUp
            ? "Fire an event above and watch it move through the engine."
            : "Sign up, fire an event, and watch it move through the engine."}
      </p>
    </div>
  );

  // Wide (identified, full-width): two-up — controls | landing tabs. The
  // arbitrary last-child variant strips each card's trailing zone border.
  if (wide) {
    return (
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
        <Card className="flex flex-col p-0 [&>div:last-child]:border-b-0">
          {header}
          {actions}
          {narration}
        </Card>
        <Card className="flex flex-col p-0 [&>div:last-child]:border-b-0">
          {landing}
        </Card>
      </div>
    );
  }

  // Narrow (paired with the sign-up column): the single stacked card.
  return (
    <Card className="flex flex-col p-0 [&>div:last-child]:border-b-0">
      {header}
      {actions}
      {landing}
      {narration}
    </Card>
  );
}
