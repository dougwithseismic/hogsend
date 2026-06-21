import type { ConnectorActionCtx } from "@hogsend/engine";
import { TELEGRAM_API_BASE } from "../constants.js";

/**
 * Shared Bot API plumbing for the Telegram OUTBOUND actions. Every action is a
 * plain HTTPS call needing only the bot token — no socket, no inbound runtime —
 * so actions run on any replica regardless of webhook state.
 */

/** The bot token, read from the platform's own env. Throws when unset. */
export function getBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is required for Telegram outbound actions",
    );
  }
  return token;
}

/** Telegram's envelope: `{ ok, result }` on success, `{ ok:false, … }` on error. */
export interface TelegramApiResult {
  ok: boolean;
  result?: { message_id?: number };
  description?: string;
  error_code?: number;
}

/**
 * One Bot API call. NEVER throws on a Telegram-level error (e.g. 403 "bot was
 * blocked by the user") — returns `{ ok:false, … }` so a single un-DMable
 * recipient is a soft failure, not a journey-killing throw. The token is never
 * placed in a thrown message.
 */
export async function tgFetch(
  method: string,
  body: Record<string, unknown>,
): Promise<TelegramApiResult> {
  let token: string;
  try {
    token = getBotToken();
  } catch (err) {
    // Misconfigured token → SOFT-fail (warned by the action), never throw out of
    // a journey send.
    return {
      ok: false,
      error_code: 0,
      description: err instanceof Error ? err.message : "missing bot token",
    };
  }
  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res
      .json()
      .catch(() => null)) as TelegramApiResult | null;
    if (!json) {
      return {
        ok: false,
        error_code: res.status,
        description: `telegram ${method} returned a non-JSON ${res.status}`,
      };
    }
    return json;
  } catch (err) {
    // Transport-level failure (DNS / reset / TLS / 10s timeout) — SOFT-fail so a
    // single un-DMable recipient or a network blip never kills the journey.
    return {
      ok: false,
      error_code: 0,
      description: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Resolve a recipient ref to a Telegram chat id: a raw numeric ref is used as-is,
 * else the contact store (`properties.telegram.chat_id` / `.id`, or an
 * `externalId` of `telegram:<id>`). Null when unresolvable.
 */
export async function resolveTelegramChatId(
  ctx: ConnectorActionCtx,
  ref: string,
): Promise<string | null> {
  if (/^-?\d{3,}$/.test(ref)) return ref;
  const contact = await ctx.resolveContact(ref);
  if (!contact) return null;
  const tg = (contact.properties?.telegram ?? null) as {
    chat_id?: string;
    id?: string;
  } | null;
  if (tg?.chat_id) return tg.chat_id;
  if (tg?.id) return tg.id;
  if (contact.externalId?.startsWith("telegram:")) {
    return contact.externalId.slice("telegram:".length);
  }
  return null;
}
