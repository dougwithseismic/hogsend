import { getRedis } from "../lib/redis.js";

/**
 * Mint-throttle config for a cold-connect flow. Two independent budgets — one
 * keyed on the platform user id, one on the email — each a fixed-window counter
 * (`windowSeconds` / `max`). Both default to a conservative "a few per 15 min".
 */
export interface ColdConnectThrottleConfig {
  /** Per-platform-user budget. */
  perUser?: { windowSeconds?: number; max?: number };
  /** Per-email budget. */
  perEmail?: { windowSeconds?: number; max?: number };
}

const DEFAULT_WINDOW_SECONDS = 900;
const DEFAULT_MAX = 5;

export type ThrottleResult =
  | { ok: true }
  | { ok: false; reason: "rate_limited" | "redis_unavailable" };

/**
 * A single fixed-window INCR counter. `INCR` the key; on the FIRST increment set
 * its TTL so the window slides forward. A Redis fault throws so the caller can
 * fail CLOSED — we never want a cache blip to silently disable the mint throttle
 * (which gates outbound email). Returns the post-increment count.
 */
async function bump(key: string, windowSeconds: number): Promise<number> {
  const redis = getRedis();
  if (!redis) throw new Error("redis_unavailable");
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSeconds);
  }
  return count;
}

/**
 * Mint-counted, Redis-INCR throttle for a cold-connect confirm mint. Bumps both
 * the per-user and per-email windows and rejects when EITHER is over its cap.
 *
 * Fail-CLOSED: any Redis fault returns `{ ok:false, reason:"redis_unavailable"
 * }` so the caller (`mintConfirm`) returns `{ ok:false }` and does NOT send a
 * link. Cold-connect deliberately stays OFF the `connectorLinkCodes` DB table —
 * these counters live only in Redis.
 */
export async function checkColdConnectThrottle(args: {
  connectorId: string;
  platformUserId: string;
  email: string;
  config?: ColdConnectThrottleConfig;
}): Promise<ThrottleResult> {
  const { connectorId, platformUserId, email, config } = args;

  const userWindow = config?.perUser?.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
  const userMax = config?.perUser?.max ?? DEFAULT_MAX;
  const emailWindow = config?.perEmail?.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
  const emailMax = config?.perEmail?.max ?? DEFAULT_MAX;

  const userKey = `hogsend:cc:throttle:${connectorId}:user:${platformUserId}`;
  const emailKey = `hogsend:cc:throttle:${connectorId}:email:${email.toLowerCase()}`;

  try {
    const [userCount, emailCount] = await Promise.all([
      bump(userKey, userWindow),
      bump(emailKey, emailWindow),
    ]);
    if (userCount > userMax || emailCount > emailMax) {
      return { ok: false, reason: "rate_limited" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "redis_unavailable" };
  }
}
