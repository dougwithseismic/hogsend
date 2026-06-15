import type React from "react";
import { defineVideo, type VideoConfig } from "../../lib/define-video";
import {
  type ClipSpec,
  clipDuration,
  JourneyClip,
} from "../journey-clips/trace";

// ---------------------------------------------------------------------------
// discord-presence — a member's Discord activity becomes PostHog events on
// the SAME person. A bare trace run of the real presence recipe: the journey
// code on the left, the run executing on the right. Same engine, brand and
// motion as the journey-clips / discord-clips families — no hooks, no end
// card, so it loops inside a landing-page section.
//
// Story: join → identify + set discord_id (→ PostHog) → message posted
// (→ PostHog last-active) → sleep 14d → check if gone quiet → re-engage
// send + fan the "went dormant" signal back to PostHog.
// ---------------------------------------------------------------------------

const SPEC: ClipSpec = {
  id: "discord-presence",
  file: "src/journeys/discord-presence.ts",
  code: `export const discordPresence = defineJourney({
  meta: {
    trigger: { event: Events.DISCORD_MEMBER_JOINED },
    entryLimit: "once",
  },
  run: async (user, ctx) => {
    // Their Discord identity becomes one PostHog person.
    getPostHog()?.⟦identify⟧({
      distinctId: user.id,
      properties: { discord_id: user.discordId },
    });

    // Activity keeps last_active_at fresh on that same person.
    const posted = await ctx.waitForEvent({
      event: Events.DISCORD_MESSAGE_POSTED,
      timeout: days(14),
    });

    // Gone quiet? Re-engage, and mark them dormant in PostHog.
    if (posted.timedOut && !(await ctx.history.hasEvent({
      userId: user.id,
      event: Events.DISCORD_MESSAGE_POSTED,
      within: days(14),
    })).found) {
      await sendEmail({ template: "discord/re-engage" });
      getPostHog()?.capture({ event: "discord_dormant" });
    }
  },
});`,
  steps: [
    // 1. A member joins your server.
    {
      kind: "event",
      event: "discord.member_joined",
      who: "@newcomer",
      band: [2, 1],
    },
    // 2. Identify the person + set discord_id, sent to PostHog.
    {
      kind: "fanout",
      label: "identify",
      events: ["distinct_id", "discord_id"],
      dest: "PostHog",
      logo: "posthog.svg",
      band: [7, 4],
    },
    // 3. They post a message → fan last-active to PostHog.
    {
      kind: "event",
      event: "discord.message_posted",
      who: "@newcomer",
      band: [15, 1],
    },
    {
      kind: "fanout",
      label: "emit",
      events: ["last_active_at"],
      dest: "PostHog",
      logo: "posthog.svg",
      band: [15, 4],
    },
    // 4. Sleep ~14 days, then check: have they gone quiet?
    {
      kind: "sleep",
      label: "14 days",
      days: 14,
      band: [22, 4],
    },
    {
      kind: "check",
      question: "ctx.history.hasEvent",
      sub: "discord.message_posted",
      candidates: ["joined", "linked", "message_posted"],
      verdict: "found: false",
      band: [30, 5],
    },
    // 5. Re-engage send + fan the "went dormant" signal to PostHog.
    {
      kind: "send",
      subject: "We miss you in the community — here's what's new",
      clicked: true,
      accent: true,
      band: [37, 1],
    },
    {
      kind: "fanout",
      label: "emit",
      events: ["discord_dormant"],
      dest: "PostHog",
      logo: "posthog.svg",
      band: [38, 1],
    },
  ],
};

const makeClip = (spec: ClipSpec): VideoConfig => {
  const Clip: React.FC = () => <JourneyClip spec={spec} />;
  return defineVideo({
    id: spec.id,
    durationInFrames: clipDuration(spec.steps),
    fps: 30,
    component: Clip,
  });
};

export const video: VideoConfig = makeClip(SPEC);
export const DISCORD_PRESENCE_CLIPS: VideoConfig[] = [video];
