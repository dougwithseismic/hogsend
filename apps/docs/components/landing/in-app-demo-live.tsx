"use client";

import { NotificationFeed, useHogsend, useHogsendFeed } from "@hogsend/react";
import {
  ArrowRight,
  Bell,
  Check,
  type LucideIcon,
  Mail,
  MessageCircle,
} from "lucide-react";
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
 * `wide` reflows the card into a two-up layout (controls | inbox) for the
 * full-width identified state (a return visitor doesn't need the sign-up column,
 * so `InAppDemoBody` drops it and hands this the whole row).
 *
 * Channels are real, not mocked: the capture actions land in your bell live (and
 * fan to PostHog + Discord in the dogfood), and "Email me a sample" sends a REAL
 * email from hello@hogsend.com via /api/sample. The Discord step links one
 * identity across web and Discord.
 *
 * Only rendered when `isHogsendConfigured`, so `useHogsend` always has context.
 */

/** localStorage key the sign-up writes the verified email to (email-capture). */
const EMAIL_KEY = "hs-demo-email";

/** The channels a journey can fan out to — drives the per-action chips. */
type Channel = "in_app" | "email" | "discord";

const CHANNEL_META: Record<Channel, { label: string; Icon: LucideIcon }> = {
  in_app: { label: "In-app", Icon: Bell },
  email: { label: "Email", Icon: Mail },
  discord: { label: "Discord", Icon: MessageCircle },
};

type DemoAction = {
  event: string;
  label: string;
  channels: readonly Channel[];
  /** The channel this click actually fires live (reads crimzon + pulses). */
  live: Channel;
  /** `capture` → first-party event onto the spine; `email` → real send. */
  kind: "capture" | "email";
};

/**
 * Each capture `event` MUST match a deployed demo journey trigger (t.hogsend.com);
 * the `email` action POSTs the signed-up address to /api/sample, which the
 * dogfood `sampleRequest` journey turns into a real "[Sample]" email.
 */
const ACTIONS: readonly DemoAction[] = [
  {
    event: "demo.welcome",
    label: "Send me a welcome",
    channels: ["in_app", "email"],
    live: "in_app",
    kind: "capture",
  },
  {
    event: "demo.launch_announcement",
    label: "Launch announcement",
    channels: ["in_app", "email", "discord"],
    live: "in_app",
    kind: "capture",
  },
  {
    event: "demo.trial_ending",
    label: "Trial-ending nudge",
    channels: ["in_app", "email"],
    live: "in_app",
    kind: "capture",
  },
  {
    event: "demo.survey",
    label: "In-app survey",
    channels: ["in_app"],
    live: "in_app",
    kind: "capture",
  },
  {
    event: "demo.email",
    label: "Email me a sample",
    channels: ["email"],
    live: "email",
    kind: "email",
  },
] as const;

/** The four beats of a fire, as a compact pipeline: chip labels on one row,
 * one narration line below that swaps as the run advances. Replaces the old
 * four-item numbered list (same facts, a third of the height). */
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

/** Per-action channel chips. The action's `live` channel reads as crimzon and
 *  pulses when this row just landed; the rest are muted "also wired" hints. */
function ChannelChips({
  channels,
  live,
  landed,
}: {
  channels: readonly Channel[];
  live: Channel;
  landed: boolean;
}) {
  return (
    <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {channels.map((channel) => {
        const { label, Icon } = CHANNEL_META[channel];
        const isLive = channel === live;
        return (
          <span
            key={channel}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-medium text-[10px] leading-none",
              isLive
                ? "border-accent/40 bg-accent/10 text-accent"
                : "border-white/10 bg-white/[0.03] text-white/45",
              isLive && landed && "animate-pulse",
            )}
          >
            <Icon className="size-2.5" strokeWidth={2} aria-hidden="true" />
            {label}
          </span>
        );
      })}
    </span>
  );
}

