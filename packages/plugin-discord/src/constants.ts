/**
 * Discord integration constants — the provider id (keys both the inbound
 * connector and the outbound destination so they read as one integration),
 * the Gateway intent bitfield, the two OAuth scope sets, and the API base.
 * Pure data, zero `discord.js` — safe to import from the engine API process.
 */

export const DISCORD_PROVIDER_ID = "discord" as const;

/**
 * Gateway intent bits (`<< n` matches Discord's documented bitfield). The three
 * marked `privileged` must be toggled ON in the Developer Portal AND requested
 * here; without them the Gateway connection is rejected.
 */
export const DISCORD_INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1, // privileged
  GUILD_PRESENCES: 1 << 8, // privileged
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  MESSAGE_CONTENT: 1 << 15, // privileged
} as const;

/** Scopes for the one-click BOT INSTALL (adds the bot to a guild). */
export const DISCORD_BOT_INSTALL_SCOPES = [
  "bot",
  "applications.commands",
] as const;

/** Scopes for the PER-MEMBER LINK (identify + verified email + membership). */
export const DISCORD_MEMBER_LINK_SCOPES = [
  "identify",
  "email",
  "guilds.members.read",
] as const;

export const DISCORD_API_BASE = "https://discord.com/api/v10";

/** Discord's authorize endpoint — where bot-install / member-link links point. */
export const DISCORD_OAUTH_AUTHORIZE_URL =
  "https://discord.com/api/oauth2/authorize";

/** Discord's token endpoint — where the authorization code is exchanged. */
export const DISCORD_OAUTH_TOKEN_URL = "https://discord.com/api/oauth2/token";

/** Discord's PUBLIC epoch (ms) — snowflakes encode (ms - this) in bits 22+. */
export const DISCORD_EPOCH = 1420070400000n;
