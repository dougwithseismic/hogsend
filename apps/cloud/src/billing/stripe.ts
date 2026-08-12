import { createHmac, timingSafeEqual } from "node:crypto";
import {
  BillingConfigError,
  BillingError,
  type BillingEvent,
  type BillingEventType,
  type BillingPlan,
  type BillingProvider,
  BillingSignatureError,
  type CheckoutResult,
  type CreateCheckoutInput,
  headerValue,
  isBillingPlan,
  type PortalInput,
  type PortalResult,
  type ReportUsageInput,
  type ReportUsageResult,
  type UsageMeter,
  type WebhookInput,
} from "./types";

/**
 * Stripe, over BARE `fetch` against the REST API — no `stripe` npm package.
 *
 * The same call `RailwaySubstrate` made, for the same reasons. The surface we
 * need is three endpoints and one HMAC scheme; the SDK would add a dependency
 * (and its transitive tree) to a control plane whose dependency list is
 * deliberately short, pull in a bundled API-version pin we would then have to
 * track, and — the deciding one — hand us a client that is awkward to test
 * without either network access or a mocking library. A `transport` function is
 * a seam a test can satisfy in three lines, which is why every assertion in
 * `billing-stripe.test.ts` runs offline.
 *
 * What lives in here and nowhere else: the endpoint URLs, the form encoding,
 * the price-id ↔ plan mapping, Stripe's event vocabulary, and the v1 signature
 * scheme. Above the seam there is only `BillingEvent`.
 */

export const STRIPE_ID = "stripe";
export const STRIPE_API_URL = "https://api.stripe.com";

/**
 * PINNED. Stripe's API is versioned by date and an account's default version
 * moves when Stripe upgrades it; an unpinned integration would change payload
 * shape underneath a running control plane. Stripe keeps old versions working
 * indefinitely, so an old pin is safe and a silent upgrade is not.
 */
export const STRIPE_API_VERSION = "2024-06-20";

export const STRIPE_SIGNATURE_HEADER = "stripe-signature";

/** Stripe's own documented default replay window. */
export const STRIPE_TOLERANCE_SECONDS = 300;

export interface StripeHttpRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  /** Already form-encoded body. */
  body: string;
}

export interface StripeHttpResponse {
  status: number;
  body: string;
}

/** The injectable wire. Narrower than `fetch` so no test can reach the network
 * by forgetting to stub something. */
export type StripeTransport = (
  request: StripeHttpRequest,
) => Promise<StripeHttpResponse>;

export interface StripeBillingOptions {
  /** `sk_...`. NEVER logged. */
  secretKey: string;
  /** `whsec_...`. Absent → `parseWebhook` refuses outright rather than
   * accepting anything. */
  webhookSecret?: string | undefined;
  /** Price id per plan. A plan with no price cannot be checked out. */
  prices?: Partial<Record<BillingPlan, string | undefined>> | undefined;
  /**
   * Stripe meter EVENT NAME per neutral meter id (PRD 09). A meter with no
   * configured name cannot be reported, and fails closed rather than inventing
   * one: a guessed `event_name` is accepted by Stripe and aggregated into
   * nothing, so the usage would vanish silently instead of erroring.
   */
  meters?: Partial<Record<UsageMeter, string | undefined>> | undefined;
  /** Where the hosted portal returns the tenant to. */
  portalReturnUrl?: string | undefined;
  /**
   * The org's Stripe customer handle, recorded by `PlanService` from an earlier
   * `checkout_completed`. INJECTED because a provider owns no database — the
   * same one-directional ignorance the substrate seam holds, in reverse.
   */
  resolveCustomerId?:
    | ((organizationId: string) => Promise<string | undefined>)
    | undefined;
  apiUrl?: string | undefined;
  transport?: StripeTransport | undefined;
  /** Injectable clock, so signature-tolerance tests need no fake timers. */
  nowSeconds?: (() => number) | undefined;
  toleranceSeconds?: number | undefined;
}

