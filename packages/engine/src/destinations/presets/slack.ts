import { WEBHOOK_EVENT_TYPES } from "../../lib/webhook-signing.js";
import { defineDestination } from "../define-destination.js";

/** Slack destination config read off `endpoint.config`. */
interface SlackConfig {
  /**
   * The Slack INCOMING WEBHOOK url (`https://hooks.slack.com/services/…`). When
   * set it overrides `endpoint.url`; either may carry it (the column `url` is the
   * natural home, `config.url` the explicit one).
   */
  url?: string;
  /** Optional username override for the posted message. */
  username?: string;
  /** Optional emoji icon (e.g. `:email:`) for the posted message. */
  iconEmoji?: string;
}

/** A compact, human-readable line per catalog event for the Slack text block. */
function formatLine(type: string, data: Record<string, unknown>): string {
  const to = typeof data.to === "string" ? data.to : undefined;
  const email = typeof data.userEmail === "string" ? data.userEmail : undefined;
  const template =
    typeof data.templateKey === "string" ? data.templateKey : undefined;
  const who = to ?? email;
  const parts = [`*${type}*`];
  if (who) parts.push(`for \`${who}\``);
  if (template) parts.push(`(template \`${template}\`)`);
  return parts.join(" ");
}

/**
 * Slack incoming-webhook destination — posts a formatted text block per catalog
 * event to a Slack channel. The webhook url comes from `config.url` (preferred)
 * or the endpoint `url`; a missing url is a CONFIG error (thrown → DLQ).
 *
 * Slack returns `200` with a plain `ok` body on success and a non-2xx on a bad
 * payload, so the default 2xx success rule is correct (no `isSuccess` override).
 */
export const slackDestination = defineDestination({
  meta: {
    id: "slack",
    name: "Slack",
    description:
      "Post a formatted message per email-lifecycle event to a Slack channel.",
  },
  events: [...WEBHOOK_EVENT_TYPES],
  transform(envelope, ctx) {
    const config = (ctx.endpoint.config ?? {}) as SlackConfig;
    const url = config.url ?? ctx.endpoint.url;
    if (!url || url.length === 0) {
      throw new Error(
        "slack destination is missing config.url / endpoint.url (non-retryable config error)",
      );
    }
    return {
      url,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: formatLine(envelope.type, envelope.data),
        ...(config.username ? { username: config.username } : {}),
        ...(config.iconEmoji ? { icon_emoji: config.iconEmoji } : {}),
      }),
    };
  },
});
