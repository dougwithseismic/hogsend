import { afterEach, describe, expect, it, vi } from "vitest";
import { FAKE_BILLING_ID, FakeBilling } from "../billing/fake";
import { BillingError, BillingSignatureError } from "../billing/types";

/**
 * The fake is the billing seam's stand-in for every other suite in the control
 * plane, so it gets tested as the tool it is: deterministic outputs, a real
 * fail-closed signature check (a fake that accepted anything would let the
 * webhook route's rejection path go unproven), and the two test affordances the
 * rest of PRD 06 leans on — `failNext` and the `calls` log.
 */

const ORG = "billing-fake-org";

describe("FakeBilling", () => {
  it("mints a deterministic checkout url and records the call", async () => {
    const a = new FakeBilling();
    const b = new FakeBilling();
    const input = {
      organizationId: ORG,
      plan: "self_serve" as const,
      successUrl: "http://localhost:3004/settings?checkout=ok",
      cancelUrl: "http://localhost:3004/settings",
    };

    const first = await a.createCheckout(input);
    const second = await b.createCheckout(input);

    expect(first.url).toBe(second.url);
    expect(first.url).toContain(ORG);
    expect(first.url).toContain("self_serve");
    expect(a.calls.map((call) => call.method)).toEqual(["createCheckout"]);
    expect(a.checkouts).toEqual([input]);
    expect(a.id).toBe(FAKE_BILLING_ID);
  });

  it("mints a portal url per organization", async () => {
    const fake = new FakeBilling();
    expect((await fake.getPortalUrl({ organizationId: ORG })).url).toContain(
      ORG,
    );
  });

  it("mints a webhook its own parseWebhook accepts", async () => {
    const fake = new FakeBilling();
    const minted = fake.mintWebhook({
      type: "checkout_completed",
      organizationId: ORG,
      plan: "dedicated",
      customerRef: "fake_cus_1",
    });

    const event = await fake.parseWebhook(minted);
    if (!event) throw new Error("expected an actionable event");
    expect(event.type).toBe("checkout_completed");
    expect(event.organizationId).toBe(ORG);
    expect(event.plan).toBe("dedicated");
    expect(event.customerRef).toBe("fake_cus_1");
    // Deterministic: no clock, no randomness anywhere in the fake.
    expect(event.eventId).toBe("fake_evt_1");
    expect(event.occurredAt.toISOString()).toBe("2026-01-01T00:00:01.000Z");
  });

  it("refuses a tampered payload fail-closed", async () => {
    const fake = new FakeBilling();
    const minted = fake.mintWebhook({
      type: "payment_failed",
      organizationId: ORG,
    });

    await expect(
      fake.parseWebhook({
        payload: `${minted.payload} `,
        headers: minted.headers,
      }),
    ).rejects.toBeInstanceOf(BillingSignatureError);

    // A missing header is the same refusal — never a silent accept.
    await expect(
      fake.parseWebhook({ payload: minted.payload, headers: {} }),
    ).rejects.toBeInstanceOf(BillingSignatureError);
  });

  it("returns null for a verified event it does not act on", async () => {
    const fake = new FakeBilling();
    const signed = fake.sign(JSON.stringify({ type: "invoice.upcoming" }));
    expect(await fake.parseWebhook(signed)).toBeNull();
  });

  it("failNext injects exactly one failure, then behaves normally", async () => {
    const fake = new FakeBilling();
    fake.failNext("createCheckout");

    await expect(
      fake.createCheckout({
        organizationId: ORG,
        plan: "self_serve",
        successUrl: "http://x.test/ok",
        cancelUrl: "http://x.test/no",
      }),
    ).rejects.toBeInstanceOf(BillingError);

    const ok = await fake.createCheckout({
      organizationId: ORG,
      plan: "self_serve",
      successUrl: "http://x.test/ok",
      cancelUrl: "http://x.test/no",
    });
    expect(ok.url).toContain(ORG);
    // The FAILED attempt is in the log too — a retry test needs to see it.
    expect(fake.calls).toHaveLength(2);
  });

  it("reset clears the call log, the checkouts and the event counter", async () => {
    const fake = new FakeBilling();
    await fake.getPortalUrl({ organizationId: ORG });
    fake.mintWebhook({ type: "payment_failed", organizationId: ORG });

    fake.reset();

    expect(fake.calls).toHaveLength(0);
    expect(fake.checkouts).toHaveLength(0);
    const event = await fake.parseWebhook(
      fake.mintWebhook({ type: "payment_failed", organizationId: ORG }),
    );
    expect(event?.eventId).toBe("fake_evt_1");
  });
});

/**
 * The factory is the fail-closed boundary, mirroring `getSubstrate()`:
 * `CLOUD_BILLING=stripe` with no secret key must refuse to start rather than
 * hand back a fake that silently accepts every webhook.
 */
describe("getBilling", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadFactory(billing?: string, key?: string) {
    vi.resetModules();
    vi.stubEnv("CLOUD_BILLING", billing ?? "");
    vi.stubEnv("CLOUD_STRIPE_SECRET_KEY", key ?? "");
    return import("../billing/index");
  }

  it("defaults to a fake, and returns the SAME one every call", async () => {
    const { getBilling, FakeBilling: Fake } = await loadFactory();

    const first = getBilling();
    expect(first).toBeInstanceOf(Fake);
    expect(getBilling()).toBe(first);
  });

  it("refuses stripe without a secret key, naming the missing var", async () => {
    const { getBilling, BillingError: Err } = await loadFactory("stripe");

    expect(() => getBilling()).toThrow(Err);
    expect(() => getBilling()).toThrow(/CLOUD_STRIPE_SECRET_KEY/);
  });

  it("builds a stripe provider — never a fake — once a key exists", async () => {
    const {
      getBilling,
      FakeBilling: Fake,
      StripeBilling: Stripe,
    } = await loadFactory("stripe", "sk_test_fake");

    const provider = getBilling();
    expect(provider).toBeInstanceOf(Stripe);
    expect(provider).not.toBeInstanceOf(Fake);
  });

  it("rejects an unknown billing provider name at boot", async () => {
    await expect(loadFactory("paddle")).rejects.toThrow();
  });

  it("getFakeBilling refuses when the fake is not active", async () => {
    const { getFakeBilling } = await loadFactory("stripe", "sk_test_fake");
    expect(() => getFakeBilling()).toThrow(/not the fake/);
  });
});
