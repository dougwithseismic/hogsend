/**
 * The billing seam (PRD 06 task 2), built to the same law as the substrate
 * seam: business logic never sees a vendor type.
 *
 * What crosses this boundary is three verbs and one event shape. Everything
 * Stripe-specific — price ids, customer ids, the `checkout.session.completed`
 * vocabulary, the v1 signature scheme — lives INSIDE an implementation. The
 * plan service upstream reads `BillingEvent` and nothing else, which is what
 * makes `FakeBilling` a truthful stand-in for every test in the control plane.
 *
 * Two deliberate shapes:
 *  - `parseWebhook` VERIFIES and parses in one call. Splitting them would let a
 *    caller parse without verifying, and a webhook route that forgets to check a
 *    signature is a plan-change API open to the internet. There is no unverified
 *    path through this interface.
 *  - it returns `BillingEvent | null`. Providers deliver far more event types
 *    than a control plane acts on; `null` means "verified, and deliberately not
 *    actionable", which the route answers 200 to. An error is reserved for "I
 *    could not trust this at all".
 */

/** The purchasable plans. `trial` is a control-plane state, never a Stripe
 * subscription, so it is deliberately absent here. */
export type BillingPlan = "self_serve" | "dedicated";

export const BILLING_PLANS = ["self_serve", "dedicated"] as const;

export function isBillingPlan(value: unknown): value is BillingPlan {
  return (BILLING_PLANS as readonly string[]).includes(value as string);
}

/**
 * The four transitions the control plane acts on, named for what they MEAN
 * rather than for any vendor's event id:
 *  - `checkout_completed` — the tenant just bought a plan;
 *  - `subscription_updated` — the subscription is in good standing (a plan
 *    change, or a recovered payment). Carries a plan only when the event
 *    identifies one;
 *  - `subscription_canceled` — the subscription is over;
 *  - `payment_failed` — a charge failed; the dunning clock starts.
 */
export type BillingEventType =
  | "checkout_completed"
  | "subscription_updated"
  | "subscription_canceled"
  | "payment_failed";

export interface BillingEvent {
  type: BillingEventType;
  /** The control-plane `organizations.id`. Always resolved by the provider —
   * an event it cannot attribute is `null` from `parseWebhook`, never an event
   * with a guessed org. */
  organizationId: string;
  /** The plan the event puts the org on, or `null` when the event does not
   * identify one (a failed invoice, a recovery). A `null` plan NEVER changes
   * the org's plan. */
  plan: BillingPlan | null;
  /** Provider-issued event id. Recorded in the audit detail so a row in the
   * control plane can be traced back to a row in the provider's dashboard. */
  eventId: string;
  occurredAt: Date;
  /** The provider's customer handle, when the event carries one. Persisted on
   * the org so `getPortalUrl` has something to open. Opaque above the seam. */
  customerRef?: string;
  /** Verbatim provider payload. For audit/debugging only — reading a key out of
   * it above the seam re-couples business logic to a vendor. */
  raw: Record<string, unknown>;
}

export interface CreateCheckoutInput {
  organizationId: string;
  plan: BillingPlan;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutResult {
  /** Where to send the browser. Hosted by the provider. */
  url: string;
}

export interface PortalInput {
  organizationId: string;
}

export interface PortalResult {
  url: string;
}

export interface WebhookInput {
  /**
   * The RAW request body, byte-for-byte as received. Not a parsed object: every
   * signature scheme hashes the exact bytes, and `JSON.parse` → `JSON.stringify`
   * loses key order and whitespace, which would fail verification for reasons
   * no one could debug.
   */
  payload: string;
  headers: Record<string, string>;
}

/** The frozen seam. Implementations: `FakeBilling`, `StripeBilling`. */
export interface BillingProvider {
  /** `"fake"` | `"stripe"` — which implementation answered. */
  readonly id: string;
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult>;
  /** Verifies the signature FIRST; throws `BillingSignatureError` if it does
   * not hold. Returns `null` for a verified event outside the lifecycle. */
  parseWebhook(input: WebhookInput): Promise<BillingEvent | null>;
  /** Self-serve subscription management, hosted by the provider. */
  getPortalUrl(input: PortalInput): Promise<PortalResult>;
}

/**
 * The only error type that crosses the seam.
 *
 * `retryable` carries the same meaning as `SubstrateError.retryable` and
 * defaults to `false` for the same reason: a caller must not burn attempts on a
 * permanent failure, so an implementation opts IN. `code` is the stable slug an
 * HTTP layer branches on.
 */
export class BillingError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { code?: string; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? "billing_error";
    this.retryable = options.retryable ?? false;
  }
}

/**
 * The payload did not verify. NEVER retryable — the bytes will not start
 * matching, and the caller must answer 4xx so the provider stops re-delivering
 * something we will never accept.
 */
export class BillingSignatureError extends BillingError {
  constructor(reason: string, options: { cause?: unknown } = {}) {
    super(`Billing webhook signature rejected: ${reason}`, {
      code: "invalid_signature",
      retryable: false,
      cause: options.cause,
    });
  }
}

/**
 * The operator has not finished wiring billing — a missing price id, no webhook
 * secret, no customer on file. Our fault, not the request's, so it is
 * RETRYABLE: the provider should re-deliver after a human fixes the config
 * rather than the event being lost.
 */
export class BillingConfigError extends BillingError {
  constructor(message: string) {
    super(message, { code: "billing_not_configured", retryable: true });
  }
}

/**
 * Billing is switched OFF for this deployment (`CLOUD_BILLING=disabled`).
 *
 * Distinct from `BillingConfigError` because it is not a mistake: an operator
 * asked for a control plane with no billing, and every billing surface must
 * then refuse rather than half-work. RETRYABLE is false — re-delivering changes
 * nothing while the deployment is configured this way — but the webhook route
 * answers 503 rather than 400, because the provider's payload was never the
 * problem and a later re-delivery (after billing IS wired) should be accepted.
 */
export class BillingDisabledError extends BillingError {
  constructor() {
    super(
      'Billing is disabled for this deployment (CLOUD_BILLING="disabled"); set CLOUD_BILLING=stripe to enable it',
      { code: "billing_disabled", retryable: false },
    );
  }
}

/** Case-insensitive header read — HTTP header names are not case-sensitive and
 * every framework normalizes them differently. */
export function headerValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}