/**
 * Verify Stripe's `Stripe-Signature` header. Exported and pure: this is the one
 * piece of the integration that is a SECURITY boundary, and it is proven
 * directly against synthetic HMAC fixtures rather than incidentally through a
 * route test.
 *
 * The scheme (Stripe docs, "Verify webhook signatures manually"):
 *   header  = `t=<unix seconds>,v1=<hex hmac>[,v1=<hex hmac>…]`
 *   signed  = `${t}.${rawPayload}`
 *   compare = HMAC-SHA256(endpointSecret, signed), hex
 *
 * Three things it refuses, each a real attack:
 *  - no `t` or no `v1` — a header that cannot be checked is not a header;
 *  - a timestamp outside the tolerance, in EITHER direction (a stale capture
 *    replayed later, or a clock-skewed forgery dated forward);
 *  - a digest mismatch, compared in constant time.
 */
export function verifyStripeSignature(input: {
  payload: string;
  header: string | undefined;
  secret: string;
  nowSeconds: number;
  toleranceSeconds?: number;
}): { timestamp: number } {
  const tolerance = input.toleranceSeconds ?? STRIPE_TOLERANCE_SECONDS;
  if (!input.header) {
    throw new BillingSignatureError(
      `missing ${STRIPE_SIGNATURE_HEADER} header`,
    );
  }

  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of input.header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (!value) continue;
    if (key === "t") timestamp = Number(value);
    else if (key === "v1") signatures.push(value);
  }

  if (timestamp === undefined || !Number.isFinite(timestamp)) {
    throw new BillingSignatureError("header carries no usable timestamp");
  }
  if (signatures.length === 0) {
    throw new BillingSignatureError("header carries no v1 signature");
  }
  if (Math.abs(input.nowSeconds - timestamp) > tolerance) {
    throw new BillingSignatureError(
      `timestamp is outside the ${tolerance}s tolerance`,
    );
  }

  const expected = createHmac("sha256", input.secret)
    .update(`${timestamp}.${input.payload}`)
    .digest("hex");
  // Any ONE matching v1 is enough: Stripe sends several during a secret
  // rotation, and rejecting the set because one is stale would drop live events.
  const matched = signatures.some((candidate) =>
    constantTimeEquals(candidate, expected),
  );
  if (!matched) {
    throw new BillingSignatureError("no signature matched the payload");
  }

  return { timestamp };
}

/**
 * Did Stripe refuse this meter event because it has already seen the
 * identifier?
 *
 * Matched on the message because Stripe returns a plain `invalid_request_error`
 * for it. Deliberately NARROW: anything else is a real failure and must stay
 * one, because treating an unknown 400 as "already billed" would silently drop
 * revenue. The control-plane ledger is the primary guard either way; this is
 * the belt to its braces.
 */
function isDuplicateIdentifier(error: unknown): boolean {
  if (!(error instanceof BillingError)) return false;
  return (
    /identifier/i.test(error.message) && /alread|duplicat/i.test(error.message)
  );
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // `timingSafeEqual` throws on a length mismatch; the length itself is not a
  // secret (a hex sha256 is always 64 chars), so comparing it first is safe.
  return left.length === right.length && timingSafeEqual(left, right);
}

export class StripeBilling implements BillingProvider {
  readonly id = STRIPE_ID;

  private readonly options: StripeBillingOptions;
  private readonly apiUrl: string;
  private readonly transport: StripeTransport;
  private readonly nowSeconds: () => number;

