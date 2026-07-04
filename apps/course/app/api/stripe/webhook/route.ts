import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import type Stripe from "stripe";
import { skuTitle } from "@/lib/courses";
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { recordPurchase, revokePurchase } from "@/lib/entitlements";
import {
  emitGifted,
  emitGiftPurchased,
  emitGiftRedeemed,
  emitPurchased,
  emitShareRedeemed,
} from "@/lib/events";
import {
  giftIdFromSession,
  markGiftRedeemed,
  recordGiftAndMintCode,
} from "@/lib/gifts";
import { shareAttributionFromSession } from "@/lib/share-codes";
import { getStripe, paywallConfigured, webhookConfigured } from "@/lib/stripe";

export const runtime = "nodejs";

/**
 * POST /api/stripe/webhook — Stripe event sink.
 *
 * - Reads the RAW body (req.text()) — never JSON.parse first, or the signature
 *   check fails.
 * - Verifies the signature (fail-closed: 503 if unconfigured, 400 on bad sig).
 * - checkout.session.completed → record the entitlement (idempotent on the
 *   checkout-session unique index) and emit course.purchased once per new row.
 *   Gift sessions (metadata.gift) mint a single-use code instead of granting
 *   the buyer access; discounted sessions that trace back to a gift coupon
 *   mark the gift redeemed and notify the buyer.
 * - charge.refunded → revoke access by payment intent.
 */

async function userById(
  id: string,
): Promise<{ id: string; email: string; name: string | null } | null> {
  const rows = await db
    .select({ id: user.id, email: user.email, name: user.name })
    .from(user)
    .where(eq(user.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** A completed GIFT session: mint the code, store the row, emit the events. */
async function handleGiftSession(s: Stripe.Checkout.Session): Promise<void> {
  const courseSlug = s.metadata?.courseSlug;
  const buyerUserId = s.metadata?.userId ?? s.client_reference_id ?? undefined;
  if (!courseSlug || !buyerUserId) return;
  const recipientEmail = s.metadata?.recipientEmail ?? null;

  const result = await recordGiftAndMintCode({
    buyerUserId,
    courseSlug,
    recipientEmail,
    stripeCheckoutSessionId: s.id,
    amount: s.amount_total ?? null,
    currency: s.currency ?? null,
  });
  if (!result?.isNew) return; // retried delivery of a fully-processed gift

  const buyer = await userById(buyerUserId);
  const buyerEmail =
    buyer?.email ?? s.customer_details?.email ?? s.customer_email ?? undefined;
  const title = skuTitle(courseSlug);
  if (buyerEmail) {
    await emitGiftPurchased(
      { id: buyerUserId, email: buyerEmail, name: buyer?.name },
      {
        courseSlug,
        courseTitle: title,
        code: result.code,
        recipientEmail,
        amount: s.amount_total ?? null,
        currency: s.currency ?? null,
      },
    );
  }
  if (recipientEmail) {
    await emitGifted(recipientEmail, {
      courseSlug,
      courseTitle: title,
      code: result.code,
      buyerName: buyer?.name ?? null,
    });
  }
}

/**
 * A discounted purchase MAY be a gift redemption — trace the applied coupon
 * back to its gift row via metadata and notify the buyer once. Failing that,
 * it may be a SHARE-code redemption (metadata.shareUserId) — close the
 * sharer's loop instead (idempotent on the redeeming session id).
 */
async function handlePossibleRedemption(
  s: Stripe.Checkout.Session,
  redeemedByUserId: string,
): Promise<void> {
  if (!s.total_details?.amount_discount) return;
  const giftId = await giftIdFromSession(s);
  if (giftId) {
    const redeemed = await markGiftRedeemed(giftId, redeemedByUserId);
    if (!redeemed) return; // already marked (retry) or unknown gift
    const [buyer, redeemer] = await Promise.all([
      userById(redeemed.buyerUserId),
      userById(redeemedByUserId),
    ]);
    if (buyer) {
      await emitGiftRedeemed(buyer, {
        courseSlug: redeemed.courseSlug,
        courseTitle: skuTitle(redeemed.courseSlug),
        redeemerName: redeemer?.name ?? null,
        redeemerEmail: redeemer?.email ?? null,
        recipientEmail: redeemed.recipientEmail,
      });
    }
    return;
  }

  const share = await shareAttributionFromSession(s);
  if (!share) return; // an ordinary promotion code
  const [sharer, redeemer] = await Promise.all([
    userById(share.shareUserId),
    userById(redeemedByUserId),
  ]);
  if (!sharer) return;
  const courseSlug = share.courseSlug ?? s.metadata?.courseSlug ?? "";
  await emitShareRedeemed(sharer, {
    courseSlug,
    courseTitle: skuTitle(courseSlug),
    sessionId: s.id,
    redeemerName: redeemer?.name ?? null,
  });
}
export async function POST(req: NextRequest): Promise<Response> {
  if (!paywallConfigured() || !webhookConfigured()) {
    return new Response("stripe webhook not configured", { status: 503 });
  }

  const raw = await req.text();
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("missing signature", { status: 400 });

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(
      raw,
      sig,
      // biome-ignore lint/style/noNonNullAssertion: webhookConfigured() guarded above
      process.env.STRIPE_WEBHOOK_SECRET!,
    );
  } catch {
    return new Response("invalid signature", { status: 400 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      const s = event.data.object as Stripe.Checkout.Session;
      const courseSlug = s.metadata?.courseSlug;
      const userId = s.metadata?.userId ?? s.client_reference_id ?? undefined;
      const email = s.customer_details?.email ?? s.customer_email ?? undefined;

      if (s.metadata?.gift === "true") {
        await handleGiftSession(s);
      } else if (courseSlug && userId) {
        const isNew = await recordPurchase({
          userId,
          courseSlug,
          stripeCustomerId:
            typeof s.customer === "string"
              ? s.customer
              : (s.customer?.id ?? null),
          stripeCheckoutSessionId: s.id,
          stripePaymentIntentId:
            typeof s.payment_intent === "string"
              ? s.payment_intent
              : (s.payment_intent?.id ?? null),
          amount: s.amount_total ?? null,
          currency: s.currency ?? null,
        });
        if (isNew && email) {
          await emitPurchased(
            { id: userId, email },
            courseSlug,
            skuTitle(courseSlug),
            s.amount_total ?? null,
            s.currency ?? null,
          );
        }
        if (isNew) {
          await handlePossibleRedemption(s, userId);
        }
      }
    } else if (event.type === "charge.refunded") {
      // `charge.refunded === true` only when FULLY refunded — a partial refund
      // leaves it false, so a partial doesn't revoke course access.
      const charge = event.data.object as Stripe.Charge;
      const pi =
        typeof charge.payment_intent === "string"
          ? charge.payment_intent
          : charge.payment_intent?.id;
      if (charge.refunded && pi) await revokePurchase(pi);
    }
  } catch {
    // A processing failure after a verified signature — 500 so Stripe retries.
    return new Response("processing error", { status: 500 });
  }

  return Response.json({ received: true });
}
