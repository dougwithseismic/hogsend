import { randomBytes } from "node:crypto";
import { getRedis } from "@hogsend/engine";
import {
  TELEGRAM_CONFIRM_REDIS_PREFIX,
  TELEGRAM_CONNECT_PATH,
  TELEGRAM_LINK_REDIS_PREFIX,
  TELEGRAM_LINK_TTL_SECONDS,
} from "./constants.js";

/**
 * A short, URL-safe token that fits Telegram's 64-char `/start` deep-link param
 * (32 hex chars). Opaque — the email binding lives server-side in Redis, never
 * in the link, so the token carries no forgeable claim.
 */
export function randomLinkToken(): string {
  return randomBytes(16).toString("hex");
}

export type MintStartLinkResult =
  | { ok: true; token: string; url: string }
  | { ok: false; reason: string };

/**
 * Mint a one-tap `https://t.me/<bot>?start=<token>` link that binds the eventual
 * Telegram account to `email`. Stores `token → email` in Redis (TTL-bounded) so
 * the redeem on `/start <token>` attaches the bound email — NEVER an
 * attacker-supplied one. Returns `{ ok:false }` when Redis is unavailable.
 */
export async function mintTelegramStartLink(args: {
  botUsername: string;
  email: string;
  ttlSeconds?: number;
}): Promise<MintStartLinkResult> {
  const redis = getRedis();
  if (!redis) return { ok: false, reason: "redis_unavailable" };
  const token = randomLinkToken();
  await redis.set(
    `${TELEGRAM_LINK_REDIS_PREFIX}${token}`,
    args.email,
    "EX",
    args.ttlSeconds ?? TELEGRAM_LINK_TTL_SECONDS,
  );
  const username = args.botUsername.replace(/^@/, "");
  return { ok: true, token, url: `https://t.me/${username}?start=${token}` };
}

/**
 * PEEK a `/start <token>` binding WITHOUT consuming it. Returns the bound email,
 * or null when unknown/expired. Idempotent ON PURPOSE: `/start` arrives over a
 * Telegram webhook that auto-RETRIES on any non-2xx, so consuming the token in
 * the transform (before the ingest commits) would let one transient ingest blip
 * permanently burn the link and silently downgrade the user to onboarding.
 * Single-use is instead bounded by the short TTL, and the token rides only in a
 * private deep link.
 */
export async function peekTelegramStartToken(
  token: string,
): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;
  return (await redis.get(`${TELEGRAM_LINK_REDIS_PREFIX}${token}`)) ?? null;
}

export interface TelegramConfirmBinding {
  telegramUserId: string;
  email: string;
}

export type MintConfirmTokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: string };

/**
 * Mint an email-confirmation token sealing BOTH the Telegram user id and the
 * email typed in `/link`. The token rides in a link emailed to that address —
 * clicking it proves inbox ownership, so the bind is anti-graft: the web caller
 * never names the telegram id OR an arbitrary email; both come from the
 * server-sealed token, not the request.
 */
export async function mintTelegramConfirmToken(args: {
  telegramUserId: string;
  email: string;
  ttlSeconds?: number;
}): Promise<MintConfirmTokenResult> {
  const redis = getRedis();
  if (!redis) return { ok: false, reason: "redis_unavailable" };
  const token = randomLinkToken();
  await redis.set(
    `${TELEGRAM_CONFIRM_REDIS_PREFIX}${token}`,
    JSON.stringify({ telegramUserId: args.telegramUserId, email: args.email }),
    "EX",
    args.ttlSeconds ?? TELEGRAM_LINK_TTL_SECONDS,
  );
  return { ok: true, token };
}

/**
 * PEEK a confirmation token's sealed binding WITHOUT consuming it. The exchange
 * route consumes it (`consumeTelegramConfirmToken`) only AFTER the bind ingest
 * commits, so a transient failure doesn't burn the user's single click.
 */
export async function peekTelegramConfirmToken(
  token: string,
): Promise<TelegramConfirmBinding | null> {
  const redis = getRedis();
  if (!redis) return null;
  const raw = await redis.get(`${TELEGRAM_CONFIRM_REDIS_PREFIX}${token}`);
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as TelegramConfirmBinding;
    if (
      b &&
      typeof b.telegramUserId === "string" &&
      typeof b.email === "string"
    ) {
      return b;
    }
  } catch {
    // malformed binding — treat as a miss
  }
  return null;
}

/**
 * Consume (single-use delete) a confirmation token AFTER its bind ingest has
 * committed. Safe to call once; a second click then sees the token gone.
 */
export async function consumeTelegramConfirmToken(
  token: string,
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(`${TELEGRAM_CONFIRM_REDIS_PREFIX}${token}`);
}

/** Build the email-confirmation connect URL on the customer's own API_PUBLIC_URL. */
export function buildTelegramConfirmUrl(args: {
  apiPublicUrl: string;
  token: string;
}): string {
  const base = args.apiPublicUrl.replace(/\/$/, "");
  return `${base}${TELEGRAM_CONNECT_PATH}?tok=${encodeURIComponent(args.token)}`;
}
