import type { CrmStageEvent, HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, crmLinks, deals, userEvents } = await import("@hogsend/db");
const { eq, inArray } = await import("drizzle-orm");
const { createApp, createHogsendClient, defineCrmProvider } = await import(
  "@hogsend/engine"
);

const RUN = `crmw-${Date.now()}`;
const EMAIL = `${RUN}@example.com`;
const DEAL = `${RUN}-deal-1`;

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
  crm: {
    provider: fakeCrm,
    stageMaps: {
      fakecrm: {
        "*": {
          "stage-lead": "lead",
          "stage-quote": "quoted",
          "stage-sold": "sold",
        },
      },
    },
  },
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db } = container;

afterAll(async () => {
  const rows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.email, EMAIL));
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    await db.delete(userEvents).where(inArray(userEvents.userId, ids));
    await db.delete(deals).where(inArray(deals.contactId, ids));
    await db.delete(crmLinks).where(inArray(crmLinks.contactId, ids));
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

async function eventsFor(key: string, name?: string) {
  const rows = await db
    .select()
    .from(userEvents)
    .where(eq(userEvents.userId, key));
  return name ? rows.filter((r) => r.event === name) : rows;
}

async function contactKey(): Promise<string> {
  const rows = await db
    .select()
    .from(contacts)
    .where(eq(contacts.email, EMAIL));
  // Email-only contact: canonical event key = row id.
  return rows[0]?.id as string;
}

const QUOTED: CrmStageEvent = {
  dealId: DEAL,
  contactId: `${RUN}-contact-1`,
  email: EMAIL,
  pipelineId: "p-1",
  stageId: "stage-quote",
  stageName: "Quote sent",
  value: { amount: 15900, currency: "GBP" },
  occurredAt: "2026-07-12T10:00:00.000Z",
  raw: {},
};

// Deliberately NO email — must resolve via the crm_links alias minted by the
// QUOTED event.
const SOLD: CrmStageEvent = {
  dealId: DEAL,
  contactId: `${RUN}-contact-1`,
  pipelineId: "p-1",
  stageId: "stage-sold",
  status: "won",
  value: { amount: 17124, currency: "GBP" },
  occurredAt: "2026-07-12T14:00:00.000Z",
  raw: {},
};

describe("POST /v1/webhooks/crm/:providerId — the stage pipeline", () => {
  it("404s unknown providers and 401s bad signatures", async () => {
    expect(
      (
        await app.request("/v1/webhooks/crm/nope", {
          method: "POST",
          body: "[]",
        })
      ).status,
    ).toBe(404);
    expect((await post([QUOTED], "wrong")).status).toBe(401);
  });

  it("quoted: lands funnel.stage_changed + deal.quoted (valued) and projects the deal", async () => {
    const res = await post([QUOTED]);
    expect(res.status).toBe(200);
    const key = await contactKey();

    const stageChanged = await eventsFor(key, "funnel.stage_changed");
    expect(stageChanged).toHaveLength(1);
    expect(stageChanged[0]?.value).toBe(15900);
    expect(stageChanged[0]?.properties).toMatchObject({
      canonical_stage: "quoted",
      stage_id: "stage-quote",
    });

    const quotedEvents = await eventsFor(key, "deal.quoted");
    expect(quotedEvents).toHaveLength(1);
    expect(quotedEvents[0]?.value).toBe(15900);
    expect(quotedEvents[0]?.currency).toBe("GBP");

    const dealRows = await db
      .select()
      .from(deals)
      .where(eq(deals.externalId, DEAL));
    expect(dealRows).toHaveLength(1);
    expect(dealRows[0]).toMatchObject({
      canonicalStage: "quoted",
      value: 15900,
      currency: "GBP",
    });
    expect(dealRows[0]?.quotedAt).not.toBeNull();
    expect(dealRows[0]?.soldAt).toBeNull();
  });

  it("sold WITHOUT email: resolves via crm_links, emits valued deal.sold, advances the projection", async () => {
    const res = await post([SOLD]);
    expect(res.status).toBe(200);
    const key = await contactKey();

    const soldEvents = await eventsFor(key, "deal.sold");
    expect(soldEvents).toHaveLength(1);
    expect(soldEvents[0]?.value).toBe(17124);

    const dealRows = await db
      .select()
      .from(deals)
      .where(eq(deals.externalId, DEAL));
    expect(dealRows[0]).toMatchObject({
      canonicalStage: "sold",
      value: 17124,
    });
    expect(dealRows[0]?.soldAt?.toISOString()).toBe("2026-07-12T14:00:00.000Z");
  });

  it("is idempotent across webhook+poll double-observation", async () => {
    await post([SOLD]);
    const key = await contactKey();
    expect(await eventsFor(key, "deal.sold")).toHaveLength(1);
    expect(await eventsFor(key, "funnel.stage_changed")).toHaveLength(2);
  });

  it("never regresses: a late out-of-order lower stage records but does not demote the deal", async () => {
    const late: CrmStageEvent = {
      ...QUOTED,
      stageId: "stage-lead",
      stageName: "New lead",
      value: undefined,
      occurredAt: "2026-07-12T09:00:00.000Z",
    };
    const res = await post([late]);
    expect(res.status).toBe(200);
    const dealRows = await db
      .select()
      .from(deals)
      .where(eq(deals.externalId, DEAL));
    expect(dealRows[0]?.canonicalStage).toBe("sold");
    expect(dealRows[0]?.value).toBe(17124);
  });

  it("skips an event with no identity anywhere", async () => {
    const res = await post([
      { ...SOLD, dealId: `${RUN}-deal-orphan`, contactId: undefined },
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
