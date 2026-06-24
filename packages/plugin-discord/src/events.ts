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
  MESSAGE_REACTION_REMOVE: "discord.reaction_removed",
  GUILD_MEMBER_ADD: "discord.member_joined",
  PRESENCE_UPDATE: "discord.presence_active",
} as const;

export type DiscordDispatchType = keyof typeof DiscordEvents;
export type DiscordEventName = (typeof DiscordEvents)[DiscordDispatchType];

/**
 * SYNTHETIC fan-out event — the AUTHOR-keyed side of a reaction (the person
 * whose message was reacted to), powering author-side gamification like
 * "your post resonated with N people". It is NOT a raw Discord dispatch, so it
 * is deliberately NOT a key of {@link DiscordEvents} (the gateway forwards only
 * real dispatch types — keeping `Object.keys(DiscordEvents)` 1:1 with
 * forwardable dispatches). The connector synthesizes it as the second element
 * of the `MESSAGE_REACTION_ADD` fan-out.
 */
export const DISCORD_REACTION_RECEIVED = "discord.reaction_received" as const;
