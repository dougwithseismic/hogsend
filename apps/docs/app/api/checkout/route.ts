import { headers } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { tierPriceId, toServiceTier } from "@/lib/pricing";
import { checkoutConfigured, getStripe } from "@/lib/stripe";

export const runtime = "nodejs";

/**
 * POST /api/checkout — create a Stripe Checkout Session for a self-serve
 * service tier (Managed subscription, or the one-time Setup week) and
 * 303-redirect the browser to Stripe's hosted page. Driven by the <CheckoutButton>
 * form (`tier` + optional `next` fields). No client JS, no card handling.
 *
 * The paid closing signal is NOT handled here: on payment, Stripe's webhook
 * fires to the dogfood `stripe-services` endpoint, which verifies the signature
 * and emits `service.purchased` into the services funnel. This route only opens
 * the session, stamping `metadata.plan` so that webhook can map it to a deal.
 */

/** Only allow same-site relative return paths (no open redirect). */
function safePath(next: string, fallback: string): string {
  return next.startsWith("/") && !next.startsWith("//") ? next : fallback;
}

export async function POST(req: NextRequest): Promise<Response> {
  const session = await auth.api.getSession({ headers: await headers() });

  const form = await req.formData();
  const tier = toServiceTier(form.get("tier"));
  // Return URLs are built from the configured origin, never the request Host
  // header — Stripe success/cancel must point at our own site, input-free.
  const base = env.BETTER_AUTH_URL.replace(/\/+$/, "");
  const next = safePath(String(form.get("next") ?? ""), "/pricing");

  // Unknown tier, or a tier that doesn't self-serve (self-host / done-for-you) →
  // send them to the services page rather than 500 a bad form.
  if (!tier || tier.convert.kind !== "checkout") {
    return NextResponse.redirect(`${base}/service`, 303);
  }

  // Not signed in → bounce to sign-in and return to the page they were on. The
  // shared *.hogsend.com session means a course login already counts; they
  // click buy once more when back (no auto-resume machinery to carry a POST).
  if (!session) {
    return NextResponse.redirect(
      `${base}/sign-in?next=${encodeURIComponent(next)}`,
      303,
    );
  }

  const priceId = tierPriceId(tier);
  // Checkout off (no Stripe key) or no price mapped for this tier → fall back to
  // the booking form so the CTA never dead-ends on a misconfigured deploy.
  if (!checkoutConfigured() || !priceId) {
    return NextResponse.redirect(`${base}/service#enquire`, 303);
  }

  const { stripeMode, plan } = tier.convert;
  const checkout = await getStripe().checkout.sessions.create({
    mode: stripeMode,
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: session.user.id,
    customer_email: session.user.email,
    // `plan` is what the dogfood webhook maps to a funnel/deal; `tier`/`userId`
    // are for our own traceability.
    metadata: { plan, tier: tier.id, userId: session.user.id },
    // Stamp the plan on the subscription too, so a renewal invoice can carry it
    // (the webhook also falls back to a price-id → plan map for renewals).
    ...(stripeMode === "subscription"
      ? { subscription_data: { metadata: { plan } } }
      : {}),
    allow_promotion_codes: true,
    // Subscriptions invoice automatically; only one-time payments need this (and
    // Stripe rejects invoice_creation in subscription mode).
    ...(stripeMode === "payment"
      ? { invoice_creation: { enabled: true } }
      : {}),
    success_url: `${base}/service/thanks?plan=${encodeURIComponent(plan)}`,
    cancel_url: `${base}${next}?checkout=cancelled`,
  });

  if (!checkout.url) {
    return NextResponse.json(
      { error: "could not create checkout session" },
      { status: 502 },
    );
  }
  return NextResponse.redirect(checkout.url, 303);
}
