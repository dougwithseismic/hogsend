import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";
process.env.LEAD_FORM_WEBHOOK_SECRET = "test-lead-secret";

const { contacts, userEvents } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");
const { webhookSources } = await import("../webhook-sources/index.js");

const mockHatchet = {
  durableTask: vi.fn(() => ({
    run: vi.fn(),
    runNoWait: vi.fn(),
    runAndWait: vi.fn(),
  })),
  task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
  events: { push: vi.fn() },
  runs: { cancel: vi.fn(), get: vi.fn() },
  worker: vi.fn(),
} as unknown as HogsendClient["hatchet"];

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const app = createApp(container, { webhookSources });
const { db } = container;

const RUN = `lfs-${Date.now()}`;
const ANON = `${RUN}-anon`;
const EMAIL = `${RUN}@example.com`;

afterAll(async () => {
  await db.delete(userEvents).where(eq(userEvents.userId, ANON));
  await db.delete(contacts).where(eq(contacts.email, EMAIL));
});

function post(body: Record<string, unknown>, secret = "test-lead-secret") {
  return app.request("/v1/webhooks/lead-form", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lead-form-secret": secret,
    },
    body: JSON.stringify(body),
  });
}

const SUBMISSION = {
  email: EMAIL,
  phone: "+447700900123",
  name: "Test Lead",
  submission_id: `${RUN}-sub-1`,
  value: 12500,
  currency: "gbp",
  // form answers
  property_type: "detached",
  own_home: "yes",
  // hidden attribution fields (as planted by getAttributionFields())
  hs_anonymous_id: ANON,
  fbclid: "FBCLID_TEST_1",
  utm_source: "facebook",
  utm_campaign: "spring",
  hs_landing_page: "https://example.com/solar/quote",
  hs_captured_at: "2026-07-12T09:00:00.000Z",
};

describe("POST /v1/webhooks/lead-form", () => {
  it("rejects a wrong secret", async () => {
    const res = await post(SUBMISSION, "wrong");
    expect(res.status).toBe(401);
  });

  it("emits a valued lead.submitted stitched to the browser anon session", async () => {
    const res = await post(SUBMISSION);
    expect(res.status).toBe(200);

    // No external id on the contact, so the resolved event key is the
    // anonymous id — proving hs_anonymous_id stitched the lead to the
    // browser session (and its campaign.arrived touchpoints).
    const rows = await db
      .select()
      .from(userEvents)
      .where(eq(userEvents.userId, ANON));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.event).toBe("lead.submitted");
    expect(row?.value).toBe(12500);
    expect(row?.currency).toBe("GBP");
    expect(row?.properties).toMatchObject({
      property_type: "detached",
      own_home: "yes",
      fbclid: "FBCLID_TEST_1",
      utm_source: "facebook",
      utm_campaign: "spring",
      landing_page: "https://example.com/solar/quote",
      attribution_captured_at: "2026-07-12T09:00:00.000Z",
    });
    // Hidden hs_ fields never leak through under their raw names.
    expect(row?.properties).not.toHaveProperty("hs_anonymous_id");
    expect(row?.properties).not.toHaveProperty("hs_landing_page");

    const contactRows = await db
      .select()
      .from(contacts)
      .where(eq(contacts.email, EMAIL));
    expect(contactRows).toHaveLength(1);
    expect(contactRows[0]?.anonymousId).toBe(ANON);
    expect(contactRows[0]?.properties).toMatchObject({
      phone: "+447700900123",
      name: "Test Lead",
    });
  });

  it("dedups a vendor webhook retry on submission_id", async () => {
    const res = await post(SUBMISSION);
    expect(res.status).toBe(200);
    const rows = await db
      .select()
      .from(userEvents)
      .where(eq(userEvents.userId, ANON));
    expect(rows).toHaveLength(1);
  });

  it("skips a payload with no identity key at all", async () => {
    const res = await post({
      submission_id: `${RUN}-sub-2`,
      property_type: "flat",
    });
    expect(res.status).toBe(200);
    const rows = await db
      .select()
      .from(userEvents)
      .where(eq(userEvents.idempotencyKey, `lead-submitted:${RUN}-sub-2`));
    expect(rows).toHaveLength(0);
  });
});
