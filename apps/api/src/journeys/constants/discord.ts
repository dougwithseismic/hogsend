/**
 * Discord community-gamification config for the dogfood journeys. Role ids and
 * the #intros channel id are read from env (look them up in the Hogsend guild
 * with the `hogsend-discord` skill / discli). The guild id rides on each inbound
 * event's properties, so it is NOT needed here. Empty ids make `grantRole`
 * soft-fail (granted:false) rather than crash — so an unconfigured deploy is
 * inert, not broken.
 */
export const DiscordGamification = {
  INTROS_CHANNEL_ID: process.env.DISCORD_INTROS_CHANNEL_ID ?? "",
  roles: {
    HELLO_WORLD: process.env.DISCORD_ROLE_HELLO_WORLD ?? "",
    INTRODUCED: process.env.DISCORD_ROLE_INTRODUCED ?? "",
    RESONATOR: process.env.DISCORD_ROLE_RESONATOR ?? "",
    HYPE_HOG: process.env.DISCORD_ROLE_HYPE_HOG ?? "",
  },
} as const;

/**
 * The Stranger → Piglet → Hog tenure ladder (replaces the old join→Sproutling).
 * Granted/removed as members progress; the Piglet/Hog stages also need
 * DISCORD_GUILD_ID (read in the journey, NOT here) because the `discord.linked`
 * event carries no guildId. Empty ids keep grant/removeRole soft-failing, so an
 * unconfigured deploy stays inert.
 */
export const DiscordLifecycle = {
  /** Joined but not yet `/link`-verified. */
  STRANGER: process.env.DISCORD_ROLE_STRANGER ?? "",
  /** Linked (verified). Reuses the renamed former Sproutling role. */
  PIGLET: process.env.DISCORD_ROLE_PIGLET ?? "",
  /** Graduated: 7 days a Piglet + at least one message. */
  HOG: process.env.DISCORD_ROLE_HOG ?? "",
} as const;

/**
 * Marker events emitted once a one-way role is granted, so a `unlimited`
 * counting journey DMs the recipient EXACTLY once (re-counts re-enroll but the
 * marker suppresses a repeat DM). Distinct from the role grant itself, which is
 * idempotent.
 */
export const RoleGranted = {
  RESONATOR: "role.resonator_granted",
  HYPE_HOG: "role.hypehog_granted",
} as const;

/** Number of DISTINCT people required for the reaction-driven roles. */
export const DISTINCT_PEOPLE_THRESHOLD = 5;

/** The campaign tag on a managed link whose click enrolls the follow-up journey. */
export const DM_CAMPAIGN = "discord-dm-followup";

/** The first-party bus event a managed-link click emits (matches the engine). */
export const LINK_CLICKED = "link.clicked";
