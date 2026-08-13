import { getRedisIfConnected } from "./redis.js";

/**
 * The public account-link surfaces (`/v1/accounts/:provider/start` and
 * `/callback`) are UNAUTHENTICATED by construction — a browser redirect target
 * carries no `Authorization` header — so they are throttled per IP, and the
 * warm mint is additionally throttled per contact.
 *
 * FAIL-CLOSED (DECISIONS §6.8), which is a DELIBERATE divergence from the
 * connector callback next door: that one degrades to TTL-only validity when
 * Redis is absent on the stated principle that it will "never block a callback
 * on a cache miss" (`routes/connectors/index.ts:134-136`). The threat is not
 * the same. A replayed connector install re-captures a guild id; a replayed
 * account-link callback can MOVE a platform account between contacts
 * (DECISIONS §6.1). PKCE verifier custody also lives in Redis, so for the
 * OAuth2 providers Redis is structurally required regardless. Do not "fix" this
 * into the connector posture.
 *
 * Modelled on `cold-connect/throttle.ts` — the same fixed-window `INCR` + set
 * the TTL on the FIRST increment idiom.
 */

/**
 * The slice of ioredis this module uses. Narrowed so a test can inject a fake
 * (and so `null` — the fail-closed arm — is expressible), the same seam
 * `lib/leader-lease.ts` uses for its `redis` argument.
 */
export interface AccountLinkThrottleRedis {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export type ThrottleResult =
  | { ok: true }
  | { ok: false; reason: "rate_limited" | "redis_unavailable" };

const DEFAULT_WINDOW_SECONDS = 900;
const DEFAULT_MAX = 20;

/** The key namespaces, one per budget. `cb` keeps the key short and readable. */
const SURFACE_KEY = { start: "start", callback: "cb" } as const;

interface AccountLinkThrottleBase {
  surface: "start" | "callback";
  config?: { windowSeconds?: number; max?: number };
  /**
   * TEST SEAM (and the fail-closed arm). Defaults to
   * {@link getRedisIfConnected}, NOT `getRedis()`: the account-link routes
   * refuse to serve at all without a connected Redis, so this must never be the
   * thing that lazily opens a connection and papers over that.
   */
  redis?: AccountLinkThrottleRedis | null;
}

/**
 * At least ONE budget must be named, enforced by the union rather than by a
 * runtime check — a call that names no budget would silently allow everything.
 *
 * `/start` calls this TWICE and that is deliberate: once on the IP alone,
 * BEFORE anything is minted (the order of operations puts the throttle ahead of
 * the binding resolution), and once on the sealed `contactId` alone once the
 * WARM binding is known. One call cannot do both, because the contact is not
 * known at the point the IP budget has to bite, and re-passing the IP on the
 * second call would double-count every warm request against its own budget.
 */
export type AccountLinkThrottleArgs = AccountLinkThrottleBase &
  (
    | {
        /** Best-effort client IP; `"unknown"` shares ONE bounded bucket, never bypasses. */
        ip: string;
        contactId?: string;
      }
    | {
        ip?: undefined;
        /** WARM only — the sealed contact gets its own budget across IPs. */
        contactId: string;
      }
  );

/**
 * One fixed-window counter. `INCR`, then set the TTL on the FIRST increment
 * only so the window slides forward rather than being extended by traffic. A
 * missing client throws so the caller fails CLOSED.
 */
async function bump(
  redis: AccountLinkThrottleRedis | null | undefined,
  key: string,
  windowSeconds: number,
): Promise<number> {
  if (!redis) throw new Error("redis_unavailable");
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds);
  return count;
}

/**
 * Bump every budget this call owns and reject when ANY is over its cap. Both
 * budgets are bumped even when the first is already over: a fixed-window
 * counter that stops counting under attack is a counter that reopens early.
 */
export async function checkAccountLinkThrottle(
  args: AccountLinkThrottleArgs,
): Promise<ThrottleResult> {
  const windowSeconds = args.config?.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
  const max = args.config?.max ?? DEFAULT_MAX;
  const redis = args.redis === undefined ? getRedisIfConnected() : args.redis;

  const keys = [
    ...(args.ip
      ? [`hogsend:al:throttle:${SURFACE_KEY[args.surface]}:${args.ip}`]
      : []),
    ...(args.contactId
      ? [`hogsend:al:throttle:contact:${args.contactId}`]
      : []),
  ];

  try {
    const counts = await Promise.all(
      keys.map((key) => bump(redis, key, windowSeconds)),
    );
    if (counts.some((count) => count > max)) {
      return { ok: false, reason: "rate_limited" };
    }
    return { ok: true };
  } catch {
    // Any Redis fault — absent client, connection loss, command error — is a
    // refusal, never a bypass.
    return { ok: false, reason: "redis_unavailable" };
  }
}
