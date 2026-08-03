import { env } from "../env";
import { getBillingCustomerId } from "../services/billing-plan";
import { FakeBilling } from "./fake";
import { StripeBilling } from "./stripe";
import {
  BillingDisabledError,
  BillingError,
  type BillingProvider,
} from "./types";

export type { FakeBillingCall, MintWebhookInput } from "./fake";
export {
  FAKE_BILLING_ID,
  FAKE_BILLING_SIGNATURE_HEADER,
  FakeBilling,
} from "./fake";
export {
  STRIPE_ID,
  STRIPE_SIGNATURE_HEADER,
  STRIPE_TOLERANCE_SECONDS,
  StripeBilling,
  stripeEventToBillingEvent,
  verifyStripeSignature,
} from "./stripe";
export * from "./types";

/**
 * The single entry point every caller uses to reach billing — the same shape as
 * `getSubstrate()`, so the choice of implementation stays one env var rather
 * than an import graph.
 */

/** The fake is a SINGLETON per process, and has to be: its whole state (the
 * call log, the event counter) is in memory, and a fresh instance per request
 * would make local dev unable to see its own minted events. */
let fakeSingleton: FakeBilling | undefined;

/** Stripe is a singleton for the other reason: stateless, but holding a secret
 * and a connection-reusing transport. */
let stripeSingleton: StripeBilling | undefined;

export function getBilling(): BillingProvider {
  switch (env.CLOUD_BILLING) {
    case "disabled":
      // The operator asked for no billing. Every surface refuses — there is no
      // provider to hand back, and inventing an inert one would let a checkout
      // silently succeed at nothing.
      throw new BillingDisabledError();
    case "fake":
      fakeSingleton ??= new FakeBilling();
      return fakeSingleton;
    case "stripe":
      // Fail CLOSED, and say which var is missing. Falling back to the fake
      // here would be the worst outcome available: a webhook endpoint that
      // accepts unverified plan changes from anyone who finds the URL.
      if (!env.CLOUD_STRIPE_SECRET_KEY) {
        throw new BillingError(
          "CLOUD_BILLING=stripe requires CLOUD_STRIPE_SECRET_KEY; refusing to start (a missing key never falls back to fake billing)",
          { code: "billing_not_configured" },
        );
      }
      stripeSingleton ??= new StripeBilling({
        secretKey: env.CLOUD_STRIPE_SECRET_KEY,
        webhookSecret: env.CLOUD_STRIPE_WEBHOOK_SECRET,
        prices: {
          self_serve: env.CLOUD_STRIPE_PRICE_SELF_SERVE,
          dedicated: env.CLOUD_STRIPE_PRICE_DEDICATED,
        },
        portalReturnUrl: `${env.CLOUD_PUBLIC_URL}/settings`,
        // The composition root is the one place allowed to know both halves:
        // the provider stays database-free, and the customer handle it needs
        // comes from the column `PlanService` writes.
        resolveCustomerId: getBillingCustomerId,
      });
      return stripeSingleton;
  }
}

/** Test/dev helper: the process-wide fake, or a throw if it is not active. */
export function getFakeBilling(): FakeBilling {
  const provider = getBilling();
  if (!(provider instanceof FakeBilling)) {
    throw new BillingError(
      `the active billing provider is "${env.CLOUD_BILLING}", not the fake`,
    );
  }
  return provider;
}
