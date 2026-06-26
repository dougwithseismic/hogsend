/**
 * Journey-trace clip data — ported VERBATIM from the Remotion sources:
 *   - marketing/video/src/videos/journey-clips/index.tsx
 *     ("journey-onboarding", "journey-winback", "journey-checkout",
 *      "journey-posthog")
 *   - marketing/video/src/videos/discord-presence/index.tsx
 *     ("discord-presence")
 *   - marketing/video/src/videos/discord-clips/index.tsx
 *     ("discord-welcome", "discord-link")
 *
 * Bare trace runs of the REAL dogfood journeys/recipes, trimmed for the
 * frame: real journey code on the left, the run executing on the right. The
 * `⟦⟧` emphasis markers are preserved exactly. Keyed by clip id.
 */

import type { ClipSpec } from "@/components/clips/clip-types";

export const CLIP_SPECS: Record<string, ClipSpec> = {
  // The full onboarding journey from the use-case page — every mechanic
  // in one run: send, engine fan-out, a durable wait that RESOLVES,
  // branch on the answer, person write-back.
  "journey-onboarding": {
    id: "journey-onboarding",
    file: "src/journeys/onboarding.ts",
    code: `export const onboarding = defineJourney({
  meta: { trigger: { event: Events.USER_SIGNED_UP } },
  run: async (user, ctx) => {
    await sendEmail({ template: "quickstart" });

    const { timedOut } = await ctx.waitForEvent({
      event: Events.PROJECT_CREATED,
      timeout: days(3),
    });

    await sendEmail({
      template: timedOut
        ? "activation-nudge"
        : "feature-highlight",
    });

    getPostHog()?.identify(user.id, { activated: true });
  },
});`,
    steps: [
      { kind: "event", event: "user.signed_up", band: [1, 1] },
      {
        kind: "send",
        subject: "Welcome — your shortest path to a first win",
        band: [3, 1],
      },
      {
        kind: "fanout",
        events: ["email.delivered", "email.opened"],
        band: [3, 1],
      },
      {
        kind: "wait",
        event: "project.created",
        timeout: "3d",
        resolve: "arrived · 41h",
        band: [5, 4],
      },
      {
        kind: "send",
        subject: "Nice — here's what to try next",
        clicked: true,
        accent: true,
        band: [10, 5],
      },
      {
        kind: "fanout",
        label: "identify",
        events: ["activated: true"],
        band: [16, 1],
      },
    ],
  },

  // reactivation-dormancy.ts — win-back, offer picked off a person property.
  "journey-winback": {
    id: "journey-winback",
    file: "src/journeys/winback.ts",
    code: `export const winback = defineJourney({
  meta: { trigger: { event: Events.USER_DORMANCY_DETECTED } },
  run: async (user, ctx) => {
    await sendEmail({ template: "we-miss-you" });

    await ctx.sleep({ duration: days(7) });

    const paid = user.properties.plan === "paid";
    await sendEmail({
      template: paid
        ? "winback-offer"
        : "whats-new",
    });
  },
});`,
    steps: [
      { kind: "event", event: "user.dormancy_detected", band: [1, 1] },
      {
        kind: "send",
        subject: "We haven't seen you in a while",
        band: [3, 1],
      },
      { kind: "sleep", label: "7 days", band: [5, 1] },
      {
        kind: "check",
        question: "user.plan",
        verdict: 'plan: "paid"',
        band: [7, 1],
      },
      {
        kind: "send",
        subject: "We'd hate to see you go — here's an option",
        clicked: true,
        accent: true,
        band: [8, 5],
      },
    ],
  },

  // conversion-abandoned-checkout.ts — nudge only if they didn't finish.
  "journey-checkout": {
    id: "journey-checkout",
    file: "src/journeys/abandoned-checkout.ts",
    code: `export const checkout = defineJourney({
  meta: { trigger: { event: Events.CHECKOUT_ABANDONED } },
  run: async (user, ctx) => {
    await ctx.sleep({ duration: hours(2) });

    const { found } = await ctx.history.hasEvent({
      event: Events.CHECKOUT_COMPLETED,
      within: hours(2),
    });
    if (found) return;

    await sendEmail({ template: "need-help" });
  },
});`,
    steps: [
      { kind: "event", event: "checkout.abandoned", band: [1, 1] },
      { kind: "sleep", label: "2 hours", band: [3, 1] },
      {
        kind: "check",
        question: "checkout_completed",
        sub: "within 2h",
        candidates: ["pricing.viewed", "docs.opened"],
        verdict: "found: false",
        band: [5, 4],
      },
      {
        kind: "send",
        subject: "Need help with anything?",
        clicked: true,
        accent: true,
        band: [11, 1],
      },
    ],
  },

  // feedback-nps.ts — everything fans back out to PostHog: the engine
  // emits the email lifecycle first-party, the journey writes the score
  // back as a person property.
  "journey-posthog": {
    id: "journey-posthog",
    file: "src/journeys/feedback-nps.ts",
    code: `export const survey = defineJourney({
  meta: { trigger: { event: Events.USER_CREATED } },
  run: async (user, ctx) => {
    await sendEmail({ template: "nps-survey" });

    const answer = await ctx.waitForEvent({
      event: Events.NPS_SUBMITTED,
      timeout: days(3),
    });

    const score = answer.properties?.score;
    getPostHog()?.identify(user.id, {
      nps_score: score,
    });
  },
});`,
    steps: [
      { kind: "event", event: "user.created", band: [1, 1] },
      {
        kind: "send",
        subject: "Quick question — how are we doing?",
        band: [3, 1],
      },
      {
        kind: "fanout",
        events: ["email.delivered", "email.opened", "email.link_clicked"],
        band: [3, 1],
      },
      {
        kind: "wait",
        event: "nps.submitted",
        timeout: "3d",
        resolve: "score: 9",
        band: [5, 4],
      },
      {
        kind: "fanout",
        label: "identify",
        events: ["nps_score: 9"],
        band: [11, 3],
      },
    ],
  },

  // discord-presence — a member's Discord activity becomes PostHog events on
  // the SAME person. Join → identify + set discord_id (→ PostHog) → message
  // posted (→ PostHog last-active) → sleep 14d → check if gone quiet →
  // re-engage send + fan the "went dormant" signal back to PostHog.
  "discord-presence": {
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
  },

  // welcome-new-discord-members.ts — a member joins as a snowflake with no
  // email; the journey parks on the link event, then welcomes the instant
  // the contact resolves.
  "discord-welcome": {
    id: "discord-welcome",
    file: "src/journeys/welcome-new-discord-members.ts",
    code: `export const welcomeNewDiscordMembers = defineJourney({
  meta: {
    trigger: { event: Events.DISCORD_MEMBER_JOINED },
    entryLimit: "once",
  },
  run: async (user, ctx) => {
    // A fresh join has a discord_id but no email yet.
    const linked = await ctx.⟦waitForEvent⟧({
      event: Events.CONTACT_LINKED,
      timeout: days(2),
    });

    if (linked.timedOut) {
      await ctx.trigger({ event: Events.DISCORD_NUDGE_LINK });
      return;
    }

    await sendEmail({ template: "discord/welcome" });
  },
});`,
    steps: [
      {
        kind: "event",
        event: "discord.member_joined",
        who: "@newcomer",
        band: [2, 1],
      },
      {
        kind: "wait",
        event: "contact.linked",
        timeout: "2d",
        resolve: "linked · 6m",
        band: [7, 4],
      },
      {
        kind: "send",
        subject: "Welcome to the community — here's where to start",
        clicked: true,
        accent: true,
        band: [17, 1],
      },
    ],
  },

  // link-discord-to-email — the in-Discord /link flow: the member types their
  // email into a private modal, gets a one-click confirm link in their inbox,
  // and clicking it folds the email onto the discord_id so they become one
  // contact (and grants the verified role). No typed code.
  "discord-link": {
    id: "discord-link",
    file: "src/discord.ts",
    code: `// member runs /link inside Discord → an email modal opens
createDiscordConnector({
  // mint a cold-connect token + email a one-click confirm link
  requestConfirm: ({ discordUserId, email }) =>
    discordColdConnect.mintConfirm({
      platformUserId: discordUserId,
      email,
    }),

  // clicking the emailed link ⟦folds discord_id + email onto
  // one contact⟧, grants the verified role, emits discord.linked
});`,
    steps: [
      {
        kind: "event",
        event: "/link",
        who: "@member",
        band: [1, 1],
      },
      {
        kind: "send",
        subject: "Confirm your Discord link — expires in 15 min",
        band: [7, 1],
      },
      {
        kind: "wait",
        event: "discord.linked",
        timeout: "15m",
        resolve: "linked ✓",
        band: [13, 3],
      },
      {
        kind: "fanout",
        label: "merge",
        events: ["discord_id", "email"],
        dest: "one contact",
        logo: "discord.svg",
        band: [15, 1],
      },
    ],
  },
};
