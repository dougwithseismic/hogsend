/**
 * The Discord Gateway dispatch → Hogsend event-name vocabulary. This map is the
 * semver-visible contract: the VALUES are the event names journeys subscribe to
 * and `user_events` stores, so renaming one is a breaking change. The KEYS are
 * Discord's raw dispatch types (the `t` field on a Gateway dispatch frame) the
 * connector branches on.
 */
export const DiscordEvents = {
  MESSAGE_CREATE: "discord.message_sent",
  MESSAGE_REACTION_ADD: "discord.reaction_added",
  GUILD_MEMBER_ADD: "discord.member_joined",
  PRESENCE_UPDATE: "discord.presence_active",
} as const;

export type DiscordDispatchType = keyof typeof DiscordEvents;
export type DiscordEventName = (typeof DiscordEvents)[DiscordDispatchType];
