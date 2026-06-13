import { createHash, randomInt } from "node:crypto";
import { connectorLinkCodes, type Database } from "@hogsend/db";
import { and, count, eq, gte, isNull, sql } from "drizzle-orm";
import { safeEqual } from "../webhook-sources/verify.js";

/**
 * Single-use verification codes for the native in-connector identify loop
 * (Discord `/link <email>` → emailed code → `/verify <code>`).
 *
 * Security posture (all four hold simultaneously — the 6-digit code's small
 * keyspace is acceptable ONLY because of this stack):
 *  - SINGLE-USE — redeem is an atomic `UPDATE … SET used_at WHERE used_at IS
 *    NULL RETURNING`; a second redeem of the same code affects zero rows.
 *  - TTL'd — `expires_at` is checked on redeem; an aged code is rejected.
 *  - IDENTITY-BOUND — the code is bound to the invoking platform user at mint
 *    and re-checked at redeem with a CONSTANT-TIME compare; a code minted for
 *    one account can never be redeemed by another.
 *  - HASHED-AT-REST — only `sha256(code)` is stored; the plaintext code lives
 *    only in the member's inbox, so a DB read never yields a redeemable code.
 *  - THROTTLED — the anti-email-bomb throttle (per invoking user AND per target
 *    email, counted on mint within a rolling window) refuses to mint+send once
 *    either cap is hit.
 */

/** How long a minted code is valid before `/verify` (15 minutes). */
export const LINK_CODE_TTL_SECONDS = 900;

/** Rolling window (seconds) the anti-email-bomb throttle counts mints over. */
export const LINK_CODE_THROTTLE_WINDOW_SECONDS = 900;

/** Max codes one invoking platform user may mint per throttle window. */
export const LINK_CODE_MAX_PER_USER = 5;

/** Max codes that may be minted FOR one target email per throttle window. */
export const LINK_CODE_MAX_PER_EMAIL = 3;

/** sha256 of the plaintext code, lowercase hex — the at-rest lookup key. */
export function hashLinkCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/**
 * A 6-digit, human-typable, zero-padded code drawn from a CSPRNG. Entropy is
 * intentionally low (≈20 bits) — the security comes from single-use + TTL +
 * identity-binding + throttling, NOT from the code being hard to guess (a
 * guesser must hit a code minted FOR THEIR OWN platform id in a 15-min window,
 * which is self-targeting and pointless). 6 digits is the universal
 * "verification code" UX, trivial to type on mobile.
 */
export function generateLinkCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Why a `/link` mint was refused. */
export type LinkCodeThrottleScope = "platformUser" | "email";

export type CreateLinkCodeResult =
  | { ok: true; code: string }
  | { ok: false; reason: "throttled"; scope: LinkCodeThrottleScope };

/**
 * Mint a single-use link code, enforcing the anti-email-bomb throttle FIRST.
 *
 * The throttle counts rows already minted for this connector in the rolling
 * window — per invoking `platformUserId` (≤ {@link LINK_CODE_MAX_PER_USER}) AND
 * per target `email` (≤ {@link LINK_CODE_MAX_PER_EMAIL}) — and refuses to mint
 * (so nothing is emailed) when either cap is already met. Counting on MINT and
 * never freeing on redeem/expiry is the email-bomb control. On success the row
 * stores ONLY the sha256 hash and returns the plaintext `code` for the caller
 * to email.
 *
 * NOTE: a DB failure throws — callers MUST treat that as a hard failure and
 * NOT fall through to sending an email (an unthrottled send would defeat the
 * email-bomb control).
 */
