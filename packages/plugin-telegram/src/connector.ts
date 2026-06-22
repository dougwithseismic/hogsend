import {
  type ConnectorCtx,
  type DefinedConnector,
  defineConnector,
  type IngestEvent,
} from "@hogsend/engine";
import { TELEGRAM_PROVIDER_ID } from "./constants.js";
import { TelegramEvents } from "./events.js";
import { peekTelegramStartToken } from "./link.js";
import type { TelegramMessage, TelegramUpdate, TelegramUser } from "./types.js";

/**
 * Telegram identity → Hogsend contact key, namespaced so numeric Telegram ids
 * never collide with another platform's. This is the contact's `externalId`
 * (the minimal-path identity until the generic identity-kind table lands).
 */
function telegramUserKey(userId: number | string): string {
  return `telegram:${userId}`;
}

/**
 * The NON-KEY Telegram metadata merged under `contacts.properties.telegram`.
 *
 * NOTE: unlike `discord`, `telegram` is NOT yet in the engine's `DEEP_MERGE_KEYS`
 * (lib/contacts.ts), so this sub-object is REPLACED wholesale on each event
 * rather than deep-merged. Every event therefore carries the FULL object it
 * knows (id/chat_id/last_seen + whatever profile fields the update included), so
 * no field is lost across events. `last_seen` is derived Hogsend-side.
 */
function telegramMetadata(opts: {
  id: string;
  chatId: string;
  lastSeen: Date;
  user?: TelegramUser;
}): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    id: opts.id,
    chat_id: opts.chatId,
    last_seen: opts.lastSeen.toISOString(),
  };
  const u = opts.user;
  if (u) {
    if (typeof u.username === "string") meta.username = u.username;
    if (typeof u.first_name === "string") meta.first_name = u.first_name;
    if (typeof u.last_name === "string") meta.last_name = u.last_name;
    if (typeof u.language_code === "string") meta.language = u.language_code;
  }
  return meta;
}

/** Match `/start`, `/start@BotName`, optionally capturing a deep-link token. */
const START_RE = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/i;

/** Match `/link`, `/link@BotName`, optionally capturing an email argument. */
const LINK_RE = /^\/link(?:@\w+)?(?:\s+(\S+))?\s*$/i;

/**
 * The Telegram INBOUND connector (webhook transport). Served live at
 * `POST /v1/webhooks/telegram`; the engine route verifies the
 * `x-telegram-bot-api-secret-token` header against `TELEGRAM_WEBHOOK_SECRET`,
 * JSON-parses the body, and hands the Update to this transform.
 *
 *  - `/start <token>` whose token resolves to a bound email → `telegram.linked`
 *    carrying BOTH `userId` (telegram:<id>) and `userEmail` so the engine
 *    `resolveOrCreateContact` merges the Telegram identity onto the email
 *    contact (cross-channel identity, zero engine change).
 *  - bare `/start` (or unknown/expired token) → `telegram.started` (onboarding).
 *  - any other text → `telegram.message`.
 *  - bots / non-message updates → null (skipped, route 200s).
 */
export const telegramConnector: DefinedConnector = defineConnector({
  meta: {
    id: TELEGRAM_PROVIDER_ID,
    name: "Telegram",
    transport: "webhook",
    description:
      "Inbound Telegram activity (messages, /start deep-link linking) → " +
      "IngestEvent, via the Bot API webhook.",
  },
  // Telegram echoes the `secret_token` set on setWebhook in this header. `match`
  // is OPEN when the env var is unset, so a misconfigured secret never hard-locks
  // local testing; set TELEGRAM_WEBHOOK_SECRET to enforce it.
  inboundVerify: {
    type: "match",
    header: "x-telegram-bot-api-secret-token",
    envKey: "TELEGRAM_WEBHOOK_SECRET",
  },

  async transform(
    raw: unknown,
    ctx: ConnectorCtx,
  ): Promise<IngestEvent | null> {
    const update = raw as TelegramUpdate;
    const msg: TelegramMessage | undefined =
      update.message ?? update.edited_message;
    if (!msg?.from || msg.from.is_bot) {
      ctx.logger.debug("telegram connector: unmapped update", {
        updateId: update.update_id,
      });
      return null;
    }

    const fromId = String(msg.from.id);
    const chatId = String(msg.chat.id);
    // Telegram `date` is unix SECONDS; fall back to now if absent (edited_message).
    const occurredAt = msg.date ? new Date(msg.date * 1000) : new Date();
    const text = typeof msg.text === "string" ? msg.text : "";
    const userKey = telegramUserKey(fromId);
    const telegram = telegramMetadata({
      id: fromId,
      chatId,
      lastSeen: occurredAt,
      user: msg.from,
    });

    const startMatch = text.match(START_RE);
    if (startMatch) {
      const token = startMatch[1];
      if (token) {
        const email = await peekTelegramStartToken(token);
        if (email) {
          return {
            event: TelegramEvents.LINKED,
            userId: userKey,
            userEmail: email,
            eventProperties: {
              source: "telegram",
              chatId,
              fromId,
              username: msg.from.username ?? null,
            },
            contactProperties: { telegram },
            occurredAt,
            idempotencyKey: `telegram:linked:${fromId}:${token}`,
          };
        }
      }
      return {
        event: TelegramEvents.STARTED,
        userId: userKey,
        eventProperties: { source: "telegram", chatId, fromId },
        contactProperties: { telegram },
        occurredAt,
        idempotencyKey: `telegram:start:${fromId}:${msg.message_id}`,
      };
    }

    const linkMatch = text.match(LINK_RE);
    if (linkMatch) {
      // `/link <email>` → a confirmation link is emailed (a consumer journey on
      // telegram.link_requested mints the token + sends it). The email is
      // validated + proven by DELIVERY downstream, never trusted from here.
      return {
        event: TelegramEvents.LINK_REQUESTED,
        userId: userKey,
        eventProperties: {
          source: "telegram",
          chatId,
          fromId,
          email: linkMatch[1] ? linkMatch[1].toLowerCase() : null,
        },
        contactProperties: { telegram },
        occurredAt,
        idempotencyKey: `telegram:linkreq:${fromId}:${msg.message_id}`,
      };
    }

    return {
      event: TelegramEvents.MESSAGE,
      userId: userKey,
      eventProperties: {
        source: "telegram",
        chatId,
        fromId,
        messageId: msg.message_id,
        hasText: text.length > 0,
        text: text.slice(0, 500),
      },
      contactProperties: { telegram },
      occurredAt,
      idempotencyKey: `telegram:msg:${chatId}:${msg.message_id}`,
    };
  },
});
