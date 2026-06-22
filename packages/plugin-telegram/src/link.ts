import { randomBytes } from "node:crypto";
import { getRedis } from "@hogsend/engine";
import {
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