export async function createLinkCode(opts: {
  db: Database;
  connectorId: string;
  platformUserId: string;
  email: string;
  ttlSeconds?: number;
  maxPerUser?: number;
  maxPerEmail?: number;
  windowSeconds?: number;
}): Promise<CreateLinkCodeResult> {
  const {
    db,
    connectorId,
    platformUserId,
    ttlSeconds = LINK_CODE_TTL_SECONDS,
    maxPerUser = LINK_CODE_MAX_PER_USER,
    maxPerEmail = LINK_CODE_MAX_PER_EMAIL,
    windowSeconds = LINK_CODE_THROTTLE_WINDOW_SECONDS,
  } = opts;
  // Normalize the email so the per-email throttle + the stored resolution key
  // are case-insensitive (mirrors the contacts email normalization).
  const email = opts.email.trim().toLowerCase();

  const since = new Date(Date.now() - windowSeconds * 1000);

  // Per-invoking-user throttle: caps one account spamming many addresses.
  const [userRow] = await db
    .select({ n: count() })
    .from(connectorLinkCodes)
    .where(
      and(
        eq(connectorLinkCodes.connectorId, connectorId),
        eq(connectorLinkCodes.platformUserId, platformUserId),
        gte(connectorLinkCodes.createdAt, since),
      ),
    );
  if ((userRow?.n ?? 0) >= maxPerUser) {
    return { ok: false, reason: "throttled", scope: "platformUser" };
  }

  // Per-target-email throttle: caps bombing one victim across many accounts.
  const [emailRow] = await db
    .select({ n: count() })
    .from(connectorLinkCodes)
    .where(
      and(
        eq(connectorLinkCodes.connectorId, connectorId),
        eq(connectorLinkCodes.targetEmail, email),
        gte(connectorLinkCodes.createdAt, since),
      ),
    );
  if ((emailRow?.n ?? 0) >= maxPerEmail) {
    return { ok: false, reason: "throttled", scope: "email" };
  }

  const code = generateLinkCode();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  await db.insert(connectorLinkCodes).values({
    connectorId,
    codeHash: hashLinkCode(code),
    platformUserId,
    targetEmail: email,
    expiresAt,
  });

  return { ok: true, code };
}

export type RedeemLinkCodeResult =
  | { ok: true; email: string }
  | { ok: false; reason: "invalid" | "expired" | "used" | "wrong_user" };

/**
 * Redeem a typed code for the bound email — single-use, TTL-enforced, and
 * identity-bound to the invoking platform user.
 *
 * Resolution is by `sha256(code)` (the plaintext is never stored). A missing
 * row → `invalid`. A row whose `platformUserId` does not match the caller
 * (CONSTANT-TIME compared so a redeem can't probe other accounts' codes) →
 * `wrong_user`. An expired row → `expired`. Single-use is the atomic
 * `UPDATE … SET used_at = now() WHERE id = ? AND used_at IS NULL RETURNING`:
 * the FIRST redeem wins and every later one sees zero affected rows → `used`
 * (this also closes the read-then-write race two concurrent `/verify`s create).
 */
export async function redeemLinkCode(opts: {
  db: Database;
  connectorId: string;
  platformUserId: string;
  code: string;
}): Promise<RedeemLinkCodeResult> {
  const { db, connectorId, platformUserId } = opts;
  const code = opts.code.trim();
  if (code.length === 0) return { ok: false, reason: "invalid" };

  const codeHash = hashLinkCode(code);

  const [row] = await db
    .select()
    .from(connectorLinkCodes)
    .where(
      and(
        eq(connectorLinkCodes.connectorId, connectorId),
        eq(connectorLinkCodes.codeHash, codeHash),
      ),
    )
    .limit(1);

  if (!row) return { ok: false, reason: "invalid" };

  // Identity binding — constant-time so a redeem can't time-probe which codes
  // belong to which account. A mismatch is rejected WITHOUT marking the code
  // used, so the rightful owner can still redeem it.
  if (!safeEqual(row.platformUserId, platformUserId)) {
    return { ok: false, reason: "wrong_user" };
  }

  if (row.usedAt !== null) return { ok: false, reason: "used" };
  if (row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: "expired" };
  }

  // Atomic single-use claim: only the redeem that flips `used_at` from NULL
  // wins. A concurrent redeem (or a replay that slipped past the read above)
  // sees zero rows returned.
  const claimed = await db
    .update(connectorLinkCodes)
    .set({ usedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(eq(connectorLinkCodes.id, row.id), isNull(connectorLinkCodes.usedAt)),
    )
    .returning({ id: connectorLinkCodes.id });

  if (claimed.length === 0) return { ok: false, reason: "used" };

  return { ok: true, email: row.targetEmail };
}