  constructor(options: StripeBillingOptions) {
    this.options = options;
    this.apiUrl = options.apiUrl ?? STRIPE_API_URL;
    this.transport = options.transport ?? defaultTransport();
    this.nowSeconds =
      options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult> {
    const price = this.options.prices?.[input.plan];
    if (!price) {
      // Fail closed BEFORE the wire: a session created without a price is not a
      // subscription, and Stripe's own error would arrive far from the cause.
      throw new BillingConfigError(
        `No Stripe price id configured for plan "${input.plan}" (CLOUD_STRIPE_PRICE_${input.plan.toUpperCase()})`,
      );
    }

    const session = await this.post("/v1/checkout/sessions", {
      mode: "subscription",
      "line_items[0][price]": price,
      "line_items[0][quantity]": "1",
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      // THREE places carry the org, on purpose. `client_reference_id` and the
      // session metadata attribute the checkout itself; the SUBSCRIPTION
      // metadata is the one that matters months later, because every renewal,
      // failure and cancellation webhook is about the subscription and would
      // otherwise be unattributable.
      client_reference_id: input.organizationId,
      "metadata[organizationId]": input.organizationId,
      "metadata[plan]": input.plan,
      "subscription_data[metadata][organizationId]": input.organizationId,
      "subscription_data[metadata][plan]": input.plan,
    });

    const url = session.url;
    if (typeof url !== "string") {
      throw new BillingError("Stripe returned a checkout session with no url", {
        retryable: true,
      });
    }
    return { url };
  }

  async getPortalUrl(input: PortalInput): Promise<PortalResult> {
    const customer = await this.options.resolveCustomerId?.(
      input.organizationId,
    );
    if (!customer) {
      throw new BillingConfigError(
        `Organization "${input.organizationId}" has no Stripe customer on file; it has not completed a checkout`,
      );
    }

    const session = await this.post("/v1/billing_portal/sessions", {
      customer,
      ...(this.options.portalReturnUrl
        ? { return_url: this.options.portalReturnUrl }
        : {}),
    });

    const url = session.url;
    if (typeof url !== "string") {
      throw new BillingError("Stripe returned a portal session with no url", {
        retryable: true,
      });
    }
    return { url };
  }

  /**
   * One meter event, over Stripe's usage-based billing API.
   *
   * `identifier` is the whole no-double-bill story on this side of the seam:
   * Stripe deduplicates meter events by it, so the caller can retry an attempt
   * whose outcome it never learned. A duplicate comes back as an API error
   * rather than a success, and it is translated into `deduplicated: true` —
   * refusing to bill twice is exactly what we asked for, and reporting it as a
   * failure would make the caller retry a thing that already worked.
   */
  async reportUsage(input: ReportUsageInput): Promise<ReportUsageResult> {
    const eventName = this.options.meters?.[input.meter];
    if (!eventName) {
      throw new BillingConfigError(
        `No Stripe meter event name configured for "${input.meter}" (CLOUD_STRIPE_METER_${input.meter.toUpperCase()})`,
      );
    }

    const customer = await this.options.resolveCustomerId?.(
      input.organizationId,
    );
    if (!customer) {
      throw new BillingConfigError(
        `Organization "${input.organizationId}" has no Stripe customer on file; metered usage cannot be attributed`,
      );
    }

    try {
      await this.post("/v1/billing/meter_events", {
        event_name: eventName,
        identifier: input.idempotencyKey,
        timestamp: String(Math.floor(input.occurredAt.getTime() / 1000)),
        "payload[stripe_customer_id]": customer,
        "payload[value]": String(input.quantity),
      });
    } catch (error) {
      if (isDuplicateIdentifier(error)) return { deduplicated: true };
      throw error;
    }
    return { deduplicated: false };
  }

  async parseWebhook(input: WebhookInput): Promise<BillingEvent | null> {
    const secret = this.options.webhookSecret;
    if (!secret) {
      // Refusing is the whole point: with no secret there is no way to tell
      // Stripe from anyone else who found the URL.
      throw new BillingConfigError(
        "CLOUD_STRIPE_WEBHOOK_SECRET is not set; refusing to accept a webhook that cannot be verified",
      );
    }

    verifyStripeSignature({
      payload: input.payload,
      header: headerValue(input.headers, STRIPE_SIGNATURE_HEADER),
      secret,
      nowSeconds: this.nowSeconds(),
      ...(this.options.toleranceSeconds !== undefined
        ? { toleranceSeconds: this.options.toleranceSeconds }
        : {}),
    });

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(input.payload) as Record<string, unknown>;
    } catch (cause) {
      throw new BillingError("Stripe webhook payload is not JSON", { cause });
    }

    return stripeEventToBillingEvent(event, this.planForPrice());
  }

