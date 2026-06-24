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
  /** Discord's display name (the post-2023 unique-name system). */
  global_name?: string | null;
  /** Avatar hash (NOT a URL) — the CDN URL is built consumer-side if needed. */
  avatar?: string | null;
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

/** `MESSAGE_REACTION_ADD` / `MESSAGE_REACTION_REMOVE` `d` subset. */
export interface DiscordReactionAdd {
  user_id: string;
  channel_id: string;
  message_id: string;
  guild_id?: string | null;
  emoji?: { id?: string | null; name?: string | null };
  /**
   * Best-effort author of the reacted-to message, injected by the gateway worker
   * from its `discord.js` message cache (cache-only, NO REST → no rate limits).
   * Absent when the message predates the bot's cache — then only the
   * reactor-keyed `reaction_added` fires (no author-keyed `reaction_received`).
   * NOT a Discord field (the `__` prefix marks it Hogsend-injected).
   */
  __author?: string | null;
}

/** `GUILD_MEMBER_ADD` `d` subset. */
export interface DiscordGuildMemberAdd {
  guild_id: string;
  joined_at?: string | null;
  /** Role ids granted at join (the GUILD_MEMBER_ADD `d` carries them). */
  roles?: string[];
  user?: DiscordUser;
}

/** `PRESENCE_UPDATE` `d` subset. */
export interface DiscordPresenceUpdate {
  guild_id?: string | null;
  status?: "online" | "idle" | "dnd" | "offline";
  user?: { id?: string };
}
