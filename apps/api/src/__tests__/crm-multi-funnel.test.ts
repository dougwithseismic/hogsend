import type { CrmStageEvent, HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, crmLinks, deals, userEvents } = await import("@hogsend/db");
const { eq, inArray } = await import("drizzle-orm");
const {
  createApp,
  createHogsendClient,
  crmPipeline,
  defineCrmProvider,
  defineFunnel,
} = await import("@hogsend/engine");

const RUN = `crmf-${Date.now()}`;
const EMAIL_RES = `${RUN}-res@example.com`;
const EMAIL_COM = `${RUN}-com@example.com`;

const crm = defineCrmProvider({
  meta: { id: "funnelcrm", name: "Funnel CRM" },
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
    if (headers["x-funnelcrm-secret"] !== "shhh") {
      throw new Error("bad signature");
    }
    return JSON.parse(payload) as CrmStageEvent[];
  },
  parseWebhook(payload) {
    return JSON.parse(payload) as CrmStageEvent[];
  },
});

/** Two funnels on ONE provider, split by native pipeline. Residential's
 * all-string stages exercise the legacy milestone defaults (quoted = the
 * literal "quoted", sold = last); commercial's object entries exercise
 * explicit milestones. */
const residential = defineFunnel({
  id: "residential",
  name: "Residential",
  stages: ["lead", "quoted", "sold"],
  bindings: [
    crmPipeline({
      provider: "funnelcrm",
      pipeline: "p-res",
      stages: { "s-new": "lead", "s-quote": "quoted", "s-won": "sold" },
    }),
  ],
});
const commercial = defineFunnel({
  id: "commercial",
  name: "Commercial",
  stages: [
    "enquiry",
    "site_visit",
    { id: "proposal", milestone: "quoted" },
    { id: "won", milestone: "won" },
  ],
  bindings: [
    crmPipeline({
      provider: "funnelcrm",
      pipeline: "p-com",
      stages: {
        "s-enq": "enquiry",
        "s-visit": "site_visit",
        "s-prop": "proposal",
        "s-close": "won",
      },
    }),
  ],
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
  crm: { provider: crm },
  funnels: [residential, commercial],
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

afterAll(async () => {
  const rows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(inArray(contacts.email, [EMAIL_RES, EMAIL_COM]));
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    await db.delete(userEvents).where(inArray(userEvents.userId, ids));
    await db.delete(deals).where(inArray(deals.contactId, ids));
    await db.delete(crmLinks).where(inArray(crmLinks.contactId, ids));
    await db.delete(contacts).where(inArray(contacts.id, ids));
  }
});

function post(events: unknown) {
  return app.request("/v1/webhooks/crm/funnelcrm", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-funnelcrm-secret": "shhh",
    },
    body: JSON.stringify(events),
  });
}

function stageEvent(opts: {
  deal: string;
  email: string;
  pipeline: string;
  stageId: string;
  at: string;
  value?: number;
}): CrmStageEvent {
  return {
    dealId: opts.deal,
    email: opts.email,
    pipelineId: opts.pipeline,
    stageId: opts.stageId,
    ...(opts.value !== undefined
      ? { value: { amount: opts.value, currency: "GBP" } }
      : {}),
    occurredAt: opts.at,
    raw: {},
  };
}