export function InAppDemoLive({
  signedUp,
  name,
  wide = false,
  onFire,
}: {
  signedUp: boolean;
  name?: string;
  /** Full-width two-up layout for the identified state (no sign-up sibling). */
  wide?: boolean;
  /** Notify the parent which event was just fired so the trace band replays. */
  onFire?: (event: string) => void;
}) {
  const { client, capture } = useHogsend();
  const { refetch, metadata } = useHogsendFeed();
  const [step, setStep] = useState(-1);
  const [firing, setFiring] = useState<string | null>(null);
  // The event whose item most recently landed — drives the "bell rang ↗" / "sent
  // ✓" cue and the live-chip pulse for ~2.6s, then clears.
  const [landed, setLanded] = useState<string | null>(null);
  // The address the sample email went to — persists the inbox card's "sent"
  // row for the session (unlike `landed`, which clears after the pulse).
  const [sampleSentTo, setSampleSentTo] = useState<string | null>(null);

  async function fire(event: string) {
    if (!signedUp || firing !== null) return;
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
      // that here so the payoff reads even with the bell scrolled out of view.
      setLanded(event);
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
    let email = "";
    try {
      email = window.localStorage.getItem(EMAIL_KEY) ?? "";
    } catch {
      // storage blocked — can't send without the verified address
    }
    if (!email) return;
    onFire?.("demo.email");
    setFiring("demo.email");
    try {
      const res = await fetch("/api/sample", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          template: "activation/welcome",
          ...(name ? { name } : {}),
        }),
      });
      if (res.ok) {
        setLanded("demo.email");
        setSampleSentTo(email);
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
      <p className="mt-3 text-[12px] text-white/40 leading-5">
        It&rsquo;s not just notifications: the same trigger fans out across
        channels. <span className="text-white/60">Email me a sample</span> sends
        a real email from hello@hogsend.com, the bell rings here, and{" "}
        <span className="text-white/60">linking Discord</span> lands a
        cross-channel item in this exact bell — one journey, one identity.
      </p>
    </div>
  );

  const actions = (
    <div className="flex flex-col gap-2 border-white/[0.08] border-b p-6">
      {signedUp ? null : (
        <p className="mb-1 text-[12px] text-white/40 leading-5">
          Sign up on the left to fire real lifecycle messages.
        </p>
      )}
      {ACTIONS.map((action) => {
        const isEmail = action.kind === "email";
        return (
          <button
            key={action.event}
            type="button"
            disabled={firing !== null || !signedUp}
            onClick={() => (isEmail ? fireEmail() : fire(action.event))}
            className={cn(
              "group inline-flex items-center justify-between gap-2 rounded-[10px] border px-4 py-3 text-left text-sm transition-colors",
              "border-white/[0.08] bg-white/[0.04] text-white hover:border-white/15 hover:bg-white/[0.06]",
              "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-white/[0.08] disabled:hover:bg-white/[0.04]",
              // Glow the two payoff actions once unlocked: the in-app welcome and
              // the real email send.
              signedUp &&
                (action.event === "demo.welcome" || isEmail) &&
                "border-accent/70 bg-accent/[0.08] shadow-[0_0_22px_-2px_rgba(246,72,56,0.55)] hover:border-accent",
            )}
          >
            <span className="flex min-w-0 flex-col">
              <span className="font-medium">{action.label}</span>
              <span className="truncate font-mono text-[11px] text-white/35">
                {isEmail
                  ? "POST /api/sample → sendEmail()"
                  : `capture("${action.event}"${name ? `, { name: "${name}" }` : ""})`}
              </span>
              <ChannelChips
                channels={action.channels}
                live={action.live}
                landed={landed === action.event}
              />
            </span>
            {landed === action.event ? (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-1 font-medium text-[11px] text-accent">
                {isEmail ? (
                  <>
                    <Mail className="size-3" strokeWidth={2} />
                    Sent ✓
                  </>
                ) : (
                  <>
                    <Bell className="size-3" strokeWidth={2} />
                    Bell rang ↗
                  </>
                )}
              </span>
            ) : (
              <ArrowRight
                aria-hidden="true"
                className="size-4 shrink-0 text-white/40 transition-transform group-hover:translate-x-0.5"
                strokeWidth={1.5}
              />
            )}
          </button>
        );
      })}
      <p className="mt-1 text-[11px] text-white/35 leading-5">
        <span className="text-accent">●</span> the live channel fires now ·{" "}
        <span className="text-white/45">○</span> the same trigger also fans out
        to these in the dogfood.{" "}
        <span className="text-white/55">Email me a sample</span> lands a real
        email in your inbox.
      </p>
    </div>
  );

  const feed = (
    <div className="border-white/[0.08] border-b p-6">
      <p className="mb-3 text-[12px] text-white/40 leading-5">
        Your in-app feed — items land here in real time:
      </p>
      <NotificationFeed feedId="in_app" aria-label="In-app demo feed" />
    </div>
  );

  const discord = (
    <div className="border-white/[0.08] border-b p-6">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="kicker block">Go cross-channel</span>
        <PillBadge>
          <MessageCircle className="size-3.5" strokeWidth={1.5} />
          Discord
        </PillBadge>
      </div>
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
    </div>
  );

  // The email payoff, made visible: a small inbox mock that fills in as real
  // sends land. Row one is the welcome series the sign-up itself triggered;
  // row two lights up when "Email me a sample" actually sends.
  const inbox = (
    <div className="border-white/[0.08] border-b p-6">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="kicker block">Your inbox</span>
        <PillBadge>
          <Mail className="size-3.5" strokeWidth={1.5} />
          Real email
        </PillBadge>
      </div>
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
        Both are React Email templates from the scaffold — 13 ship with
        create-hogsend.{" "}
        <a href="/emails" className="text-white/60 hover:text-white">
          See them all →
        </a>
      </p>
    </div>
  );

  const narration = (
    <div className="p-6" role="status" aria-live="polite">
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
      <p className="mt-2 text-[12px] text-white/35 leading-5">
        Unread:{" "}
        <span className="font-mono text-accent tabular-nums">
          {metadata.unread_count ?? 0}
        </span>
        . Clicking a row emits{" "}
        <code className="font-mono text-white/55">inapp.item_clicked</code> and
        a <code className="font-mono text-white/55">link.clicked</code> — real
        first-party events a journey can react to.
      </p>
    </div>
  );

  // Wide (identified, full-width): two-up — controls | inbox + feed. The
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
          {feed}
          {inbox}
          {discord}
        </Card>
      </div>
    );
  }

  // Narrow (paired with the sign-up column): the original single stacked card.
  return (
    <Card className="flex flex-col p-0 [&>div:last-child]:border-b-0">
      {header}
      {actions}
      {feed}
      {inbox}
      {discord}
      {narration}
    </Card>
  );
}
