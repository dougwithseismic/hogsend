import Stripe from "stripe";

/**
 * Stripe client + config gate for the services checkout. Mirrors lib/ingest.ts
 * and the course's lib/stripe.ts: env is read directly from process.env (NOT
 * lib/env's fail-closed required set), so an unconfigured deploy degrades
 * gracefully — checkout simply stays OFF and the paid CTAs fall back to the
 * booking form. The secret key never leaves the server.
 *
 * There is deliberately no webhook helper here: the paid closing signal
 * (`service.purchased` → the dogfood services funnel) is verified and emitted
 * by the dogfood `stripe-services` webhook, not by this marketing site. This
 * app only CREATES checkout sessions.
 */

let cached: Stripe | null = null;

/** True when a Stripe secret key is present — the checkout on/off switch. */
export function checkoutConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/** Lazily-built Stripe client. Throws if called without a secret key — callers
 *  must gate on checkoutConfigured() first (the route falls back otherwise). */
export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  if (!cached) cached = new Stripe(key);
  return cached;
}
