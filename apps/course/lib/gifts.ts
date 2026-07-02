import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { priceIdForCourse } from "@/lib/courses";
import { db } from "@/lib/db";
import { gift } from "@/lib/db/schema";
import { getStripe } from "@/lib/stripe";

/**
 * Gift copies of a course. A gift purchase (buyer pays full price) mints a
 * SINGLE-USE 100%-off Stripe promotion code restricted to the course's
 * product; the recipient redeems it through normal checkout, so entitlement,
 * receipts, and refunds all ride the existing purchase machinery. The coupon
 * carries `metadata.giftId`, which is how a redeeming session is traced back
 * to its gift row (see the webhook).
 */

/** Unambiguous code alphabet (no 0/O/1/I). */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `GIFT-${out}`;
}

/**
 * Claim (or resume) the gift row for a completed gift checkout session and
 * mint its promotion code. Idempotent per session: the row is claimed on the
 * session id first; a retried delivery that finds a fully-minted row returns
 * it without touching Stripe, and one that finds a pending row (a previous
 * attempt died mid-mint) resumes the mint on the SAME row.
 */
export async function recordGiftAndMintCode(
  input: {
    buyerUserId: string;
    courseSlug: string;
    recipientEmail: string | null;
    stripeCheckoutSessionId: string;
    amount: number | null;
    currency: string | null;
  },
  // Injectable for tests — production always uses the Stripe mint.
  mint: typeof mintPromotionCode = mintPromotionCode,
): Promise<{ giftId: string; code: string; isNew: boolean } | null> {
  const inserted = await db
    .insert(gift)
    .values({
      id: randomUUID(),
      buyerUserId: input.buyerUserId,
      courseSlug: input.courseSlug,
      recipientEmail: input.recipientEmail,
      stripeCheckoutSessionId: input.stripeCheckoutSessionId,
      amount: input.amount,
      currency: input.currency,
    })
    .onConflictDoNothing()
    .returning({ id: gift.id });

  let giftId = inserted[0]?.id;
  if (!giftId) {
    // Retried delivery. Fully minted → done; pending → resume the mint.
    const [existing] = await db
      .select({ id: gift.id, code: gift.promotionCode })
      .from(gift)
      .where(eq(gift.stripeCheckoutSessionId, input.stripeCheckoutSessionId))
      .limit(1);
    if (!existing) return null;
    if (existing.code) {
      return { giftId: existing.id, code: existing.code, isNew: false };
    }
    giftId = existing.id;
  }

  const minted = await mint(input.courseSlug, giftId);
  await db
    .update(gift)
    .set({
      promotionCode: minted.code,
      stripePromotionCodeId: minted.promotionCodeId,
      stripeCouponId: minted.couponId,
    })
    .where(eq(gift.id, giftId));

  return { giftId, code: minted.code, isNew: true };
}

/**
 * One single-use 100%-off promotion code restricted to the course's product.
 * Standalone so the admin free-copy script can mint codes outside a gift row.
 */
export async function mintPromotionCode(
  courseSlug: string,
  giftId?: string,
): Promise<{ code: string; couponId: string; promotionCodeId: string }> {
  const stripe = getStripe();

  const priceId = priceIdForCourse(courseSlug);
  if (!priceId) {
    throw new Error(`no Stripe price configured for "${courseSlug}"`);
  }
  const price = await stripe.prices.retrieve(priceId);
  const productId =
    typeof price.product === "string" ? price.product : price.product.id;

  const coupon = await stripe.coupons.create({
    percent_off: 100,
    duration: "once",
    max_redemptions: 1,
    applies_to: { products: [productId] },
    name: `Gift: ${courseSlug}`,
    metadata: { courseSlug, ...(giftId ? { giftId } : {}) },
  });

  // Retry on the (unlikely) code collision — Stripe rejects duplicates.
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateCode();
    try {
      const promotionCode = await stripe.promotionCodes.create({
        promotion: { type: "coupon", coupon: coupon.id },
        code,
        max_redemptions: 1,
        metadata: { courseSlug, ...(giftId ? { giftId } : {}) },
      });
      return { code, couponId: coupon.id, promotionCodeId: promotionCode.id };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("could not create a promotion code");
}

/**
 * Mark a gift redeemed when a discounted purchase traces back to a gift
 * coupon (metadata.giftId). Idempotent: only the first redemption writes.
 */
export async function markGiftRedeemed(
  giftId: string,
  redeemedByUserId: string,
): Promise<{
  buyerUserId: string;
  courseSlug: string;
  recipientEmail: string | null;
} | null> {
  const [row] = await db
    .select({
      id: gift.id,
      buyerUserId: gift.buyerUserId,
      courseSlug: gift.courseSlug,
      recipientEmail: gift.recipientEmail,
      redeemedAt: gift.redeemedAt,
    })
    .from(gift)
    .where(eq(gift.id, giftId))
    .limit(1);
  if (!row || row.redeemedAt) return null;

  await db
    .update(gift)
    .set({ redeemedByUserId, redeemedAt: new Date() })
    .where(eq(gift.id, giftId));
  return {
    buyerUserId: row.buyerUserId,
    courseSlug: row.courseSlug,
    recipientEmail: row.recipientEmail,
  };
}

/**
 * A redeeming session's gift id: the session's applied discounts carry the
 * coupon (id or object); a gift coupon has `metadata.giftId`.
 */
export async function giftIdFromSession(
  session: Stripe.Checkout.Session,
): Promise<string | null> {
  let discounts = session.discounts;
  if (!discounts || discounts.length === 0) {
    // Webhook payloads occasionally omit the array — re-fetch the session.
    const full = await getStripe().checkout.sessions.retrieve(session.id);
    discounts = full.discounts;
  }
  for (const entry of discounts ?? []) {
    const coupon = entry.coupon;
    if (!coupon) continue;
    const full =
      typeof coupon === "string"
        ? await getStripe().coupons.retrieve(coupon)
        : coupon;
    const giftId = full.metadata?.giftId;
    if (giftId) return giftId;
  }
  return null;
}
