import { days } from "@hogsend/core";
import { defineJourney, sendConnectorAction } from "@hogsend/engine";
import { DiscordEvents } from "@hogsend/plugin-discord";
import { DiscordLifecycle } from "./constants/discord.js";
import { Events } from "./constants/index.js";

/**
 * The Stranger → Piglet → Hog member lifecycle.
 *  - JOIN (unlinked) → 🧍 Stranger + a nudge to run /link.
 *  - /link (verified, `discord.linked`) → drop Stranger, grant 🐷 Piglet, then a
 *    durable 7-day wait; once they've been a Piglet 7 days AND sent a message
 *    (in either order), drop Piglet and grant 🐗 Hog.
 *
 * Role ids come from env; empty ids make grant/removeRole soft-fail, so an
 * unconfigured deploy is inert, not broken. The /link gate role (Community) is
 * granted separately by cold-connect and is untouched here.
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

/** Remove a role, ignoring the result (idempotent; soft-fails). No-op on empty ids. */
async function removeAndForget(opts: {
  member: string;
  guildId: string;
  roleId: string;
}): Promise<void> {
  if (!opts.guildId || !opts.roleId) return;
  await sendConnectorAction({
    connectorId: "discord",
    action: "removeRole",
    args: { guildId: opts.guildId, member: opts.member, roleId: opts.roleId },
  });
}

/** Guild id rides on member_joined event properties. */
function guildIdOf(user: {
  properties: Record<string, string | number | boolean | null>;
}): string {
  return user.properties.guildId ? String(user.properties.guildId) : "";
}

/** 🧍 Stranger — joined the server but not yet `/link`-verified. */
export const discordStranger = defineJourney({
  meta: {
    id: "discord-stranger",
    name: "Discord — Stranger (joined, unlinked)",
    enabled: true,
    trigger: { event: DiscordEvents.GUILD_MEMBER_ADD },
    entryLimit: "once",
    suppress: days(0),
  },
  run: async (user) => {
    await grantAndAnnounce({
      // Actor snowflake off the event so the grant/DM fires pre-link (an
      // unlinked member's discord contact is anonymous, `user.id` is a UUID).
      member: String(user.properties.memberId ?? user.id),
      guildId: guildIdOf(user),
      roleId: DiscordLifecycle.STRANGER,
      dm: "👋 Welcome! You're a **Stranger** for now — run **/link** in the server to verify your email and join the sounder.",
    });
  },
});

/** 🐷 Piglet → 🐗 Hog — linked, then 7 days + a message graduates you. */
export const discordPiglet = defineJourney({
  meta: {
    id: "discord-piglet",
    name: "Discord — Piglet → Hog (linked)",
    enabled: true,
    trigger: { event: Events.DISCORD_LINKED },
    entryLimit: "once",
    suppress: days(1),
  },
  run: async (user, ctx) => {
    // `discord.linked` carries the snowflake in properties (the journey subject
    // is the resolved contact key, not the snowflake) and NO guildId — so the
    // member ref is the snowflake and the guild comes from env.
    const snowflake =
      typeof user.properties.discordId === "string"
        ? user.properties.discordId
        : undefined;
    if (!snowflake) return;
    const guildId = process.env.DISCORD_GUILD_ID ?? "";
    if (!guildId) return;

    // Promote: drop Stranger (idempotent), grant Piglet + DM.
    await removeAndForget({
      member: snowflake,
      guildId,
      roleId: DiscordLifecycle.STRANGER,
    });
    const piglet = await grantAndAnnounce({
      member: snowflake,
      guildId,
      roleId: DiscordLifecycle.PIGLET,
      dm: "✅ Verified — welcome, **Piglet** 🐷! Post a message and stick around 7 days to grow into a **Hog** 🐗.",
    });
    if (!piglet) return;

    // Graduate to Hog: 7-day tenure AND ≥1 message, in either order. Sleep the
    // tenure first (durable), then if they haven't posted yet, wait for their
    // first message (bounded so the whole run stays under the 30-day limit).
    ctx.checkpoint("piglet:tenure");
    await ctx.sleep({ duration: days(7), label: "piglet-to-hog" });
    let posted = (
      await ctx.history.hasEvent({
        userId: user.id,
        event: DiscordEvents.MESSAGE_CREATE,
      })
    ).found;
    if (!posted) {
      const msg = await ctx.waitForEvent({
        event: DiscordEvents.MESSAGE_CREATE,
        timeout: days(21),
      });
      posted = !msg.timedOut;
    }
    if (!posted) return; // a silent member stays a Piglet

    await removeAndForget({
      member: snowflake,
      guildId,
      roleId: DiscordLifecycle.PIGLET,
    });
    await grantAndAnnounce({
      member: snowflake,
      guildId,
      roleId: DiscordLifecycle.HOG,
      dm: "🎉 You've grown into a **Hog** 🐗 — a week in and part of the sounder. Welcome to the family.",
    });
  },
});
