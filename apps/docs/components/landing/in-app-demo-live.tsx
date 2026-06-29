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
import { PillBadge, TagPill } from "@/components/ds/badge";
import { Card } from "@/components/ds/card";
import { AnalyticsEvent, capture as trackEvent } from "@/lib/analytics";
import { cn } from "@/lib/cn";
import { DISCORD_INVITE_URL } from "@/lib/site";

/**
 * The in-app half of the home live demo. Gated on the sign-up in the sibling
 * column (`InAppDemoBody` lifts `signedUp` + `name` from the qualifier/email
 * form) — NOT anonymous: you fire real lifecycle events only once you've signed
 * up, and the events carry the name you gave. The feed still renders the
 * recipient-scoped `in_app` feed (the same one the nav bell polls).
 *
 * Not "just notifications": each scenario shows the channel fan-out a real
 * journey of that shape drives (the bell lands live here; the same trigger also
 * emails + posts to Discord in the dogfood). The Discord step below is the
 * cross-channel payoff — link your account and a notification lands in this
 * exact bell, one identity across web and Discord.
 *
 * Only rendered when `isHogsendConfigured`, so `useHogsend` always has context.
 */

/** The channels a journey can fan out to — drives the per-action chips. */
type Channel = "in_app" | "email" | "discord";

const CHANNEL_META: Record<Channel, { label: string; Icon: LucideIcon }> = {
  in_app: { label: "In-app", Icon: Bell },
  email: { label: "Email", Icon: Mail },
  discord: { label: "Discord", Icon: MessageCircle },
};

/**
 * Each `event` MUST match a deployed demo journey trigger (t.hogsend.com).
 * `channels` is the fan-out a production journey of this shape drives: `in_app`
 * lands live in this demo; the others are wired in the dogfood (the welcome
 * email already hit your inbox at sign-up; Discord unlocks in the step below).
 */
const ACTIONS: readonly {
  event: string;
  label: string;
  hint: string;
  channels: readonly Channel[];
}[] = [
  {
    event: "demo.welcome",
    label: "Send me a welcome",
    hint: "personalized onboarding item",
    channels: ["in_app", "email"],
  },
  {
    event: "demo.launch_announcement",
    label: "Launch announcement",
    hint: "broadcast-style item with a link",
    channels: ["in_app", "email", "discord"],
  },
  {
    event: "demo.trial_ending",
    label: "Trial-ending nudge",
    hint: "lifecycle nudge with a CTA",
    channels: ["in_app", "email"],
  },
  {
    event: "demo.survey",
    label: "In-app survey",
    hint: "an NPS card you answer in the feed",
    channels: ["in_app"],
  },
] as const;

const STEPS = [
  "You fired a first-party event (source: inapp) keyed to your id.",
  "The engine resolved your id to a canonical contact key and routed it.",
  "A journey triggered on the event, read your name, and called sendFeedItem.",
  "Your bell rang ↗ and it landed in the feed below — the same feed the nav bell polls.",
] as const;

/** Per-action channel chips. The live channel (`in_app`) reads as crimzon and
 *  pulses when this row just landed; the rest are muted "also wired" capability
 *  hints so nobody reads them as "this click sent an email". */
function ChannelChips({
  channels,
  landed,
}: {
  channels: readonly Channel[];
  landed: boolean;
}) {
  return (
    <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {channels.map((channel) => {
        const { label, Icon } = CHANNEL_META[channel];
        const live = channel === "in_app";
        return (
          <span
            key={channel}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-medium text-[10px] leading-none",
              live
                ? "border-accent/40 bg-accent/10 text-accent"
                : "border-white/10 bg-white/[0.03] text-white/45",
              live && landed && "animate-pulse",
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
}: {
  signedUp: boolean;
  name?: string;
}) {
  const { client, capture } = useHogsend();
  const { refetch, metadata } = useHogsendFeed();
  const [step, setStep] = useState(-1);
  const [firing, setFiring] = useState<string | null>(null);
  // The event whose item most recently landed — drives the "bell rang ↗" cue
  // and the live-chip pulse for ~2.6s, then clears.
  const [landed, setLanded] = useState<string | null>(null);

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
          …then fire an event, watch your bell ring ↗
        </h3>
        <p className="mt-1.5 text-sm text-white/55 leading-6">
          {signedUp
            ? `You're in${name ? `, ${name}` : ""} — fire a real lifecycle event and a journey turns it into a notification. Your bell ↗ in the top nav rings, and the item drops into the feed below.`
            : "Sign up on the left, then fire a real lifecycle event — a journey turns it into a notification. The bell ↗ in the top nav rings, and the item lands here in the feed."}
        </p>
        <p className="mt-3 text-[12px] text-white/40 leading-5">
          It&rsquo;s not just notifications: the same trigger fans out across
          channels. The welcome email already hit your inbox at sign-up, the
          bell rings here, and{" "}
          <span className="text-white/60">linking Discord</span> below lands a
          cross-channel item in this exact bell — one journey, one identity.
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
              "group inline-flex items-center justify-between gap-2 rounded-[10px] border px-4 py-3 text-left text-sm transition-colors",
              "border-white/[0.08] bg-white/[0.04] text-white hover:border-white/15 hover:bg-white/[0.06]",
              "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-white/[0.08] disabled:hover:bg-white/[0.04]",
              // Once signed up, glow the primary action — draws the eye to the
              // now-unlocked in-app loop.
              signedUp &&
                action.event === "demo.welcome" &&
                "border-accent/70 bg-accent/[0.08] shadow-[0_0_22px_-2px_rgba(246,72,56,0.55)] hover:border-accent",
            )}
          >
            <span className="flex min-w-0 flex-col">
              <span className="font-medium">{action.label}</span>
              <span className="truncate font-mono text-[11px] text-white/35">
                capture("{action.event}"{name ? `, { name: "${name}" }` : ""})
              </span>
              <ChannelChips
                channels={action.channels}
                landed={landed === action.event}
              />
            </span>
            {landed === action.event ? (
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
        ))}
        <p className="mt-1 text-[11px] text-white/35 leading-5">
          <span className="text-accent">●</span> lands in your bell now ·{" "}
          <span className="text-white/45">○</span> the same trigger also fans
          out to these in the dogfood (email + Discord).
        </p>
      </div>

      {/* zone 3 — the inline feed (the payoff) */}
      <div className="border-white/[0.08] border-b p-6">
        <p className="mb-3 text-[12px] text-white/40 leading-5">
          Your in-app feed — items land here in real time:
        </p>
        <NotificationFeed feedId="in_app" aria-label="In-app demo feed" />
      </div>

      {/* zone 4 — cross-channel: link Discord (the "best in class" payoff) */}
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
          matches the email you signed up with, grants your role, and drops a
          “You linked your Discord” item into{" "}
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
          Then type <code className="font-mono text-white/55">/link</code> in
          any channel.{" "}
          {signedUp ? null : "Sign up first so /link can match your email."}
        </p>
      </div>

      {/* zone 5 — live narration */}
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
