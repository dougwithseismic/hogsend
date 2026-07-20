/**
 * Service-tier definitions — the source of truth for what each tier *costs*,
 * what it includes, and how it *converts* (a booked call or a plain link).
 *
 * The offer is a three-step ladder: an Audit that anyone can say yes to, a
 * fixed-scope Build, and a Run retainer. Every step converts through the
 * on-page inquiry form; nothing is self-serve.
 *
 * This site holds NO Stripe config. The `checkout` convert mode and the
 * `/api/checkout` route are retained (dormant, and gated behind the
 * `service-self-serve-checkout` flag) so a future fixed-scope tier can be made
 * self-serve without rebuilding the pipe. No tier uses it today, so
 * `isCheckoutTier` returns false for everything and the route falls back to the
 * booking form.
 *
 * Reads no env at module load, carries no secrets — safe to import anywhere.
 */

export type ServiceTierId = "audit" | "build" | "run" | "self-host";

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
  /** Display price, e.g. "$9,500". Prose copy owns the surrounding sentence. */
  price: string;
  /** Display suffix, e.g. "/month", "one week", "forever". */
  suffix: string;
  /** One-paragraph promise, rendered under the price. */
  promise: string;
  /** What the step covers — the accent-bulleted checklist. */
  includes: string[];
  convert: ConvertMode;
};

export const SERVICE_TIERS: Record<ServiceTierId, ServiceTier> = {
  audit: {
    id: "audit",
    name: "Lifecycle Audit",
    price: "$2,000",
    suffix: "one week",
    promise:
      "I go through your events, your emails, and your funnel, and come back with what's leaking and what to do about it. If you go on to the build, the $2,000 comes off it.",
    includes: [
      "Every lifecycle moment in your funnel, mapped",
      "What your current emails do, and what they miss",
      "A 90-day roadmap, prioritised by revenue",
      "Yours to keep, and to act on without me",
    ],
    convert: { kind: "book" },
  },
  build: {
    id: "build",
    name: "30-Day Build",
    price: "$9,500",
    suffix: "thirty days",
    promise:
      "Thirty days from kickoff, your lifecycle program is live: journeys, templates, and tracking, shipped as TypeScript in your own repo. Built on Hogsend, so it takes 30 days instead of 90.",
    includes: [
      "Onboarding, activation, and win-back journeys, live",
      "Email templates written and built for your product",
      "Event tracking wired to your analytics",
      "Everything in your repo, reviewed like the rest of your product",
    ],
    convert: { kind: "book" },
  },
  run: {
    id: "run",
    name: "Run",
    price: "from $4,000",
    suffix: "/month",
    promise:
      "I keep it working and keep making it better. New journeys as your product changes, experiments on what's already there, and a monthly read on what it earned.",
    includes: [
      "New journeys and experiments each month",
      "Monitoring, so a broken send gets caught",
      "A monthly report on what the program did",
      "Hosting and upkeep included",
    ],
    convert: { kind: "book" },
  },
  "self-host": {
    id: "self-host",
    name: "Self-hosted",
    price: "$0",
    suffix: "forever",
    promise:
      "The whole engine, source-available under ELv2. Deploy it yourself and write your own journeys. No per-contact billing, no seat count, no send meter.",
    includes: [
      "Every feature, no paid tier held back",
      "Runs on your infrastructure and your accounts",
      "Journeys as TypeScript in your repo",
      "No per-contact billing",
    ],
    convert: { kind: "link", href: "/docs/getting-started" },
  },
};

/** The paid ladder, in the order it's presented on /service. */
export const SERVICE_LADDER: ServiceTier[] = [
  SERVICE_TIERS.audit,
  SERVICE_TIERS.build,
  SERVICE_TIERS.run,
];

/**
 * True when `value` is a known self-serve checkout tier. No tier is self-serve
 * today — this stays so `/api/checkout` keeps compiling and can be re-armed.
 */
export function isCheckoutTier(value: unknown): value is ServiceTierId {
  return (
    typeof value === "string" &&
    value in SERVICE_TIERS &&
    SERVICE_TIERS[value as ServiceTierId].convert.kind === "checkout"
  );
}
