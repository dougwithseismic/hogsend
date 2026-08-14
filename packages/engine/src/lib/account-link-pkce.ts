import { createHash, randomBytes } from "node:crypto";
import { getRedisIfConnected } from "./redis.js";

/**
 * PKCE custody for the hosted account-link flow (RFC 7636, S256 only).
 *
 * The verifier NEVER travels: not in the signed state, not in the redirect
 * URL, not in a log line. It lives in Redis for the life of one attempt, keyed
 * by that attempt's nonce, and is consumed with `GETDEL` so it is single-use
 * even if the nonce burn were somehow bypassed. Only the S256 CHALLENGE goes
 * out on the authorize URL, which is the entire point of PKCE: an intercepted
 * authorization code is worthless without the verifier the interceptor never
 * saw.
 */

/** The slice of ioredis this module uses; narrowed so a test can inject a fake. */
export interface AccountLinkPkceRedis {
  set(
    key: string,
    value: string,
    ex: "EX",
    ttlSeconds: number,
    nx: "NX",
  ): Promise<string | null>;
  getdel(key: string): Promise<string | null>;
}

const KEY_PREFIX = "account_link:pkce:";

function pkceKey(nonce: string): string {
  return `${KEY_PREFIX}${nonce}`;
}

function resolveRedis(
  redis: AccountLinkPkceRedis | null | undefined,
): AccountLinkPkceRedis | null {
  // `undefined` = "not injected" → the process client. Explicit `null` is the
  // fail-closed arm and must never fall through to a lazy connect.
  return redis === undefined ? (getRedisIfConnected() ?? null) : redis;
}

/**
 * A fresh verifier + its S256 challenge.
 *
 * 32 random bytes → 43 base64url chars, the RFC 7636 MINIMUM length, which is
 * also the maximum entropy the spec's 43..128 range can carry from a 256-bit
 * source. base64url's alphabet is a subset of the spec's `unreserved`
 * production, so the value needs no further encoding anywhere it appears.
 */
export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * Take custody of a verifier for one attempt. `SET NX` — returns FALSE when the
 * nonce is already claimed rather than rebinding it, so a nonce collision (or a
 * replayed `/start`) can never silently swap the verifier out from under a live
 * attempt. `/start` treats `false` as a 500.
 *
 * Returns false on a Redis fault too: fail closed, never a PKCE-less flow.
 */
export async function storePkceVerifier(
  nonce: string,
  verifier: string,
  ttlSeconds: number,
  redis?: AccountLinkPkceRedis | null,
): Promise<boolean> {
  const client = resolveRedis(redis);
  if (!client) return false;
  try {
    const claimed = await client.set(
      pkceKey(nonce),
      verifier,
      "EX",
      ttlSeconds,
      "NX",
    );
    return claimed === "OK";
  } catch {
    return false;
  }
}

/**
 * Consume the verifier for one attempt. `GETDEL` (Redis >= 6.2) so the read and
 * the delete are one atomic step — a `GET` then `DEL` leaves a window in which
 * two concurrent callbacks both read the same verifier.
 *
 * `null` means "no verifier for this nonce", which the callback treats as a
 * rejection: a PKCE provider whose verifier is gone cannot complete an exchange
 * that proves anything.
 */
export async function takePkceVerifier(
  nonce: string,
  redis?: AccountLinkPkceRedis | null,
): Promise<string | null> {
  const client = resolveRedis(redis);
  if (!client) return null;
  try {
    return await client.getdel(pkceKey(nonce));
  } catch {
    return null;
  }
}
