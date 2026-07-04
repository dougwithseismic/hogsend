import type Stripe from "stripe";
import { priceIdForCourse } from "@/lib/courses";
import { generateCode } from "@/lib/gifts";
import { getStripe, paywallConfigured } from "@/lib/stripe";

/**
 * Share codes — the engaged-student referral mechanic. A week into the
 * course, students who've completed a few lessons get ONE single-use
 * percent-off promotion code to hand to someone else (minted here, emailed by
 * the lifecycle side). Unlike gifts (100% off, paid for by the buyer), a
 * share code is a discount the redeemer still pays against — so there is no
 * gift row and no entitlement transfer; the redeemer's own purchase webhook
 * grants their access. The coupon carries `metadata.shareUserId`, which is
 * how a redeeming session is traced back to the sharer (the webhook emits
 * `course.share_redeemed` to close their loop).
 *
 * Codes expire (REDEEM_BY_DAYS) so an unused code — or one orphaned by a
 * failed mint response — dies on its own rather than living as a perpetual
 * discount.
 */

/** Discount granted to the person the code is shared with. */
export function shareDiscountPercent(): number {
  const raw = Number(process.env.SHARE_DISCOUNT_PERCENT ?? "30");
  return Number.isFinite(raw) && raw >= 5 && raw <= 100 ? raw : 30;
}

/** How long a minted share code stays redeemable. */
const REDEEM_BY_DAYS = 60;

export function shareCodeConfigured(): boolean {
  return Boolean(process.env.SHARE_CODE_SECRET) && paywallConfigured();
}

/**
 * Mint one single-use percent-off promotion code restricted to the course's
 * product, attributed to the sharing student via coupon + promo metadata.
 */
export async function mintShareCode(input: {
  shareUserId: string;
  courseSlug: string;
}): Promise<{ code: string; percentOff: number; expiresAt: string }> {
  const stripe = getStripe();

  const priceId = priceIdForCourse(input.courseSlug);
  if (!priceId) {
    throw new Error(`no Stripe price configured for "${input.courseSlug}"`);
  }
  const price = await stripe.prices.retrieve(priceId);
  const productId =
    typeof price.product === "string" ? price.product : price.product.id;

  const percentOff = shareDiscountPercent();
  const redeemBy = Math.floor(Date.now() / 1000) + REDEEM_BY_DAYS * 86400;
  const metadata = {
    courseSlug: input.courseSlug,
    shareUserId: input.shareUserId,
  };

  const coupon = await stripe.coupons.create({
    percent_off: percentOff,
    duration: "once",
    max_redemptions: 1,
    redeem_by: redeemBy,
    applies_to: { products: [productId] },
    name: `Share: ${input.courseSlug}`,
    metadata,
  });

  // Retry on the (unlikely) code collision — Stripe rejects duplicates.
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateCode("SHARE");
    try {
      await stripe.promotionCodes.create({
        promotion: { type: "coupon", coupon: coupon.id },
        code,
        max_redemptions: 1,
        expires_at: redeemBy,
        metadata,
      });
      return {
        code,
        percentOff,
        expiresAt: new Date(redeemBy * 1000).toISOString(),
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("could not create a share promotion code");
}

/**
 * A redeeming session's sharer, when its applied coupon carries share
 * metadata. Mirrors giftIdFromSession — gift coupons take precedence there,
 * so the webhook checks gifts first and only then shares.
 */
export async function shareAttributionFromSession(
  session: Stripe.Checkout.Session,
): Promise<{ shareUserId: string; courseSlug?: string } | null> {
  let discounts = session.discounts;
  if (!discounts || discounts.length === 0) {
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
    const shareUserId = full.metadata?.shareUserId;
    if (shareUserId) {
      return { shareUserId, courseSlug: full.metadata?.courseSlug };
    }
  }
  return null;
}
