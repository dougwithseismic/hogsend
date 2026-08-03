import { createHmac, timingSafeEqual } from "node:crypto";
import {
  BillingError,
  type BillingEvent,
  type BillingEventType,
  type BillingPlan,
  type BillingProvider,
  BillingSignatureError,
  type CheckoutResult,
  type CreateCheckoutInput,
  headerValue,
  type PortalInput,
  type PortalResult,
  type WebhookInput,
} from "./types";

/**
 * The in-memory billing provider: every control-plane test and all of local dev.
 *
 * DETERMINISTIC by construction — no `Date.now()`, no randomness. Event ids
 * count up from a per-instance counter and timestamps come off a fixed epoch, so
 * a test asserting an id is asserting a fact rather than recording a sample.
 *
 * It signs its minted webhooks and CHECKS that signature on the way back in.
 * That is not decoration: the webhook route's fail-closed branch is the single
 * most important rule in this task, and a fake that accepted any payload would
 * leave it unproven in every suite that does not talk to Stripe.
 *
 * Test affordances, mirroring `FakeSubstrate`:
 *  - `failNext(method, error?)` scripts the NEXT call to throw;
 *  - `calls` records `{ method, args }` in order, including calls that threw;
 *  - `checkouts` records the checkout inputs, so an upgrade surface can be
 *    asserted on what it ASKED for, not just what it got back.
 */

export const FAKE_BILLING_ID = "fake";

/** Publicly-known on purpose: anything it signs is worthless, and a leak of the
 * fake into a live path is meant to be obvious. */
const FAKE_WEBHOOK_SECRET = "fake-billing-secret";

export const FAKE_BILLING_SIGNATURE_HEADER = "x-fake-billing-signature";

/** Fixed epoch for minted events: 2026-01-01T00:00:00Z. The Nth event is N
 * seconds after it, so ordering is visible and still clock-free. */
const FAKE_EPOCH_MS = Date.UTC(2026, 0, 1);

export type FakeBillingMethod =
  | "createCheckout"
  | "parseWebhook"
  | "getPortalUrl";

export interface FakeBillingCall {
  method: FakeBillingMethod;
  args: unknown[];
}

export interface MintWebhookInput {
  type: BillingEventType;
  organizationId: string;
  plan?: BillingPlan | null;
  customerRef?: string;
}

export class FakeBilling implements BillingProvider {
  readonly id = FAKE_BILLING_ID;

  /** Every call made, in order. Cleared with `reset()`. */
  readonly calls: FakeBillingCall[] = [];
  /** Every checkout the app asked for, in order. */
  readonly checkouts: CreateCheckoutInput[] = [];

  private readonly scriptedFailures = new Map<
    FakeBillingMethod,
    BillingError[]
  >();
  private eventCounter = 0;

  failNext(method: FakeBillingMethod, error?: BillingError): this {
    const queue = this.scriptedFailures.get(method) ?? [];
    queue.push(
      error ??
        new BillingError(`fake billing: scripted failure in ${method}`, {
          retryable: true,
        }),
    );
    this.scriptedFailures.set(method, queue);
    return this;
  }

  reset(): this {
    this.calls.length = 0;
    this.checkouts.length = 0;
    this.scriptedFailures.clear();
    this.eventCounter = 0;
    return this;
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult> {
    this.record("createCheckout", [input]);
    this.checkouts.push(input);
    return {
      url: `http://fake-billing.localhost/checkout/${encodeURIComponent(
        input.organizationId,
      )}/${input.plan}`,
    };
  }

  async getPortalUrl(input: PortalInput): Promise<PortalResult> {
    this.record("getPortalUrl", [input]);
    return {
      url: `http://fake-billing.localhost/portal/${encodeURIComponent(
        input.organizationId,
      )}`,
    };
  }

  async parseWebhook(input: WebhookInput): Promise<BillingEvent | null> {
    this.record("parseWebhook", [input]);
    this.verify(input);

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(input.payload) as Record<string, unknown>;
    } catch (cause) {
      throw new BillingError("fake billing: payload is not JSON", {
        cause,
      });
    }

    const type = body.type;
    if (!isFakeLifecycleType(type)) return null;

    return {
      type,
      organizationId: String(body.organizationId ?? ""),
      plan: (body.plan as BillingPlan | null | undefined) ?? null,
      eventId: String(body.eventId ?? ""),
      occurredAt: new Date(String(body.occurredAt)),
      ...(typeof body.customerRef === "string"
        ? { customerRef: body.customerRef }
        : {}),
      raw: body,
    };
  }

  /**
   * Build a signed webhook this provider will accept — the harness every other
   * suite drives the plan service and the route with.
   */
  mintWebhook(input: MintWebhookInput): WebhookInput {
    this.eventCounter += 1;
    return this.sign(
      JSON.stringify({
        type: input.type,
        organizationId: input.organizationId,
        plan: input.plan ?? null,
        eventId: `fake_evt_${this.eventCounter}`,
        occurredAt: new Date(
          FAKE_EPOCH_MS + this.eventCounter * 1000,
        ).toISOString(),
        ...(input.customerRef ? { customerRef: input.customerRef } : {}),
      }),
    );
  }

  /** Sign an ARBITRARY body — lets a test hand over a verified payload the
   * provider deliberately does not act on. */
  sign(payload: string): WebhookInput {
    return {
      payload,
      headers: { [FAKE_BILLING_SIGNATURE_HEADER]: fakeDigest(payload) },
    };
  }

  private verify(input: WebhookInput): void {
    const provided = headerValue(input.headers, FAKE_BILLING_SIGNATURE_HEADER);
    if (!provided) {
      throw new BillingSignatureError(
        `missing ${FAKE_BILLING_SIGNATURE_HEADER} header`,
      );
    }
    const expected = fakeDigest(input.payload);
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new BillingSignatureError("no signature matched the payload");
    }
  }

  /** Log first, then honour a scripted failure — a retry test needs the failed
   * attempt in the log, not only the one that worked. */
  private record(method: FakeBillingMethod, args: unknown[]): void {
    this.calls.push({ method, args });
    const failure = this.scriptedFailures.get(method)?.shift();
    if (failure) throw failure;
  }
}

const FAKE_LIFECYCLE_TYPES: BillingEventType[] = [
  "checkout_completed",
  "subscription_updated",
  "subscription_canceled",
  "payment_failed",
];

function isFakeLifecycleType(value: unknown): value is BillingEventType {
  return (FAKE_LIFECYCLE_TYPES as string[]).includes(value as string);
}

function fakeDigest(payload: string): string {
  return createHmac("sha256", FAKE_WEBHOOK_SECRET)
    .update(payload)
    .digest("hex");
}