  /** Inverse of the configured price map — how a subscription event that
   * carries no metadata plan is still resolved. */
  private planForPrice(): Map<string, BillingPlan> {
    const map = new Map<string, BillingPlan>();
    for (const plan of ["self_serve", "dedicated"] as const) {
      const price = this.options.prices?.[plan];
      if (price) map.set(price, plan);
    }
    return map;
  }

  private async post(
    path: string,
    form: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    let response: StripeHttpResponse;
    try {
      response = await this.transport({
        url: `${this.apiUrl}${path}`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.secretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Stripe-Version": STRIPE_API_VERSION,
        },
        body: new URLSearchParams(form).toString(),
      });
    } catch (cause) {
      // A thrown transport is a network fault (DNS, reset, timeout): the
      // request never landed, so another attempt is honest.
      throw new BillingError(`Stripe request failed: ${message(cause)}`, {
        retryable: true,
        cause,
      });
    }

    if (response.status >= 200 && response.status < 300) {
      try {
        return JSON.parse(response.body) as Record<string, unknown>;
      } catch (cause) {
        throw new BillingError("Stripe returned a non-JSON success", {
          retryable: true,
          cause,
        });
      }
    }

    // 429 and 5xx are the moment's fault; a 4xx is the request's and retrying
    // it would burn the caller's budget for nothing.
    throw new BillingError(
      `Stripe API error (HTTP ${response.status}): ${stripeErrorMessage(response.body)}`,
      { retryable: response.status === 429 || response.status >= 500 },
    );
  }
}

/**
 * Stripe's event vocabulary → the seam's four verbs. Exported for direct
 * testing: this mapping is where a wrong guess would silently downgrade a
 * paying tenant, so it is a rule with its own assertions rather than a switch
 * buried in a class.
 *
 * Returns `null` for both "not a lifecycle event" and "a lifecycle event with
 * no organization on it". The second is the important one: attributing a
 * subscription to a guessed org would be worse than ignoring it, and an
 * unattributable event is a wiring bug that belongs in Stripe's dashboard, not
 * in a control-plane write.
 */
export function stripeEventToBillingEvent(
  event: Record<string, unknown>,
  planForPrice: Map<string, BillingPlan>,
): BillingEvent | null {
  const stripeType = typeof event.type === "string" ? event.type : "";
  const object = objectOf(event);
  if (!object) return null;

  const type = mapStripeType(stripeType, object);
  if (!type) return null;

  const organizationId = resolveOrganizationId(object);
  if (!organizationId) return null;

  const created = Number(event.created);
  return {
    type,
    organizationId,
    plan: resolvePlan(object, planForPrice),
    eventId: typeof event.id === "string" ? event.id : "",
    occurredAt: new Date(
      (Number.isFinite(created) ? created : Math.floor(Date.now() / 1000)) *
        1000,
    ),
    ...(typeof object.customer === "string"
      ? { customerRef: object.customer }
      : {}),
    raw: event,
  };
}

function mapStripeType(
  stripeType: string,
  object: Record<string, unknown>,
): BillingEventType | null {
  switch (stripeType) {
    case "checkout.session.completed":
      return "checkout_completed";
    case "customer.subscription.deleted":
      return "subscription_canceled";
    case "customer.subscription.created":
    case "customer.subscription.updated":
      return subscriptionStatusToType(object.status);
    case "invoice.payment_failed":
      return "payment_failed";
    case "invoice.payment_succeeded":
    case "invoice.paid":
      // The recovery signal: good standing again, with no plan claim of its own.
      return "subscription_updated";
    default:
      return null;
  }
}