describe("multiple funnels (5b.4)", () => {
  it("boot: overlapping pipeline claims and duplicate ids throw", () => {
    expect(() =>
      createHogsendClient({
        crm: { provider: crm },
        funnels: [
          residential,
          defineFunnel({
            id: "rival",
            stages: ["a", "b"],
            bindings: [
              crmPipeline({
                provider: "funnelcrm",
                pipeline: "p-res",
                stages: { "s-x": "a" },
              }),
            ],
          }),
        ],
        overrides: { hatchet: mockHatchet },
      }),
    ).toThrow(/both claim/);
    expect(() =>
      createHogsendClient({
        funnels: [residential, residential],
        overrides: { hatchet: mockHatchet },
      }),
    ).toThrow(/duplicate funnel id/);
  });

  it("routes stage events to the claiming funnel: per-funnel ladders, stamps, money events", async () => {
    // Residential deal → quoted on ITS ladder.
    expect(
      (
        await post([
          stageEvent({
            deal: `${RUN}-d-res`,
            email: EMAIL_RES,
            pipeline: "p-res",
            stageId: "s-quote",
            at: "2026-07-12T10:00:00.000Z",
            value: 12000,
          }),
        ])
      ).status,
    ).toBe(200);
    // Commercial deal → proposal (ITS quote stage) then won (sold default:
    // last stage).
    expect(
      (
        await post([
          stageEvent({
            deal: `${RUN}-d-com`,
            email: EMAIL_COM,
            pipeline: "p-com",
            stageId: "s-prop",
            at: "2026-07-12T11:00:00.000Z",
            value: 90000,
          }),
          stageEvent({
            deal: `${RUN}-d-com`,
            email: EMAIL_COM,
            pipeline: "p-com",
            stageId: "s-close",
            at: "2026-07-12T12:00:00.000Z",
            value: 88000,
          }),
        ])
      ).status,
    ).toBe(200);

    const dealRows = await db
      .select()
      .from(deals)
      .where(inArray(deals.externalId, [`${RUN}-d-res`, `${RUN}-d-com`]));
    const res = dealRows.find((d) => d.externalId === `${RUN}-d-res`);
    const com = dealRows.find((d) => d.externalId === `${RUN}-d-com`);
    expect(res).toMatchObject({
      funnelId: "residential",
      canonicalStage: "quoted",
      stageRank: 1,
    });
    expect(com).toMatchObject({
      funnelId: "commercial",
      canonicalStage: "won",
      stageRank: 3,
    });
    expect(com?.soldAt).not.toBeNull();
    expect(com?.quotedAt).not.toBeNull();

    // Money events fired per the CLAIMING funnel's designations and carry
    // funnel_id.
    const comContact = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.email, EMAIL_COM));
    const comEvents = await db
      .select()
      .from(userEvents)
      .where(eq(userEvents.userId, comContact[0]?.id as string));
    const sold = comEvents.find((e) => e.event === "deal.sold");
    const quoted = comEvents.find((e) => e.event === "deal.quoted");
    expect(sold?.properties).toMatchObject({
      funnel_id: "commercial",
      canonical_stage: "won",
    });
    expect(quoted?.properties).toMatchObject({
      funnel_id: "commercial",
      canonical_stage: "proposal",
    });
  });

  it("a cross-funnel stage event lands on the spine but never touches the projection", async () => {
    // The residential deal gets an event from the COMMERCIAL pipeline (the
    // CRM moved it). Applying commercial's ladder would call rank 3 ("won")
    // an advance and mint a phantom deal.sold — it must be ignored.
    expect(
      (
        await post([
          stageEvent({
            deal: `${RUN}-d-res`,
            email: EMAIL_RES,
            pipeline: "p-com",
            stageId: "s-close",
            at: "2026-07-12T13:00:00.000Z",
            value: 99999,
          }),
        ])
      ).status,
    ).toBe(200);

    const dealRows = await db
      .select()
      .from(deals)
      .where(eq(deals.externalId, `${RUN}-d-res`));
    expect(dealRows[0]).toMatchObject({
      funnelId: "residential",
      canonicalStage: "quoted",
      stageRank: 1,
      value: 12000, // foreign-funnel value ignored too
    });
    expect(dealRows[0]?.soldAt).toBeNull();

    const resContact = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.email, EMAIL_RES));
    const resEvents = await db
      .select()
      .from(userEvents)
      .where(eq(userEvents.userId, resContact[0]?.id as string));
    // The raw stage change IS recorded (append-only truth)...
    expect(
      resEvents.filter((e) => e.event === "funnel.stage_changed"),
    ).toHaveLength(2);
    // ...but no phantom sale.
    expect(resEvents.filter((e) => e.event === "deal.sold")).toHaveLength(0);
  });

  it("adopting a pre-funnel deal re-bases its rank on the claiming ladder", async () => {
    // Simulate an upgrade: a row ranked on the OLD five-stage ladder
    // (quoted = rank 3) with no funnel. Residential's ladder has quoted at
    // rank 1; without a re-base, stored rank 3 would block the advance to
    // sold (rank 2).
    const resContact = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.email, EMAIL_RES));
    await db.insert(deals).values({
      provider: "funnelcrm",
      externalId: `${RUN}-d-legacy`,
      contactId: resContact[0]?.id as string,
      pipelineId: "p-res",
      funnelId: null,
      canonicalStage: "quoted",
      stageRank: 3,
      quotedAt: new Date("2026-07-01T00:00:00Z"),
      lastStageAt: new Date("2026-07-01T00:00:00Z"),
    });

    expect(
      (
        await post([
          stageEvent({
            deal: `${RUN}-d-legacy`,
            email: EMAIL_RES,
            pipeline: "p-res",
            stageId: "s-won",
            at: "2026-07-12T14:00:00.000Z",
            value: 15000,
          }),
        ])
      ).status,
    ).toBe(200);

    const rows = await db
      .select()
      .from(deals)
      .where(eq(deals.externalId, `${RUN}-d-legacy`));
    expect(rows[0]).toMatchObject({
      funnelId: "residential",
      canonicalStage: "sold",
      stageRank: 2,
    });
    expect(rows[0]?.soldAt).not.toBeNull();
    // quotedAt predates adoption — no re-mint.
    expect(rows[0]?.quotedAt?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("admin stats scope per funnel and serve the catalog", async () => {
    const res = await app.request("/v1/admin/deals/stats?funnel=commercial", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      funnelId: string;
      funnels: Array<{ id: string }>;
      stageOrder: string[];
      reached: Record<string, number>;
    };
    expect(body.funnelId).toBe("commercial");
    expect(body.stageOrder).toEqual([
      "enquiry",
      "site_visit",
      "proposal",
      "won",
      "lost",
    ]);
    expect(body.reached.won).toBeGreaterThanOrEqual(1);
    const ids = body.funnels.map((f) => f.id).sort();
    expect(ids).toEqual(["commercial", "default", "residential"]);

    const unknown = await app.request("/v1/admin/deals/stats?funnel=nope", {
      headers: AUTH_HEADER,
    });
    expect(unknown.status).toBe(404);

    const list = await app.request(
      "/v1/admin/deals?funnel=residential&provider=funnelcrm",
      { headers: AUTH_HEADER },
    );
    const listBody = (await list.json()) as {
      deals: Array<{ funnelId: string | null }>;
      total: number;
    };
    // The original residential deal + the adopted legacy one.
    expect(listBody.total).toBe(2);
    expect(listBody.deals.every((d) => d.funnelId === "residential")).toBe(
      true,
    );
  });

  it("callback-form bindings run arbitrary resolve logic; unknown outputs record without advancing", async () => {
    const cbEmail = `${RUN}-cb@example.com`;
    const callbackFunnel = defineFunnel({
      id: "cb",
      stages: ["one", { id: "two", milestone: "won" }],
      bindings: [
        crmPipeline({
          provider: "funnelcrm",
          pipeline: "p-cb",
          resolve: (e) => {
            if (e.stageId === "explode") throw new Error("boom");
            return e.stageId === "advance"
              ? "two"
              : e.stageId === "mystery"
                ? "not-a-stage" // runtime-unknown output → record, don't advance
                : "one";
          },
        }),
      ],
    });
    const cbContainer = createHogsendClient({
      crm: { provider: crm },
      funnels: [callbackFunnel],
      overrides: { hatchet: mockHatchet },
    });
    const cbApp = createApp(cbContainer);
    const cbPost = (events: unknown) =>
      cbApp.request("/v1/webhooks/crm/funnelcrm", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-funnelcrm-secret": "shhh",
        },
        body: JSON.stringify(events),
      });

    expect(
      (
        await cbPost([
          stageEvent({
            deal: `${RUN}-d-cb`,
            email: cbEmail,
            pipeline: "p-cb",
            stageId: "anything",
            at: "2026-07-12T15:00:00.000Z",
          }),
          stageEvent({
            deal: `${RUN}-d-cb`,
            email: cbEmail,
            pipeline: "p-cb",
            stageId: "mystery",
            at: "2026-07-12T15:30:00.000Z",
          }),
        ])
      ).status,
    ).toBe(200);

    const rows = await db
      .select()
      .from(deals)
      .where(eq(deals.externalId, `${RUN}-d-cb`));
    // "anything" → callback mapped to "one"; "mystery" resolved to a stage
    // outside the ladder → rank null → the raw event lands on the spine but
    // the projection holds its last APPLIED change.
    expect(rows[0]).toMatchObject({
      funnelId: "cb",
      canonicalStage: "one",
      stageRank: 0,
      stageId: "anything",
    });
    expect(rows[0]?.soldAt).toBeNull();

    // A THROWING resolve is contained: the raw stage change still lands on
    // the spine (the transition is not lost) and the projection is untouched.
    expect(
      (
        await cbPost([
          stageEvent({
            deal: `${RUN}-d-cb`,
            email: cbEmail,
            pipeline: "p-cb",
            stageId: "explode",
            at: "2026-07-12T15:45:00.000Z",
          }),
        ])
      ).status,
    ).toBe(200);
    const cbContactRow = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.email, cbEmail));
    const cbSpine = await db
      .select()
      .from(userEvents)
      .where(eq(userEvents.userId, cbContactRow[0]?.id as string));
    expect(
      cbSpine.filter((e) => e.event === "funnel.stage_changed"),
    ).toHaveLength(3);
    const midway = await db
      .select()
      .from(deals)
      .where(eq(deals.externalId, `${RUN}-d-cb`));
    expect(midway[0]).toMatchObject({ canonicalStage: "one", stageRank: 0 });

    expect(
      (
        await cbPost([
          stageEvent({
            deal: `${RUN}-d-cb`,
            email: cbEmail,
            pipeline: "p-cb",
            stageId: "advance",
            at: "2026-07-12T16:00:00.000Z",
            value: 500,
          }),
        ])
      ).status,
    ).toBe(200);
    const after = await db
      .select()
      .from(deals)
      .where(eq(deals.externalId, `${RUN}-d-cb`));
    expect(after[0]).toMatchObject({ canonicalStage: "two", stageRank: 1 });
    expect(after[0]?.soldAt).not.toBeNull();

    // Cleanup this test's contact (outside the shared afterAll emails).
    const cbContact = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.email, cbEmail));
    const cbIds = cbContact.map((r) => r.id);
    if (cbIds.length > 0) {
      await db.delete(userEvents).where(inArray(userEvents.userId, cbIds));
      await db.delete(deals).where(inArray(deals.contactId, cbIds));
      await db.delete(crmLinks).where(inArray(crmLinks.contactId, cbIds));
      await db.delete(contacts).where(inArray(contacts.id, cbIds));
    }
  });

  it('a funnel\'s "*" binding is a per-stage fallback for its exact-pipeline bindings', async () => {
    // The pre-bindings sugar shape: a shared won-stage in "*" plus
    // pipeline-specific extras. An exact-pipeline event whose stage id only
    // exists in the "*" map must still resolve (old resolveCanonicalStage
    // semantics: exact entry, then the same funnel's "*" entry).
    const wcEmail = `${RUN}-wc@example.com`;
    const wcFunnel = defineFunnel({
      id: "wc",
      stages: ["open", { id: "closed", milestone: "won" }],
      bindings: [
        crmPipeline({
          provider: "funnelcrm",
          pipeline: "p-wc",
          stages: { "s-special": "open" },
        }),
        crmPipeline({
          provider: "funnelcrm",
          pipeline: "*",
          stages: { "s-shared-won": "closed" },
        }),
      ],
    });
    const wcContainer = createHogsendClient({
      crm: { provider: crm },
      funnels: [wcFunnel],
      overrides: { hatchet: mockHatchet },
    });
    const wcApp = createApp(wcContainer);
    expect(
      (
        await wcApp.request("/v1/webhooks/crm/funnelcrm", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-funnelcrm-secret": "shhh",
          },
          body: JSON.stringify([
            stageEvent({
              deal: `${RUN}-d-wc`,
              email: wcEmail,
              pipeline: "p-wc",
              stageId: "s-shared-won",
              at: "2026-07-12T17:00:00.000Z",
              value: 777,
            }),
          ]),
        })
      ).status,
    ).toBe(200);

    const rows = await db
      .select()
      .from(deals)
      .where(eq(deals.externalId, `${RUN}-d-wc`));
    expect(rows[0]).toMatchObject({
      funnelId: "wc",
      canonicalStage: "closed",
      stageRank: 1,
    });
    expect(rows[0]?.soldAt).not.toBeNull();

    const wcContact = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.email, wcEmail));
    const wcIds = wcContact.map((r) => r.id);
    if (wcIds.length > 0) {
      await db.delete(userEvents).where(inArray(userEvents.userId, wcIds));
      await db.delete(deals).where(inArray(deals.contactId, wcIds));
      await db.delete(crmLinks).where(inArray(crmLinks.contactId, wcIds));
      await db.delete(contacts).where(inArray(contacts.id, wcIds));
    }
  });
});
