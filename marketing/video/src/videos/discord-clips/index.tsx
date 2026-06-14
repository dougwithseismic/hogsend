import type React from "react";
import { defineVideo, type VideoConfig } from "../../lib/define-video";
import {
  type ClipSpec,
  clipDuration,
  JourneyClip,
} from "../journey-clips/trace";

// ---------------------------------------------------------------------------
// Embeddable Discord clips — bare trace runs of the REAL Discord recipes
// (apps/docs/content/docs/recipes/{welcome-new-discord-members,
// link-discord-to-email}), trimmed for the frame. Same engine, brand and
// motion as the journey-clips family: real recipe code on the left, the run
// executing on the right. No hooks, no end cards — they loop inside the
// /discord landing-page sections.
// ---------------------------------------------------------------------------

const SPECS: ClipSpec[] = [
  // welcome-new-discord-members.ts — a member joins as a snowflake with no
  // email; the journey parks on the link event, then welcomes the instant
  // the contact resolves.
  {
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

  // link-discord-to-email — the in-Discord /link modal loop: a single-use
  // 6-digit code emailed, verified back inside Discord, then the email folds
  // onto the discord_id so they become one contact.
  {
    id: "discord-link",
    file: "src/discord.ts",
    code: `// member runs /link inside Discord
createDiscordConnector({
  // mint a single-use 6-digit code...
  mintCode: createLinkCode,

  // ...mail it as a transactional send
  sendLinkCode: async ({ email, code }) => {
    await getEmailService().send({
      template: "transactional/discord-link-code",
      to: email,
    });
  },

  // /verify <code> or the "Enter code" button
  // ⟦folds the email onto the discord_id⟧
  redeemCode: redeemLinkCode,
});`,
    steps: [
      {
        kind: "event",
        event: "discord.link_requested",
        who: "@member",
        band: [1, 1],
      },
      {
        kind: "send",
        subject: "Your Discord verification code: 418-203",
        band: [7, 1],
      },
      {
        kind: "wait",
        event: "code.verified",
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
];

const makeClip = (spec: ClipSpec): VideoConfig => {
  const Clip: React.FC = () => <JourneyClip spec={spec} />;
  return defineVideo({
    id: spec.id,
    durationInFrames: clipDuration(spec.steps),
    fps: 30,
    component: Clip,
  });
};

export const DISCORD_CLIPS: VideoConfig[] = SPECS.map(makeClip);
