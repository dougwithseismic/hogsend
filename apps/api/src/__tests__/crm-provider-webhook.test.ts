import type { CrmStageEvent, HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, userEvents } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const { createApp, createHogsendClient, defineCrmProvider } = await import(
  "@hogsend/engine"
);

const RUN = `crmw-${Date.now()}`;
const EMAIL = `${RUN}@example.com`;

/** Fake CRM: shared-secret "signature", JSON body of CrmStageEvent[]. */
const fakeCrm = defineCrmProvider({
  meta: { id: "fakecrm", name: "Fake CRM" },
  capabilities: {
    auth: "hmac",
    nativeStageWebhook: true,
    valueInWebhookPayload: true,
    atomicUpsert: true,
  },
  async pushLead() {
    return { contactId: "c-1", dealId: "d-1" };
  },
  verifyWebhook({ payload, headers }) {
    if (headers["x-fakecrm-secret"] !== "shhh") {
      throw new Error("bad signature");
    }
    return JSON.parse(payload) as CrmStageEvent[];
  },
  parseWebhook(payload) {
    return JSON.parse(payload) as CrmStageEvent[];
  },
});

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

const container = createHogsendClient({
  crm: { provider: fakeCrm },
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db } = container;

afterAll(async () => {
  const rows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.email, EMAIL));
  for (const row of rows) {
    await db.delete(userEvents).where(eq(userEvents.userId, row.id));
  }
  await db.delete(contacts).where(eq(contacts.email, EMAIL));
});

function post(events: unknown, secret = "shhh") {
  return app.request("/v1/webhooks/crm/fakecrm", {
    method: "POST",
    headers: { "content-type": "application/json", "x-fakecrm-secret": secret },
    body: JSON.stringify(events),
  });
}

const SOLD: CrmStageEvent = {
  dealId: `${RUN}-deal-1`,
  contactId: `${RUN}-contact-1`,
  email: EMAIL,
  pipelineId: "p-1",
  stageId: "stage-sold",
  stageName: "Sold",
  status: "won",
  value: { amount: 17124, currency: "GBP" },
  occurredAt: "2026-07-12T10:31:11.000Z",
  raw: { note: "verbatim" },
};

describe("POST /v1/webhooks/crm/:providerId", () => {
  it("404s an unknown provider and 401s a bad signature", async () => {
    const unknown = await app.request("/v1/webhooks/crm/nope", {
      method: "POST",
      body: "[]",
    });
    expect(unknown.status).toBe(404);
    const bad = await post([SOLD], "wrong");
    expect(bad.status).toBe(401);
  });

  it("lands a valued crm.stage_changed on the spine, email-resolved", async () => {
    const res = await post([SOLD]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      received: 1,
      ingested: 1,
      skipped: 0,
    });

    // Email-only identity: the contact's canonical event key is its row id.
    const contactRows = await db
      .select()
      .from(contacts)
      .where(eq(contacts.email, EMAIL));
    expect(contactRows).toHaveLength(1);
    const key = contactRows[0]?.id as string;

    const rows = await db
      .select()
      .from(userEvents)
      .where(eq(userEvents.userId, key));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event).toBe("crm.stage_changed");
    expect(rows[0]?.value).toBe(17124);
    expect(rows[0]?.currency).toBe("GBP");
    expect(rows[0]?.source).toBe("crm");
    expect(rows[0]?.occurredAt.toISOString()).toBe("2026-07-12T10:31:11.000Z");
    expect(rows[0]?.properties).toMatchObject({
      crm: "fakecrm",
      deal_id: `${RUN}-deal-1`,
      pipeline_id: "p-1",
      stage_id: "stage-sold",
      stage_name: "Sold",
      status: "won",
    });
  });

  it("dedups the same transition observed twice (webhook + poll overlap)", async () => {
    const res = await post([SOLD]);
    expect(res.status).toBe(200);
    const contactRows = await db
      .select()
      .from(contacts)
      .where(eq(contacts.email, EMAIL));
    const key = contactRows[0]?.id as string;
    const rows = await db
      .select()
      .from(userEvents)
      .where(eq(userEvents.userId, key));
    expect(rows).toHaveLength(1);
  });

  it("skips (with count) an event carrying no identity", async () => {
    const res = await post([
      { ...SOLD, dealId: `${RUN}-deal-2`, email: undefined },
    ]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ingested: 0, skipped: 1 });
  });

  it("rejects a consumer webhook source claiming the reserved crm id", () => {
    expect(() =>
      createHogsendClient({
        webhookSources: [
          {
            meta: { id: "crm", name: "Bad" },
            auth: { header: "x-s", envKey: "X_S", type: "match" as const },
            async transform() {
              return null;
            },
          },
        ],
        overrides: { hatchet: mockHatchet },
      }),
    ).toThrow(/reserved/);
  });
});
