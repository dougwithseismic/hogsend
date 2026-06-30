import Stripe from "stripe";

/**
 * Stripe client + config gate for the course paywall. Mirrors lib/ingest.ts:
 * env is read directly from process.env (NOT lib/env's fail-closed required
 * set), so an unconfigured deploy degrades gracefully — the paywall simply
 * stays OFF and the site keeps its free-with-sign-up gate. The secret key never
 * leaves the server.
 */

let cached: Stripe | null = null;

/** True when a Stripe secret key is present — the global paywall switch. A
 *  course is only actually paywalled when it ALSO has a price id mapped
 *  (see isCoursePaywalled in lib/entitlements). */
export function paywallConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/** True when webhook signature verification can run (fail-closed otherwise). */
export function webhookConfigured(): boolean {
  return Boolean(process.env.STRIPE_WEBHOOK_SECRET);
}

/** Lazily-built Stripe client. Throws if called without a secret key — callers
 *  must gate on paywallConfigured() first (routes 503/skip when unconfigured). */
export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  if (!cached) cached = new Stripe(key);
  return cached;
}