/**
 * A subscription's status → the seam's verbs, as an ALLOWLIST.
 *
 * A denylist here ("anything that is not canceled is fine") is the single most
 * expensive mistake available in this file, because Stripe moves a subscription
 * to `past_due` on the very charge failure that emits
 * `invoice.payment_failed` — and emits `customer.subscription.updated` for that
 * status change. Read as good standing, that update lands on
 * `PlanService.applyGoodStanding`, which clears `dunning_since` and even lifts a
 * dunning suspension: every failed charge would wipe the 14-day grace clock the
 * failure just started, and no tenant would ever be suspended for non-payment.
 * So each status is named, and an unknown one is `null` (verified, deliberately
 * not actionable) rather than assumed healthy.
 *
 *  - `active` / `trialing` — money is current (or not yet due). Good standing.
 *  - `past_due` — a charge failed and Stripe is retrying. NOT actionable here:
 *    the invoice events are the single writer of the dunning clock
 *    (`invoice.payment_failed` starts it, `invoice.payment_succeeded` ends it),
 *    so a re-delivered or out-of-order subscription update cannot restart a
 *    grace period that already ended in a recovery.
 *  - `canceled` / `unpaid` / `incomplete_expired` — terminal. `unpaid` is where
 *    Stripe parks a subscription whose dunning ran out, and `incomplete_expired`
 *    a checkout whose first payment never confirmed; both are the subscription
 *    being over, whatever the event is called.
 *  - `incomplete` / `paused` — a subscription that exists but is not paying.
 *    Applying its plan would hand out a paid tier before the money moves.
 */
function subscriptionStatusToType(status: unknown): BillingEventType | null {
  switch (status) {
    case "active":
    case "trialing":
      return "subscription_updated";
    case "canceled":
    case "unpaid":
    case "incomplete_expired":
      return "subscription_canceled";
    default:
      return null;
  }
}

function objectOf(
  event: Record<string, unknown>,
): Record<string, unknown> | null {
  const data = event.data;
  if (!isRecord(data)) return null;
  const object = data.object;
  return isRecord(object) ? object : null;
}

/**
 * Where the org id can be, in the order it is trustworthy:
 *  1. `client_reference_id` — set by us at checkout;
 *  2. the object's own metadata — subscriptions carry what we set via
 *     `subscription_data[metadata]`;
 *  3. `subscription_details.metadata` — an invoice's copy of that same
 *     subscription metadata, which is the only handle an invoice event has.
 */
function resolveOrganizationId(
  object: Record<string, unknown>,
): string | undefined {
  const direct = object.client_reference_id;
  if (typeof direct === "string" && direct.length > 0) return direct;

  for (const source of [
    metadataOf(object),
    metadataOf(object.subscription_details),
    metadataOf(object.parent),
  ]) {
    const value = source?.organizationId;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function resolvePlan(
  object: Record<string, unknown>,
  planForPrice: Map<string, BillingPlan>,
): BillingPlan | null {
  for (const source of [
    metadataOf(object),
    metadataOf(object.subscription_details),
  ]) {
    const value = source?.plan;
    if (isBillingPlan(value)) return value;
  }

  // Fallback: the subscription's price id. Covers a plan changed inside
  // Stripe's own dashboard, where our metadata was never updated.
  const items = isRecord(object.items) ? object.items.data : undefined;
  if (Array.isArray(items)) {
    for (const item of items) {
      const price = isRecord(item) && isRecord(item.price) ? item.price.id : "";
      const plan =
        typeof price === "string" ? planForPrice.get(price) : undefined;
      if (plan) return plan;
    }
  }
  return null;
}

function metadataOf(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return isRecord(value.metadata) ? value.metadata : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultTransport(timeoutMs = 20_000): StripeTransport {
  return async ({ url, headers, body }) => {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, body: await response.text() };
  };
}

/** Stripe answers errors as `{ error: { message } }`. Fall back to the raw
 * body, truncated — an error message is an operator hint, not a log. */
function stripeErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // fall through
  }
  return body.length > 300 ? `${body.slice(0, 300)}…` : body;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
