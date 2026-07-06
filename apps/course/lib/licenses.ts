import { randomUUID } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { licenseCode, licensePack } from "@/lib/db/schema";
import { mintRestrictedCode } from "@/lib/gifts";

/**
 * Team licences. One checkout buys `seats` copies of a course; the webhook
 * mints `seats` single-use 100%-off promotion codes (TEAM-XXXXXXXX, product-
 * restricted — same machinery as gift codes) and the buyer distributes them.
 * Each redemption rides normal checkout, so entitlements, receipts, and
 * refunds are the existing purchase path unchanged.
 */

export const MIN_TEAM_SEATS = 2;
export const MAX_TEAM_SEATS = 25;

/** Parse + clamp a seats form value into the allowed range. */
export function clampSeats(raw: unknown): number {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n)) return MIN_TEAM_SEATS;
  return Math.min(MAX_TEAM_SEATS, Math.max(MIN_TEAM_SEATS, n));
}

/** Mint one seat code, stamped so redemption traces back to its row. */
async function mintLicenseCode(
  courseSlug: string,
  packId: string,
  licenseCodeId: string,
): Promise<{ code: string; couponId: string; promotionCodeId: string }> {
  return mintRestrictedCode(courseSlug, {
    name: `Team licence: ${courseSlug}`,
    prefix: "TEAM",
    metadata: { packId, licenseCodeId },
  });
}

/**
 * Claim (or resume) the licence pack for a completed team checkout session
 * and mint its seat codes. Idempotent per session: the pack row is claimed on
 * the session id first; code rows are inserted only after their Stripe mint
 * succeeds, so a retried delivery mints exactly the missing remainder and
 * never a duplicate. `needsEmail` is true until markPackEmailed records a
 * successful send — a retry that finds a fully-minted, un-emailed pack still
 * delivers the codes email.
 */
export async function recordPackAndMintCodes(
  input: {
    buyerUserId: string;
    courseSlug: string;
    seats: number;
    stripeCheckoutSessionId: string;
    amount: number | null;
    currency: string | null;
  },
  // Injectable for tests — production always uses the Stripe mint.
  mint: typeof mintLicenseCode = mintLicenseCode,
): Promise<{
  packId: string;
  codes: string[];
  mintedNew: number;
  needsEmail: boolean;
} | null> {
  const inserted = await db
    .insert(licensePack)
    .values({
      id: randomUUID(),
      buyerUserId: input.buyerUserId,
      courseSlug: input.courseSlug,
      seats: input.seats,
      stripeCheckoutSessionId: input.stripeCheckoutSessionId,
      amount: input.amount,
      currency: input.currency,
    })
    .onConflictDoNothing()
    .returning({ id: licensePack.id, emailedAt: licensePack.emailedAt });

  let pack = inserted[0];
  if (!pack) {
    // Retried delivery — resume the existing pack.
    const [existing] = await db
      .select({ id: licensePack.id, emailedAt: licensePack.emailedAt })
      .from(licensePack)
      .where(
        eq(licensePack.stripeCheckoutSessionId, input.stripeCheckoutSessionId),
      )
      .limit(1);
    if (!existing) return null;
    pack = existing;
  }

  const existingCodes = await db
    .select({ code: licenseCode.code })
    .from(licenseCode)
    .where(eq(licenseCode.packId, pack.id))
    .orderBy(asc(licenseCode.createdAt));

  const codes = existingCodes.map((c) => c.code);
  const missing = input.seats - codes.length;
  for (let i = 0; i < missing; i++) {
    const id = randomUUID();
    const minted = await mint(input.courseSlug, pack.id, id);
    await db.insert(licenseCode).values({
      id,
      packId: pack.id,
      code: minted.code,
      stripePromotionCodeId: minted.promotionCodeId,
      stripeCouponId: minted.couponId,
    });
    codes.push(minted.code);
  }

  return {
    packId: pack.id,
    codes,
    mintedNew: Math.max(0, missing),
    needsEmail: !pack.emailedAt,
  };
}

/** Record that the codes email went out (gates the send to exactly once). */
export async function markPackEmailed(packId: string): Promise<void> {
  await db
    .update(licensePack)
    .set({ emailedAt: new Date() })
    .where(eq(licensePack.id, packId));
}

/**
 * Mark a seat code redeemed when a discounted purchase traces back to a
 * licence coupon (metadata.licenseCodeId). Idempotent: only the first
 * redemption writes. Returns the buyer + N-of-M progress for the loop-close
 * event, or null when already marked (retry) or unknown.
 */
export async function markLicenseCodeRedeemed(
  licenseCodeId: string,
  redeemedByUserId: string,
): Promise<{
  buyerUserId: string;
  courseSlug: string;
  seats: number;
  redeemedCount: number;
} | null> {
  const [row] = await db
    .select({
      id: licenseCode.id,
      packId: licenseCode.packId,
      redeemedAt: licenseCode.redeemedAt,
    })
    .from(licenseCode)
    .where(eq(licenseCode.id, licenseCodeId))
    .limit(1);
  if (!row || row.redeemedAt) return null;

  await db
    .update(licenseCode)
    .set({ redeemedByUserId, redeemedAt: new Date() })
    .where(eq(licenseCode.id, row.id));

  const [pack] = await db
    .select({
      buyerUserId: licensePack.buyerUserId,
      courseSlug: licensePack.courseSlug,
      seats: licensePack.seats,
    })
    .from(licensePack)
    .where(eq(licensePack.id, row.packId))
    .limit(1);
  if (!pack) return null;

  const redeemed = await db
    .select({ redeemedAt: licenseCode.redeemedAt })
    .from(licenseCode)
    .where(eq(licenseCode.packId, row.packId));
  return {
    buyerUserId: pack.buyerUserId,
    courseSlug: pack.courseSlug,
    seats: pack.seats,
    redeemedCount: redeemed.filter((r) => r.redeemedAt).length,
  };
}

/** A buyer's licence packs with per-code redemption state (account page). */
export async function listLicensePacks(buyerUserId: string): Promise<
  {
    id: string;
    courseSlug: string;
    seats: number;
    amount: number | null;
    currency: string | null;
    createdAt: Date;
    codes: { code: string; redeemedAt: Date | null }[];
  }[]
> {
  const packs = await db
    .select({
      id: licensePack.id,
      courseSlug: licensePack.courseSlug,
      seats: licensePack.seats,
      amount: licensePack.amount,
      currency: licensePack.currency,
      createdAt: licensePack.createdAt,
    })
    .from(licensePack)
    .where(eq(licensePack.buyerUserId, buyerUserId))
    .orderBy(asc(licensePack.createdAt));
  if (packs.length === 0) return [];

  const rows = await db
    .select({
      packId: licenseCode.packId,
      code: licenseCode.code,
      redeemedAt: licenseCode.redeemedAt,
    })
    .from(licenseCode)
    .where(
      inArray(
        licenseCode.packId,
        packs.map((p) => p.id),
      ),
    )
    .orderBy(asc(licenseCode.createdAt));
  const byPack = new Map<string, { code: string; redeemedAt: Date | null }[]>();
  for (const r of rows) {
    const list = byPack.get(r.packId) ?? [];
    list.push({ code: r.code, redeemedAt: r.redeemedAt });
    byPack.set(r.packId, list);
  }
  return packs.map((p) => ({ ...p, codes: byPack.get(p.id) ?? [] }));
}
