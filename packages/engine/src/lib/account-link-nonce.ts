import { getRedisIfConnected } from "./redis.js";

/**
 * The single-use nonce burn for the hosted account-link callback.
 *
 * Shape-identical to the connector callback's burn
 * (`routes/connectors/index.ts:136-146`), down to the 900s TTL and the
 * `"OK"`-comparison on the `SET NX` result: the signed state is otherwise
 * TTL-replayable, so a captured callback URL works until `exp` unless the first
 * use burns the per-mint nonce.
 *
 * ONE DELIBERATE DIVERGENCE, and it must stay: when Redis is absent the
 * connector callback degrades to TTL-only validity ("we never block a callback
 * on a cache miss"), and this one REFUSES. DECISIONS §6.8 says fail closed, and
 * the threat differs — a replayed connector install re-captures a guild id,
 * whereas a replayed account-link callback can MOVE a platform account between
 * contacts (DECISIONS §6.1). It is a named function rather than four inline
 * lines so the null-Redis arm is directly testable; a guard whose fail-closed
 * branch no test can reach is a guard nobody will notice losing.
 */

export interface AccountLinkNonceRedis {
  set(
    key: string,
    value: string,
    ex: "EX",
    ttlSeconds: number,
    nx: "NX",
  ): Promise<string | null>;
}

/** Matches `connector:state:used:<nonce>`'s window so the marker outlives any valid state. */
export const NONCE_BURN_TTL_SECONDS = 900;

/**
 * Claim a nonce. TRUE exactly once per nonce; FALSE on a replay, on a missing
 * Redis, and on any Redis fault.
 */
export async function burnAccountLinkNonce(
  nonce: string,
  redis?: AccountLinkNonceRedis | null,
): Promise<boolean> {
  const client = redis === undefined ? (getRedisIfConnected() ?? null) : redis;
  if (!client) return false;
  try {
    const claimed = await client.set(
      `account_link:state:used:${nonce}`,
      "1",
      "EX",
      NONCE_BURN_TTL_SECONDS,
      "NX",
    );
    return claimed === "OK";
  } catch {
    return false;
  }
}
