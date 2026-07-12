import type { CrmStageEvent, HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, crmLinks, deals, userEvents } = await import("@hogsend/db");
const { eq, inArray } = await import("drizzle-orm");
const { createApp, createHogsendClient, defineCrmProvider } = await import(
  "@hogsend/engine"
);

const RUN = `crml-${Date.now()}`;
const EMAIL = `${RUN}@example.com`;
const DEAL = `${RUN}-deal-1`;

/** A SaaS-style funnel — none of the built-in stage names exist. */
const saasCrm = defineCrmProvider({
  meta: { id: "saascrm", name: "SaaS CRM" },
  capabilities: {
    auth: "hmac",
    nativeStageWebhook: true,
    valueInWebhookPayload: true,
    atomicUpsert: true,
  },
  async pushLead() {
    return {};
  },
  verifyWebhook({ payload, headers }) {
    if (headers["x-saascrm-secret"] !== "shhh") {
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
    provider: saasCrm,
    // Custom ladder: quotedStage designated explicitly; soldStage defaults
    // to the LAST stage ("won").
    stages: ["trial", "demo", "poc", "won"],
    quotedStage: "poc",
    stageMaps: {
      saascrm: {
        "*": {
          "s-trial": "trial",
          "s-demo": "demo",
          "s-poc": "poc",
          "s-won": "won",
        },
      },
    },
  },
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

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

function post(events: unknown) {
  return app.request("/v1/webhooks/crm/saascrm", {
    method: "POST",
    headers: { "content-type": "application/json", "x-saascrm-secret": "shhh" },
    body: JSON.stringify(events),
  });
}

async function contactKey(): Promise<string> {
  const rows = await db
    .select()
    .from(contacts)
    .where(eq(contacts.email, EMAIL));
  return rows[0]?.id as string;
}

async function eventsFor(key: string, name: string) {
  const rows = await db
    .select()
    .from(userEvents)
    .where(eq(userEvents.userId, key));
  return rows.filter((r) => r.event === name);
}

function stageEvent(
  stageId: string,
  occurredAt: string,
  value?: number,
): CrmStageEvent {
  return {
    dealId: DEAL,
    email: EMAIL,
    pipelineId: "p-1",
    stageId,
    ...(value !== undefined
      ? { value: { amount: value, currency: "USD" } }
      : {}),
    occurredAt,
    raw: {},
  };
}

describe("configurable pipeline ladder (5b.1)", () => {
  it("boot: rejects a stage map pointing outside the ladder, and bad ladders", () => {
    expect(() =>
      createHogsendClient({
        crm: {
          provider: saasCrm,
          stages: ["trial", "won"],
          stageMaps: { saascrm: { "*": { "s-x": "quoted" } } },
        },
        overrides: { hatchet: mockHatchet },
      }),
    ).toThrow(/not in the configured ladder/);
    expect(() =>
      createHogsendClient({
        crm: { provider: saasCrm, stages: ["trial", "lost"] },
        overrides: { hatchet: mockHatchet },
      }),
    ).toThrow(/reserved/);
    expect(() =>
      createHogsendClient({
        crm: { provider: saasCrm, stages: ["a", "b"], soldStage: "zz" },
        overrides: { hatchet: mockHatchet },
      }),
    ).toThrow(/not in crm.stages/);
  });

  it("mid-ladder stages record without money events; the designated quote stage mints crm.deal_quoted", async () => {
    expect(
      (await post([stageEvent("s-demo", "2026-07-12T10:00:00.000Z")])).status,
    ).toBe(200);
    const key = await contactKey();
    const changed = await eventsFor(key, "crm.stage_changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]?.properties).toMatchObject({ canonical_stage: "demo" });
    expect(await eventsFor(key, "crm.deal_quoted")).toHaveLength(0);

    expect(
      (await post([stageEvent("s-poc", "2026-07-12T11:00:00.000Z", 24000)]))
        .status,
    ).toBe(200);
    const quoted = await eventsFor(key, "crm.deal_quoted");
    expect(quoted).toHaveLength(1);
    expect(quoted[0]?.value).toBe(24000);
    expect(quoted[0]?.properties).toMatchObject({ canonical_stage: "poc" });
  });

  it("the last stage is sold by default: mints crm.deal_sold, sets soldAt, and lost never overwrites it", async () => {
    expect(
      (await post([stageEvent("s-won", "2026-07-12T12:00:00.000Z", 26500)]))
        .status,
    ).toBe(200);
    const key = await contactKey();
    const sold = await eventsFor(key, "crm.deal_sold");
    expect(sold).toHaveLength(1);
    expect(sold[0]?.value).toBe(26500);
    expect(sold[0]?.properties).toMatchObject({ canonical_stage: "won" });

    // A late lost status must not demote the won deal.
    expect(
      (
        await post([
          {
            ...stageEvent("s-anything", "2026-07-12T13:00:00.000Z"),
            status: "lost" as const,
          },
        ])
      ).status,
    ).toBe(200);
    const dealRows = await db
      .select()
      .from(deals)
      .where(eq(deals.externalId, DEAL));
    expect(dealRows[0]).toMatchObject({
      canonicalStage: "won",
      stageRank: 3,
    });
    expect(dealRows[0]?.soldAt).not.toBeNull();
    expect(dealRows[0]?.lostAt).toBeNull();
  });

  it("admin stats serve the configured ladder as stageOrder", async () => {
    const res = await app.request("/v1/admin/deals/stats", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stageOrder: string[];
      stages: Record<string, number>;
    };
    expect(body.stageOrder).toEqual(["trial", "demo", "poc", "won", "lost"]);
    expect(body.stages.won).toBeGreaterThanOrEqual(1);
  });
});
