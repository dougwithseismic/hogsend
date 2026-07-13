/**
 * Service-tier definitions — the source of truth for how each tier *converts*
 * (self-serve checkout, a booked call, or a plain link).
 *
 * This site holds NO Stripe config. Checkout sessions are created by the Hono
 * API (the dogfood's `POST /checkout`), which owns the Stripe secret key + price
 * ids; here we only need to know which tiers are self-serve (render a checkout
 * button) vs consultative (route to the booking form). The docs `/api/checkout`
 * route verifies the visitor's session and forwards the tier id — the API maps
 * it to a price, mode, and plan.
 *
 * Reads no env at module load, carries no secrets — safe to import anywhere.
 */

export type ServiceTierId = "self-host" | "managed" | "setup" | "done-for-you";

/** How a tier converts a visitor. */
export type ConvertMode =
  /** Self-serve Stripe Checkout (the API decides subscription vs one-time). */
  | { kind: "checkout" }
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
    convert: { kind: "checkout" },
  },
  setup: {
    id: "setup",
    name: "Setup week",
    price: "$2,300",
    suffix: "one-time",
    convert: { kind: "checkout" },
  },
  "done-for-you": {
    id: "done-for-you",
    name: "Done-for-you lifecycle",
    price: "$1,500",
    suffix: "/month",
    convert: { kind: "book" },
  },
};

/** True when `value` is a known self-serve checkout tier (Managed / Setup). */
export function isCheckoutTier(value: unknown): value is ServiceTierId {
  return (
    typeof value === "string" &&
    value in SERVICE_TIERS &&
    SERVICE_TIERS[value as ServiceTierId].convert.kind === "checkout"
  );
}
