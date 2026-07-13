/**
 * Service-tier pricing — the single source of truth for how each paid tier
 * *converts* and (for self-serve tiers) which Stripe Price funds the charge.
 *
 * Display prose still lives in the page copy (service/pricing pages), but the
 * machine-relevant facts a checkout reads — the Stripe mode, the Price env var,
 * and the `plan` tag the dogfood `stripe-services` webhook maps to a funnel —
 * live here so the amount a customer is charged can't drift from the wiring
 * without touching one file. Price ids are read from env (never committed),
 * exactly like the course paywall: an unset var makes that tier non-purchasable
 * and the CTA falls back to the booking form, so an unconfigured deploy
 * degrades gracefully rather than dead-ending.
 *
 * `SERVICE_TIERS` carries no PII and reads no env at module load, so it is safe
 * to import from client components for display. Env is read ONLY inside
 * `tierPriceId()`, which the server checkout route calls.
 */

export type ServiceTierId = "self-host" | "managed" | "setup" | "done-for-you";

/**
 * The `plan` tag stamped on the Stripe session/subscription metadata. It MUST
 * be one of the three the dogfood `stripe-services` webhook maps to a deal
 * (`managed | setup | dfy`); anything else the webhook ignores.
 */
export type ServicePlan = "managed" | "setup" | "dfy";

/** How a tier converts a visitor. */
export type ConvertMode =
  /** Self-serve Stripe Checkout — subscription (recurring) or one-time payment. */
  | {
      kind: "checkout";
      stripeMode: "subscription" | "payment";
      /** Name of the env var holding the Stripe Price id (id stays in env). */
      priceEnvVar: string;
      plan: ServicePlan;
    }
  /** Consultative — routes to the on-page "request a call" inquiry form. */
  | { kind: "book" }
  /** A plain internal link (self-host → the docs). */
  | { kind: "link"; href: string };

export type ServiceTier = {
  id: ServiceTierId;
  name: string;
  /** Display price, e.g. "$149". Prose copy owns the surrounding sentence. */
  price: string;
  /** Display suffix, e.g. "/month", "one-time", "forever". */
  suffix: string;
  convert: ConvertMode;
};

export const SERVICE_TIERS: Record<ServiceTierId, ServiceTier> = {
  "self-host": {
    id: "self-host",
    name: "Self-hosted",
    price: "$0",
    suffix: "forever",
    convert: { kind: "link", href: "/docs/getting-started" },
  },
  managed: {
    id: "managed",
    name: "Managed instance",
    price: "$149",
    suffix: "/month",
    convert: {
      kind: "checkout",
      stripeMode: "subscription",
      priceEnvVar: "STRIPE_PRICE_SERVICE_MANAGED",
      plan: "managed",
    },
  },
  setup: {
    id: "setup",
    name: "Setup week",
    price: "$2,300",
    suffix: "one-time",
    convert: {
      kind: "checkout",
      stripeMode: "payment",
      priceEnvVar: "STRIPE_PRICE_SERVICE_SETUP",
      plan: "setup",
    },
  },
  "done-for-you": {
    id: "done-for-you",
    name: "Done-for-you lifecycle",
    price: "$1,500",
    suffix: "/month",
    convert: { kind: "book" },
  },
};

/** Narrow an arbitrary form value to a known tier, or undefined. */
export function toServiceTier(value: unknown): ServiceTier | undefined {
  return typeof value === "string" && value in SERVICE_TIERS
    ? SERVICE_TIERS[value as ServiceTierId]
    : undefined;
}

/**
 * The Stripe Price id funding a checkout tier, read from its mapped env var.
 * Server-only (reads process.env). Returns undefined for non-checkout tiers or
 * when the env var is unset — the caller then falls back to the booking form.
 */
export function tierPriceId(tier: ServiceTier): string | undefined {
  return tier.convert.kind === "checkout"
    ? process.env[tier.convert.priceEnvVar]
    : undefined;
}
