import { days } from "@hogsend/core";
import { defineJourney, sendConnectorAction } from "@hogsend/engine";
import {
  DISCORD_REACTION_RECEIVED,
  DiscordEvents,
} from "@hogsend/plugin-discord";
import {
  DISTINCT_PEOPLE_THRESHOLD,
  DiscordGamification,
  RoleGranted,
} from "./constants/discord.js";

/**
 * FEATURE B demo — community gamification driven by inbound Discord engagement
 * events. Each journey counts an engagement signal and grants a role + DMs the
 * member (the "Relay to PostHog Slack" screenshot, in your repo as TypeScript).
 * Role/channel ids come from env (`constants/discord.ts`); an unconfigured id
 * makes `grantRole` soft-fail, so a deploy without ids is inert, not broken.
 */

interface GrantResult {
  granted?: boolean;
}

/** Grant a role then DM the recipient (only when the grant succeeded). */
async function grantAndAnnounce(opts: {
  member: string;
  guildId: string;
  roleId: string;
  dm: string;
}): Promise<boolean> {
  if (!opts.guildId || !opts.roleId) return false;
  const res = (await sendConnectorAction({
    connectorId: "discord",
    action: "grantRole",
    args: { guildId: opts.guildId, member: opts.member, roleId: opts.roleId },
  })) as GrantResult;
  if (res?.granted) {
    await sendConnectorAction({
      connectorId: "discord",
      action: "dmMember",
      args: { member: opts.member, content: opts.dm },
    });
  }
  return Boolean(res?.granted);
}

/** The guild id rides on every inbound Discord event's properties. */
function guildIdOf(user: {
  properties: Record<string, string | number | boolean | null>;
}): string {
  return user.properties.guildId ? String(user.properties.guildId) : "";
}

/** 👋 Hello world — first message. */
export const discordHelloWorld = defineJourney({
  meta: {
    id: "discord-hello-world",
    name: "Discord — Hello world (first message)",
    enabled: true,
    trigger: { event: DiscordEvents.MESSAGE_CREATE },
    entryLimit: "once",
    suppress: days(0),
  },
  run: async (user) => {
    await grantAndAnnounce({
      member: user.id,
      guildId: guildIdOf(user),
      roleId: DiscordGamification.roles.HELLO_WORLD,
      dm: "🎉 You just earned the 👋 Hello world role for sending your first message!",
    });
  },
});

/** 🪪 Introduced — posted in #intros. */
export const discordIntroduced = defineJourney({
  meta: {
    id: "discord-introduced",
    name: "Discord — Introduced (intro)",
    enabled: true,
    trigger: {
      event: DiscordEvents.MESSAGE_CREATE,
      where: (b) =>
        b.prop("channelId").eq(DiscordGamification.INTROS_CHANNEL_ID),
    },
    entryLimit: "once",
    suppress: days(0),
  },
  run: async (user) => {
    if (!DiscordGamification.INTROS_CHANNEL_ID) return;
    await grantAndAnnounce({
      member: user.id,
      guildId: guildIdOf(user),
      roleId: DiscordGamification.roles.INTRODUCED,
      dm: "🎉 You just earned the 🪪 Introduced role for introducing yourself to the community!",
    });
  },
});

/** 🌟 Resonator — your post got reactions from N DIFFERENT people. */
export const discordResonator = defineJourney({
  meta: {
    id: "discord-resonator",
    name: "Discord — Resonator (post resonated)",
    enabled: true,
    // UNLIMITED: every reaction received re-enrolls + re-counts; "once" would
    // block the count from ever reaching the threshold.
    trigger: { event: DISCORD_REACTION_RECEIVED },
    entryLimit: "unlimited",
    suppress: days(0),
  },
  run: async (user, ctx) => {
    const evs = await ctx.history.events({
      userId: user.id,
      event: DISCORD_REACTION_RECEIVED,
      within: days(90),
      limit: 500,
    });
    // Distinct PEOPLE, not raw reactions: a Set over the reactor's contact key.
    const people = new Set(
      evs
        .map((e) => e.properties?.reactorKey)
        .filter((k): k is string => typeof k === "string"),
    );
    if (people.size < DISTINCT_PEOPLE_THRESHOLD) return;

    // DM exactly once even though re-counts keep re-enrolling.
    const already = await ctx.history.hasEvent({
      userId: user.id,
      event: RoleGranted.RESONATOR,
    });
    if (already.found) return;

    // Use the author's raw snowflake (on the event) — `resolveDiscordId` maps an
    // all-digit ref straight to a snowflake, so grant/DM fire even if this author
    // has no contact yet (a cold-created author has a UUID subject key that can't
    // be mapped back to Discord).
    const member = user.properties.authorId
      ? String(user.properties.authorId)
      : user.id;
    const granted = await grantAndAnnounce({
      member,
      guildId: guildIdOf(user),
      roleId: DiscordGamification.roles.RESONATOR,
      dm: "🎉 You just earned the 🌟 Resonator role because your post resonated with 5+ people!",
    });
    if (granted) {
      await ctx.trigger({ event: RoleGranted.RESONATOR, userId: user.id });
    }
  },
});

/** ❤️ Hype hog — you reacted to N DIFFERENT people's posts. */
export const discordHypeHog = defineJourney({
  meta: {
    id: "discord-hype-hog",
    name: "Discord — Hype hog (spread the love)",
    enabled: true,
    trigger: { event: DiscordEvents.MESSAGE_REACTION_ADD },
    entryLimit: "unlimited",
    suppress: days(0),
  },
  run: async (user, ctx) => {
    const evs = await ctx.history.events({
      userId: user.id,
      event: DiscordEvents.MESSAGE_REACTION_ADD,
      within: days(90),
      limit: 500,
    });
    // Distinct AUTHORS reacted to (needs the gateway's cache author enrichment;
    // a reaction whose author wasn't resolved carries a null key and doesn't
    // count — documented best-effort).
    const people = new Set(
      evs
        .map((e) => e.properties?.targetAuthorKey)
        .filter((k): k is string => typeof k === "string"),
    );
    if (people.size < DISTINCT_PEOPLE_THRESHOLD) return;

    const already = await ctx.history.hasEvent({
      userId: user.id,
      event: RoleGranted.HYPE_HOG,
    });
    if (already.found) return;

    const granted = await grantAndAnnounce({
      member: user.id,
      guildId: guildIdOf(user),
      roleId: DiscordGamification.roles.HYPE_HOG,
      dm: "🎉 You just earned the ❤️ Hype hog role for spreading the love to 5 different people's posts!",
    });
    if (granted) {
      await ctx.trigger({ event: RoleGranted.HYPE_HOG, userId: user.id });
    }
  },
});
