import {
  type DestinationTransformResult,
  defineDestination,
  WEBHOOK_EVENT_TYPES,
} from "@hogsend/engine";
import { DISCORD_API_BASE, DISCORD_PROVIDER_ID } from "./constants.js";

/**
 * Discord OUTBOUND destination config (read off `webhook_endpoints.config`).
 * Prefer the no-bot-token incoming webhook; bot-REST is the alt.
 */
interface DiscordDestinationConfig {
  /** Discord incoming-webhook URL (`https://discord.com/api/webhooks/…`). */
  webhookUrl?: string;
  /** Bot-REST channel id (used with `endpoint.secret` = the bot token). */
  channelId?: string;
  /** Optional username override (incoming-webhook only). */
  username?: string;
}

/** A compact, human-readable line per catalog event (Discord markdown). */
function formatLine(type: string, data: Record<string, unknown>): string {
  const who =
    (typeof data.to === "string" && data.to) ||
    (typeof data.userEmail === "string" && data.userEmail) ||
    undefined;
  const tmpl =
    typeof data.templateKey === "string" ? data.templateKey : undefined;
  const parts = [`**${type}**`];
  if (who) parts.push(`for \`${who}\``);
  if (tmpl) parts.push(`(template \`${tmpl}\`)`);
  return parts.join(" ");
}

/**
 * Discord destination — posts a message per lifecycle event to a Discord
 * channel. Same `meta.id = "discord"` as the inbound connector so the two faces
 * read as ONE integration.
 *
 * Wire resolution (preferred first):
 *  1. `config.webhookUrl` (or `endpoint.url` when it is a discord webhook URL)
 *     → POST the incoming webhook. No bot token needed. Returns `204` on
 *     success, so the success classifier also accepts 204.
 *  2. `config.channelId` + `endpoint.secret` (bot token) → bot-REST
 *     `POST /channels/:id/messages` with `Authorization: Bot <token>`.
 *  3. Neither → THROW (non-retryable config error → DLQ).
 */
export const discordDestination = defineDestination({
  meta: {
    id: DISCORD_PROVIDER_ID,
    name: "Discord",
    description:
      "Post a message per lifecycle event to a Discord channel — incoming " +
      "webhook (no bot token) preferred, bot-REST as the alt.",
  },
  events: [...WEBHOOK_EVENT_TYPES],
  transform(envelope, ctx) {
    const config = (ctx.endpoint.config ?? {}) as DiscordDestinationConfig;
    const content = formatLine(envelope.type, envelope.data);

    const webhookUrl = config.webhookUrl ?? ctx.endpoint.url;
    if (webhookUrl?.startsWith("https://discord.com/api/webhooks/")) {
      const result: DestinationTransformResult = {
        url: webhookUrl,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          ...(config.username ? { username: config.username } : {}),
        }),
        isSuccess: (status) =>
          status === 204 || (status >= 200 && status < 300),
      };
      return result;
    }

    if (config.channelId && ctx.endpoint.secret) {
      const result: DestinationTransformResult = {
        url: `${DISCORD_API_BASE}/channels/${config.channelId}/messages`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bot ${ctx.endpoint.secret}`,
        },
        body: JSON.stringify({ content }),
      };
      return result;
    }

    throw new Error(
      "discord destination needs config.webhookUrl (preferred) OR " +
        "config.channelId + endpoint.secret (bot token)",
    );
  },
});
