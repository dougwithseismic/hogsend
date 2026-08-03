import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  STRIPE_SIGNATURE_HEADER,
  STRIPE_TOLERANCE_SECONDS,
  StripeBilling,
  type StripeTransport,
  verifyStripeSignature,
} from "../billing/stripe";
import {
  BillingConfigError,
  BillingError,
  BillingSignatureError,
} from "../billing/types";

/**
 * No live Stripe anywhere: the wire is an injected transport, and every
 * signature fixture is computed HERE with `node:crypto` rather than by calling
 * the verifier's own signer. That independence is the point — a fixture signed
 * by the code under test would certify the implementation against itself and
 * pass even if the scheme were wrong.
 */

const SECRET = "whsec_test_secret";
const NOW_SECONDS = 1_800_000_000;

/** Stripe's documented v1 scheme: HMAC-SHA256 over `${timestamp}.${payload}`. */
function sign(payload: string, timestamp = NOW_SECONDS, secret = SECRET) {
  const digest = createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

function headersFor(payload: string, timestamp = NOW_SECONDS) {
  return { [STRIPE_SIGNATURE_HEADER]: sign(payload, timestamp) };
}

describe("verifyStripeSignature", () => {
  const payload = '{"id":"evt_1","type":"checkout.session.completed"}';

  it("accepts a correctly signed, in-tolerance payload", () => {
    expect(() =>
      verifyStripeSignature({
        payload,
        header: sign(payload),
        secret: SECRET,
        nowSeconds: NOW_SECONDS,
      }),
    ).not.toThrow();
  });

  it("accepts when ONE of several v1 signatures matches (key rotation)", () => {
    const header = `t=${NOW_SECONDS},v1=${"0".repeat(64)},v1=${
      sign(payload).split("v1=")[1]
    }`;
    expect(() =>
      verifyStripeSignature({
        payload,
        header,
        secret: SECRET,
        nowSeconds: NOW_SECONDS,
      }),
    ).not.toThrow();
  });

  it("rejects a payload mutated by a single byte", () => {
    expect(() =>
      verifyStripeSignature({
        payload: `${payload} `,
        header: sign(payload),
        secret: SECRET,
        nowSeconds: NOW_SECONDS,
      }),
    ).toThrow(BillingSignatureError);
  });

  it("rejects a signature made with a different secret", () => {
    expect(() =>
      verifyStripeSignature({
        payload,
        header: sign(payload, NOW_SECONDS, "whsec_other"),
        secret: SECRET,
        nowSeconds: NOW_SECONDS,
      }),
    ).toThrow(BillingSignatureError);
  });

  it("rejects a replay outside the 300s tolerance, in both directions", () => {
    const stale = NOW_SECONDS - STRIPE_TOLERANCE_SECONDS - 1;
    expect(() =>
      verifyStripeSignature({
        payload,
        header: sign(payload, stale),
        secret: SECRET,
        nowSeconds: NOW_SECONDS,
      }),
    ).toThrow(/tolerance/i);

    const future = NOW_SECONDS + STRIPE_TOLERANCE_SECONDS + 1;
    expect(() =>
      verifyStripeSignature({
        payload,
        header: sign(payload, future),
        secret: SECRET,
        nowSeconds: NOW_SECONDS,
      }),
    ).toThrow(/tolerance/i);
  });

  it("accepts a timestamp exactly on the tolerance edge", () => {
    expect(() =>
      verifyStripeSignature({
        payload,
        header: sign(payload, NOW_SECONDS - STRIPE_TOLERANCE_SECONDS),
        secret: SECRET,
        nowSeconds: NOW_SECONDS,
      }),
    ).not.toThrow();
  });

  it("rejects a malformed or empty header rather than parsing around it", () => {
    for (const header of ["", "garbage", `t=${NOW_SECONDS}`, "v1=abc"]) {
      expect(() =>
        verifyStripeSignature({
          payload,
          header,
          secret: SECRET,
          nowSeconds: NOW_SECONDS,
        }),
      ).toThrow(BillingSignatureError);
    }
  });
});

/** Records every request and answers from a scripted queue. */
function recordingTransport(bodies: string[]): {
  transport: StripeTransport;
  requests: { url: string; body: string; headers: Record<string, string> }[];
} {
  const requests: {
    url: string;
    body: string;
    headers: Record<string, string>;
  }[] = [];
  const queue = [...bodies];
  const transport: StripeTransport = async (request) => {
    requests.push({
      url: request.url,
      body: request.body,
      headers: request.headers,
    });
    return { status: 200, body: queue.shift() ?? "{}" };
  };
  return { transport, requests };
}

function stripeBilling(
  transport: StripeTransport,
  overrides: Partial<ConstructorParameters<typeof StripeBilling>[0]> = {},
) {
  return new StripeBilling({
    secretKey: "sk_test_fake",
    webhookSecret: SECRET,
    prices: { self_serve: "price_self", dedicated: "price_ded" },
    portalReturnUrl: "http://localhost:3004/settings",
    transport,
    nowSeconds: () => NOW_SECONDS,
    ...overrides,
  });
}

describe("StripeBilling.createCheckout", () => {
  it("posts a subscription session carrying the org on both handles", async () => {
    const { transport, requests } = recordingTransport([
      JSON.stringify({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" }),
    ]);

    const result = await stripeBilling(transport).createCheckout({
      organizationId: "org_abc",
      plan: "self_serve",
      successUrl: "http://localhost:3004/settings?checkout=ok",
      cancelUrl: "http://localhost:3004/settings",
    });

    expect(result.url).toBe("https://checkout.stripe.com/c/cs_1");
    const [request] = requests;
    if (!request) throw new Error("expected one request");
    expect(request.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(request.headers.Authorization).toBe("Bearer sk_test_fake");

    const form = new URLSearchParams(request.body);
    expect(form.get("mode")).toBe("subscription");
    expect(form.get("line_items[0][price]")).toBe("price_self");
    expect(form.get("line_items[0][quantity]")).toBe("1");
    expect(form.get("success_url")).toBe(
      "http://localhost:3004/settings?checkout=ok",
    );
    expect(form.get("cancel_url")).toBe("http://localhost:3004/settings");
    // client_reference_id survives on the session; the subscription metadata is
    // what every LATER lifecycle webhook is attributed by.
    expect(form.get("client_reference_id")).toBe("org_abc");
    expect(form.get("metadata[organizationId]")).toBe("org_abc");
    expect(form.get("subscription_data[metadata][organizationId]")).toBe(
      "org_abc",
    );
    expect(form.get("subscription_data[metadata][plan]")).toBe("self_serve");
  });

  it("refuses a plan with no configured price id", async () => {
    const { transport, requests } = recordingTransport([]);
    await expect(
      stripeBilling(transport, { prices: {} }).createCheckout({
        organizationId: "org_abc",
        plan: "dedicated",
        successUrl: "http://x.test/ok",
        cancelUrl: "http://x.test/no",
      }),
    ).rejects.toBeInstanceOf(BillingConfigError);
    // Fail closed BEFORE the wire — never a half-configured Stripe call.
    expect(requests).toHaveLength(0);
  });

  it("turns a Stripe error response into a typed BillingError", async () => {
    const transport: StripeTransport = async () => ({
      status: 402,
      body: JSON.stringify({ error: { message: "No such price" } }),
    });

    const error = await stripeBilling(transport)
      .createCheckout({
        organizationId: "org_abc",
        plan: "self_serve",
        successUrl: "http://x.test/ok",
        cancelUrl: "http://x.test/no",
      })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BillingError);
    expect((error as BillingError).message).toContain("No such price");
    // A 4xx is the request's fault; retrying it changes nothing.
    expect((error as BillingError).retryable).toBe(false);
  });

  it("marks a 5xx retryable", async () => {
    const transport: StripeTransport = async () => ({
      status: 503,
      body: "upstream unavailable",
    });
    await expect(
      stripeBilling(transport).createCheckout({
        organizationId: "org_abc",
        plan: "self_serve",
        successUrl: "http://x.test/ok",
        cancelUrl: "http://x.test/no",
      }),
    ).rejects.toMatchObject({ retryable: true });
  });
});

describe("StripeBilling.getPortalUrl", () => {
  it("creates a portal session for the org's recorded customer", async () => {
    const { transport, requests } = recordingTransport([
      JSON.stringify({
        id: "bps_1",
        url: "https://billing.stripe.com/p/bps_1",
      }),
    ]);

    const result = await stripeBilling(transport, {
      resolveCustomerId: async (organizationId) =>
        organizationId === "org_abc" ? "cus_123" : undefined,
    }).getPortalUrl({ organizationId: "org_abc" });

    expect(result.url).toBe("https://billing.stripe.com/p/bps_1");
    const [request] = requests;
    if (!request) throw new Error("expected one request");
    expect(request.url).toBe(
      "https://api.stripe.com/v1/billing_portal/sessions",
    );
    const form = new URLSearchParams(request.body);
    expect(form.get("customer")).toBe("cus_123");
    expect(form.get("return_url")).toBe("http://localhost:3004/settings");
  });

  it("refuses when the org has no recorded customer", async () => {
    const { transport, requests } = recordingTransport([]);
    await expect(
      stripeBilling(transport, {
        resolveCustomerId: async () => undefined,
      }).getPortalUrl({ organizationId: "org_none" }),
    ).rejects.toBeInstanceOf(BillingConfigError);
    expect(requests).toHaveLength(0);
  });
});

describe("StripeBilling.parseWebhook", () => {
  const billing = () =>
    stripeBilling(async () => ({ status: 200, body: "{}" }));

  async function parse(event: Record<string, unknown>) {
    const payload = JSON.stringify(event);
    return billing().parseWebhook({
      payload,
      headers: headersFor(payload),
    });
  }

  it("refuses an unsigned payload before parsing it", async () => {
    await expect(
      billing().parseWebhook({
        payload: '{"type":"checkout.session.completed"}',
        headers: {},
      }),
    ).rejects.toBeInstanceOf(BillingSignatureError);
  });

  it("refuses to verify at all with no webhook secret configured", async () => {
    const payload = "{}";
    await expect(
      stripeBilling(async () => ({ status: 200, body: "{}" }), {
        webhookSecret: undefined,
      }).parseWebhook({ payload, headers: headersFor(payload) }),
    ).rejects.toBeInstanceOf(BillingConfigError);
  });

  it("maps checkout.session.completed, carrying plan + customer", async () => {
    const event = await parse({
      id: "evt_1",
      type: "checkout.session.completed",
      created: NOW_SECONDS,
      data: {
        object: {
          client_reference_id: "org_abc",
          customer: "cus_123",
          metadata: { organizationId: "org_abc", plan: "dedicated" },
        },
      },
    });

    expect(event).toMatchObject({
      type: "checkout_completed",
      organizationId: "org_abc",
      plan: "dedicated",
      eventId: "evt_1",
      customerRef: "cus_123",
    });
    expect(event?.occurredAt.getTime()).toBe(NOW_SECONDS * 1000);
  });

  it("falls back to the price id when metadata carries no plan", async () => {
    const event = await parse({
      id: "evt_2",
      type: "customer.subscription.updated",
      created: NOW_SECONDS,
      data: {
        object: {
          status: "active",
          customer: "cus_123",
          metadata: { organizationId: "org_abc" },
          items: { data: [{ price: { id: "price_ded" } }] },
        },
      },
    });

    expect(event).toMatchObject({
      type: "subscription_updated",
      organizationId: "org_abc",
      plan: "dedicated",
    });
  });

  it("maps customer.subscription.deleted to a cancellation", async () => {
    const event = await parse({
      id: "evt_3",
      type: "customer.subscription.deleted",
      created: NOW_SECONDS,
      data: {
        object: { status: "canceled", metadata: { organizationId: "org_abc" } },
      },
    });
    expect(event?.type).toBe("subscription_canceled");
  });

  it("treats a subscription UPDATED into `canceled` as a cancellation", async () => {
    const event = await parse({
      id: "evt_4",
      type: "customer.subscription.updated",
      created: NOW_SECONDS,
      data: {
        object: { status: "canceled", metadata: { organizationId: "org_abc" } },
      },
    });
    expect(event?.type).toBe("subscription_canceled");
  });

  /**
   * The subscription status is an ALLOWLIST. The case that pays for this table
   * is `past_due`: Stripe sets it on the SAME failure that emits
   * `invoice.payment_failed`, and reading it as good standing would clear the
   * dunning clock that failure just started — no tenant would ever be suspended
   * for non-payment. `incomplete` is the same hole facing the other way: a
   * subscription created before its first payment confirms must not hand out a
   * paid plan.
   */
  describe("subscription status mapping", () => {
    const cases: [string, string | null][] = [
      ["active", "subscription_updated"],
      ["trialing", "subscription_updated"],
      ["past_due", null],
      ["incomplete", null],
      ["paused", null],
      ["canceled", "subscription_canceled"],
      ["unpaid", "subscription_canceled"],
      ["incomplete_expired", "subscription_canceled"],
      // An unknown status is never assumed healthy.
      ["some_future_status", null],
    ];

    for (const [status, expected] of cases) {
      it(`maps status "${status}" to ${expected ?? "null"}`, async () => {
        for (const stripeType of [
          "customer.subscription.created",
          "customer.subscription.updated",
        ]) {
          const event = await parse({
            id: `evt_status_${status}`,
            type: stripeType,
            created: NOW_SECONDS,
            data: {
              object: {
                status,
                customer: "cus_123",
                metadata: { organizationId: "org_abc", plan: "self_serve" },
              },
            },
          });
          expect(event?.type ?? null).toBe(expected);
        }
      });
    }
  });

  it("maps invoice.payment_failed, resolving the org off subscription details", async () => {
    const event = await parse({
      id: "evt_5",
      type: "invoice.payment_failed",
      created: NOW_SECONDS,
      data: {
        object: {
          customer: "cus_123",
          subscription_details: { metadata: { organizationId: "org_abc" } },
        },
      },
    });
    expect(event).toMatchObject({
      type: "payment_failed",
      organizationId: "org_abc",
      plan: null,
    });
  });

  it("maps a recovered invoice to subscription_updated with no plan", async () => {
    const event = await parse({
      id: "evt_6",
      type: "invoice.payment_succeeded",
      created: NOW_SECONDS,
      data: {
        object: {
          customer: "cus_123",
          subscription_details: { metadata: { organizationId: "org_abc" } },
        },
      },
    });
    expect(event).toMatchObject({
      type: "subscription_updated",
      plan: null,
    });
  });

  it("returns null for a verified event outside the lifecycle", async () => {
    expect(
      await parse({
        id: "evt_7",
        type: "invoice.upcoming",
        created: NOW_SECONDS,
        data: { object: { metadata: { organizationId: "org_abc" } } },
      }),
    ).toBeNull();
  });

  it("returns null for a lifecycle event it cannot attribute to an org", async () => {
    expect(
      await parse({
        id: "evt_8",
        type: "customer.subscription.deleted",
        created: NOW_SECONDS,
        data: { object: { status: "canceled", metadata: {} } },
      }),
    ).toBeNull();
  });
});
