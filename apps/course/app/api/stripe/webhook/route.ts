import type { NextRequest } from "next/server";
import type Stripe from "stripe";
import { skuTitle } from "@/lib/courses";
import { recordPurchase, revokePurchase } from "@/lib/entitlements";
import { emitPurchased } from "@/lib/events";
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
 * - charge.refunded → revoke access by payment intent.
 */
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

      if (courseSlug && userId) {
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
