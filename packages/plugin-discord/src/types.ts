/**
 * The narrow subset of Discord Gateway dispatch payloads the connector reads.
 * Deliberately partial — these are the `d` (data) shapes of the four dispatch
 * types in {@link DiscordEvents}, typed only for the fields the transform
 * touches. The full Discord objects carry far more; everything unused is left
 * off so the transform's data dependency is explicit.
 *
 * Field names are Discord's verbatim (snake_case) because the gateway worker
 * forwards the raw `d` payload untouched (see `gateway/ingress.ts`).
 */

/** Common Discord user object subset (present across dispatch payloads). */
export interface DiscordUser {
  id: string;
  username?: string;
  /** Discord's BOT flag — bot/system authors are dropped by the transform. */
  bot?: boolean;
  /** Verified-email flag (member-link only; never trusted from a bare event). */
  verified?: boolean;
  email?: string | null;
}

/** `MESSAGE_CREATE` `d` subset. */
export interface DiscordMessageCreate {
  id: string;
  channel_id: string;
  guild_id?: string | null;
  content?: string;
  author: DiscordUser;
  /** Present when the message was sent by a webhook (dropped by transform). */
  webhook_id?: string;
}

/** `MESSAGE_REACTION_ADD` `d` subset. */
export interface DiscordReactionAdd {
  user_id: string;
  channel_id: string;
  message_id: string;
  guild_id?: string | null;
  emoji?: { id?: string | null; name?: string | null };
}

/** `GUILD_MEMBER_ADD` `d` subset. */
export interface DiscordGuildMemberAdd {
  guild_id: string;
  joined_at?: string | null;
  user?: DiscordUser;
}

/** `PRESENCE_UPDATE` `d` subset. */
export interface DiscordPresenceUpdate {
  guild_id?: string | null;
  status?: "online" | "idle" | "dnd" | "offline";
  user?: { id?: string };
}
