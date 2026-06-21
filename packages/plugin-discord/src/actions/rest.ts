import type { ConnectorActionCtx } from "@hogsend/engine";
import { DISCORD_API_BASE } from "../constants.js";

/**
 * Shared bot-REST plumbing for the Discord OUTBOUND actions. Every action is a
 * pure HTTPS call to discord.com needing only the bot token — NO `discord.js`,
 * NO gateway socket — so actions run on any replica regardless of the inbound
 * runtime's state.
 */

/** The bot token, read from the platform's own env. Throws when unset. */
export function getBotToken(): string {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error(
      "DISCORD_BOT_TOKEN is required for Discord outbound actions",
    );
  }
  return token;
}

/**
 * One bot-REST call. Throws on a non-2xx (STATUS ONLY in the message — never the
 * response body, which can echo the request carrying the `Bot` token). Returns
 * the parsed JSON, or null for 204 / empty bodies.
 */
export async function botFetch(
  path: string,
  init: { method: string; body?: unknown },
): Promise<unknown> {
  const res = await fetch(`${DISCORD_API_BASE}${path}`, {
    method: init.method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${getBotToken()}`,
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) {
    throw new Error(
      `discord bot-REST ${init.method} ${path} failed (${res.status})`,
    );
  }
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

/**
 * Resolve a recipient ref to a Discord snowflake: the contact store first
 * (email / external id / discord id), then an all-digit ref treated as a raw
 * snowflake. Null when unresolvable.
 */
export async function resolveDiscordId(
  ctx: ConnectorActionCtx,
  ref: string,
): Promise<string | null> {
  const contact = await ctx.resolveContact(ref);
  if (contact?.discordId) return contact.discordId;
  if (/^\d{5,}$/.test(ref)) return ref;
  return null;
}

/** The shared result shape for a channel post. */
export interface SendMessageResult {
  messageId: string | null;
}
