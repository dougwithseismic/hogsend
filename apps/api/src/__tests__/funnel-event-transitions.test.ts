import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, crmLinks, deals, userEvents } = await import("@hogsend/db");
const { eq, inArray } = await import("drizzle-orm");
const {
  createHogsendClient,
  crmPipeline,
  defineFunnel,
  getContactRevenue,
  ingestCrmStageEvents,
  ingestEvent,
} = await import("@hogsend/engine");

const RUN = `fet-${Date.now()}`;
const USER = `${RUN}-user`;
const USER_MULTI = `${RUN}-multi`;
const USER_BROWSER = `${RUN}-browser`;
const USER_NONMONEY = `${RUN}-nonmoney`;

/** The flagship event-native funnel: trial → activated → subscribed. */
const selfServe = defineFunnel({
  id: `${RUN}-self-serve`,
  name: "Self-serve",
  stages: [
    { id: "trial", on: `${RUN}.trial_started` },
    { id: "activated", on: `${RUN}.activated` },
    {
      id: "quoted_stage",
      on: {
        event: `${RUN}.quote_sent`,
        where: (b) => b.prop("total").gte(1000),
      },
      milestone: "quoted",
    },
    { id: "subscribed", on: `${RUN}.subscribed`, milestone: "won" },
  ],
  lostOn: `${RUN}.churned`,
});

/** No `won` milestone → non-monetary: must never mint money events. */
const onboarding = defineFunnel({
  id: `${RUN}-onboarding`,
  name: "Onboarding",
  stages: [
    { id: "invited", on: `${RUN}.ob_invited` },
    { id: "completed", on: `${RUN}.ob_completed` },
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
  funnels: [selfServe, onboarding],
  overrides: { hatchet: mockHatchet },
});
const { db, registry, hatchet, logger } = container;

const USERS = [USER, USER_MULTI, USER_BROWSER, USER_NONMONEY];

afterAll(async () => {
  const rows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(inArray(contacts.externalId, USERS));
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    await db.delete(deals).where(inArray(deals.contactId, ids));
    await db.delete(crmLinks).where(inArray(crmLinks.contactId, ids));
  }
  await db.delete(userEvents).where(inArray(userEvents.userId, USERS));
  await db.delete(contacts).where(inArray(contacts.externalId, USERS));
});

const send = (opts: {
  event: string;
  userId?: string;
  at: string;
  source?: string;
  value?: number;
  properties?: Record<string, unknown>;
}) =>
  ingestEvent({
    db,
    registry,
    hatchet,
    logger,
    event: {
      event: opts.event,
      userId: opts.userId ?? USER,
      eventProperties: opts.properties ?? {},
      ...(opts.value !== undefined
        ? { value: opts.value, currency: "GBP" }
        : {}),
      occurredAt: opts.at,
      idempotencyKey: `${RUN}:${opts.userId ?? USER}:${opts.event}:${opts.at}`,
      source: opts.source ?? "api",
    },
  });

async function dealFor(userId: string, funnelId: string) {
  const contact = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.externalId, userId));
  const rows = await db
    .select()
    .from(deals)
    .where(eq(deals.contactId, contact[0]?.id as string));
  return rows.filter((d) => d.funnelId === funnelId);
}

async function eventsFor(userId: string, name: string) {
  const rows = await db
    .select()
    .from(userEvents)
    .where(eq(userEvents.userId, userId));
  return rows.filter((r) => r.event === name);
}

describe("event-driven funnel transitions", () => {
  it("boot: deal.*/funnel.*/crm.* triggers are rejected at define time", () => {
    for (const bad of ["deal.sold", "funnel.stage_changed", "crm.anything"]) {
      expect(() =>
        defineFunnel({
          id: "bad",
          stages: [{ id: "a", on: bad }],
        }),
      ).toThrow(/cannot be a stage trigger/);
    }
  });

  it("an event trigger creates the deal, advances monotonically, and where-gates", async () => {
    // trial → deal minted under the synthetic "events" provider.
    await send({ event: `${RUN}.trial_started`, at: "2026-07-10T09:00:00Z" });
    let rows = await dealFor(USER, selfServe.meta.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "events",
      canonicalStage: "trial",
      stageRank: 0,
    });
    const externalId = rows[0]?.externalId as string;
    expect(externalId.startsWith(`${selfServe.meta.id}:`)).toBe(true);

    // where-gate: a £500 quote does NOT move the deal (needs >= 1000).
    await send({
      event: `${RUN}.quote_sent`,
      at: "2026-07-10T10:00:00Z",
      value: 500,
      properties: { total: 500 },
    });
    rows = await dealFor(USER, selfServe.meta.id);
    expect(rows[0]?.canonicalStage).toBe("trial");
    expect(await eventsFor(USER, "deal.quoted")).toHaveLength(0);

    // activated advances; a REPLAY of trial_started (lower rank) does not
    // regress (and the duplicate idempotency key no-ops entirely).
    await send({ event: `${RUN}.activated`, at: "2026-07-10T11:00:00Z" });
    await send({ event: `${RUN}.trial_started`, at: "2026-07-10T09:00:00Z" });
    rows = await dealFor(USER, selfServe.meta.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ canonicalStage: "activated" });
  });

  it("milestones mint deal.quoted/deal.sold once, valued, source 'funnel'", async () => {
    await send({
      event: `${RUN}.quote_sent`,
      at: "2026-07-10T12:00:00Z",
      value: 14500,
      properties: { total: 14500 },
    });
    const quoted = await eventsFor(USER, "deal.quoted");
    expect(quoted).toHaveLength(1);
    expect(quoted[0]).toMatchObject({
      value: 14500,
      currency: "GBP",
      source: "funnel",
    });
    expect(quoted[0]?.properties).toMatchObject({
      funnel_id: selfServe.meta.id,
      canonical_stage: "quoted_stage",
      trigger_event: `${RUN}.quote_sent`,
    });

    await send({
      event: `${RUN}.subscribed`,
      at: "2026-07-10T13:00:00Z",
      value: 15000,
    });
    const sold = await eventsFor(USER, "deal.sold");
    expect(sold).toHaveLength(1);
    expect(sold[0]?.value).toBe(15000);
    const rows = await dealFor(USER, selfServe.meta.id);
    expect(rows[0]).toMatchObject({ canonicalStage: "subscribed" });
    expect(rows[0]?.soldAt).not.toBeNull();
    expect(rows[0]?.quotedAt).not.toBeNull();
  });

  it("a lost trigger with no open deal is a no-op; with an open deal it closes it", async () => {
    // USER's deal is SOLD (not open) — churned must not resurrect/lose it,
    // and must not mint a fresh row born lost.
    await send({ event: `${RUN}.churned`, at: "2026-07-10T14:00:00Z" });
    const rows = await dealFor(USER, selfServe.meta.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ canonicalStage: "subscribed" });
    expect(rows[0]?.lostAt).toBeNull();

    // A second user with an OPEN deal loses it.
    await send({
      event: `${RUN}.trial_started`,
      userId: USER_MULTI,
      at: "2026-07-11T09:00:00Z",
    });
    await send({
      event: `${RUN}.churned`,
      userId: USER_MULTI,
      at: "2026-07-11T10:00:00Z",
    });
    const multi = await dealFor(USER_MULTI, selfServe.meta.id);
    expect(multi).toHaveLength(1);
    expect(multi[0]).toMatchObject({ canonicalStage: "lost" });
    expect(multi[0]?.lostAt).not.toBeNull();
  });

  it("deal_id property addresses one deal explicitly (multi-deal)", async () => {
    await send({
      event: `${RUN}.trial_started`,
      userId: USER_MULTI,
      at: "2026-07-11T11:00:00Z",
      properties: { deal_id: "job-A" },
    });
    await send({
      event: `${RUN}.trial_started`,
      userId: USER_MULTI,
      at: "2026-07-11T11:05:00Z",
      properties: { deal_id: "job-B" },
    });
    await send({
      event: `${RUN}.subscribed`,
      userId: USER_MULTI,
      at: "2026-07-11T12:00:00Z",
      value: 900,
      properties: { deal_id: "job-B" },
    });
    const rows = await dealFor(USER_MULTI, selfServe.meta.id);
    const a = rows.find((d) => d.externalId.endsWith(":job-A"));
    const b = rows.find((d) => d.externalId.endsWith(":job-B"));
    expect(a).toMatchObject({ canonicalStage: "trial" });
    expect(b).toMatchObject({ canonicalStage: "subscribed" });
    expect(b?.soldAt).not.toBeNull();
    // Exactly one deal.sold for job-B (freshness is a row fact).
    const sold = await eventsFor(USER_MULTI, "deal.sold");
    expect(sold).toHaveLength(1);
  });

  it("trust gate: browser (inapp) events cannot move deals by default", async () => {
    await send({
      event: `${RUN}.trial_started`,
      userId: USER_BROWSER,
      at: "2026-07-11T09:00:00Z",
      source: "inapp",
    });
    expect(await dealFor(USER_BROWSER, selfServe.meta.id)).toHaveLength(0);
    // The event itself still lands on the spine.
    expect(await eventsFor(USER_BROWSER, `${RUN}.trial_started`)).toHaveLength(
      1,
    );
  });

  it("non-monetary funnels track stages but never mint money events", async () => {
    await send({
      event: `${RUN}.ob_invited`,
      userId: USER_NONMONEY,
      at: "2026-07-11T09:00:00Z",
    });
    await send({
      event: `${RUN}.ob_completed`,
      userId: USER_NONMONEY,
      at: "2026-07-11T10:00:00Z",
      value: 999, // a valued event must STILL not mint on a non-monetary funnel
    });
    const rows = await dealFor(USER_NONMONEY, onboarding.meta.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      canonicalStage: "completed",
      stageRank: 1,
    });
    expect(rows[0]?.soldAt).toBeNull();
    expect(await eventsFor(USER_NONMONEY, "deal.sold")).toHaveLength(0);
    expect(await eventsFor(USER_NONMONEY, "deal.quoted")).toHaveLength(0);
  });

  it("one event can move two funnels independently for the same contact", async () => {
    // USER_NONMONEY also enters self-serve via its own trigger — the two
    // funnels' deals are independent rows.
    await send({
      event: `${RUN}.trial_started`,
      userId: USER_NONMONEY,
      at: "2026-07-11T11:00:00Z",
    });
    const selfRows = await dealFor(USER_NONMONEY, selfServe.meta.id);
    const obRows = await dealFor(USER_NONMONEY, onboarding.meta.id);
    expect(selfRows).toHaveLength(1);
    expect(obRows).toHaveLength(1);
    expect(selfRows[0]?.externalId).not.toBe(obRows[0]?.externalId);
  });

  it("hybrid: an event trigger moves the contact's open CRM-born deal in place (no second row, no double-mint)", async () => {
    const HYBRID = `${RUN}-hybrid`;
    // Seed identity + a CRM-born open deal in the same funnel.
    await send({
      event: `${RUN}.noop_seed`,
      userId: HYBRID,
      at: "2026-07-12T08:00:00Z",
    });
    const contact = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.externalId, HYBRID));
    const contactId = contact[0]?.id as string;
    await db.insert(deals).values({
      provider: "somecrm",
      externalId: `${RUN}-crm-deal-1`,
      contactId,
      funnelId: selfServe.meta.id,
      canonicalStage: "trial",
      stageRank: 0,
      lastStageAt: new Date("2026-07-12T08:30:00Z"),
    });

    // The event trigger must converge on the CRM row, not mint an
    // "events"-provider sibling.
    await send({
      event: `${RUN}.subscribed`,
      userId: HYBRID,
      at: "2026-07-12T09:00:00Z",
      value: 4200,
    });
    const rows = await dealFor(HYBRID, selfServe.meta.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "somecrm",
      externalId: `${RUN}-crm-deal-1`,
      canonicalStage: "subscribed",
      value: 4200,
    });
    expect(rows[0]?.soldAt).not.toBeNull();
    expect(await eventsFor(HYBRID, "deal.sold")).toHaveLength(1);

    // Cleanup (HYBRID is outside the shared afterAll list).
    await db.delete(deals).where(eq(deals.contactId, contactId));
    await db.delete(userEvents).where(eq(userEvents.userId, HYBRID));
    await db.delete(contacts).where(eq(contacts.id, contactId));
  });

  it("contact merges re-point deals onto the survivor (no duplicate deal cycle)", async () => {
    const SURV = `${RUN}-surv`;
    const LOSER_EMAIL = `${RUN}-loser@example.com`;
    // Loser: email-only contact with an OPEN event-minted deal.
    await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event: `${RUN}.trial_started`,
        userEmail: LOSER_EMAIL,
        eventProperties: {},
        occurredAt: "2026-07-12T10:00:00Z",
        idempotencyKey: `${RUN}:loser:trial`,
        source: "api",
      },
    });
    const loser = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.email, LOSER_EMAIL));
    const loserId = loser[0]?.id as string;
    const loserDeals = await db
      .select()
      .from(deals)
      .where(eq(deals.contactId, loserId));
    expect(loserDeals).toHaveLength(1);

    // Survivor: identified contact. An event carrying BOTH keys collides the
    // two rows and merges inside resolveOrCreateContact.
    await send({
      event: `${RUN}.noop_seed`,
      userId: SURV,
      at: "2026-07-12T10:30:00Z",
    });
    await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event: `${RUN}.merge_trigger`,
        userId: SURV,
        userEmail: LOSER_EMAIL,
        eventProperties: {},
        occurredAt: "2026-07-12T11:00:00Z",
        idempotencyKey: `${RUN}:merge`,
        source: "api",
      },
    });
    const survivor = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.externalId, SURV));
    const survivorId = survivor[0]?.id as string;

    // The loser's deal now belongs to the survivor...
    const moved = await db
      .select()
      .from(deals)
      .where(eq(deals.contactId, survivorId));
    expect(moved).toHaveLength(1);
    expect(moved[0]?.externalId).toBe(loserDeals[0]?.externalId);

    // ...so the survivor's milestone event advances THAT deal — exactly one
    // deal, exactly one deal.sold (the pre-fix behavior minted a second row).
    await send({
      event: `${RUN}.subscribed`,
      userId: SURV,
      at: "2026-07-12T12:00:00Z",
      value: 3000,
    });
    const after = await db
      .select()
      .from(deals)
      .where(eq(deals.contactId, survivorId));
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ canonicalStage: "subscribed" });
    expect(await eventsFor(SURV, "deal.sold")).toHaveLength(1);

    // Cleanup.
    await db.delete(deals).where(eq(deals.contactId, survivorId));
    await db
      .delete(userEvents)
      .where(inArray(userEvents.userId, [survivorId, loserId, SURV]));
    await db
      .delete(contacts)
      .where(inArray(contacts.id, [survivorId, loserId]));
  });

  it("a milestone trigger's raw value is excluded from revenue rollups (no double-count)", async () => {
    // USER's history: quote_sent(14500) + subscribed(15000) raw triggers,
    // plus the minted deal.quoted(14500, excluded) + deal.sold(15000,
    // counts). Correct realized revenue = 15000, counted ONCE.
    const revenue = await getContactRevenue({ db, key: USER });
    expect(revenue.totals).toEqual([
      { currency: "GBP", total: 15000, count: 1 },
    ]);
  });

  it("explicit deal_id + lost trigger with no prior deal is a no-op (no row born lost)", async () => {
    const GHOST = `${RUN}-ghost`;
    await send({
      event: `${RUN}.churned`,
      userId: GHOST,
      at: "2026-07-12T13:00:00Z",
      properties: { deal_id: "never-seen" },
    });
    const contact = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.externalId, GHOST));
    const rows = await db
      .select()
      .from(deals)
      .where(eq(deals.contactId, contact[0]?.id as string));
    expect(rows).toHaveLength(0);
    await db.delete(userEvents).where(eq(userEvents.userId, GHOST));
    await db.delete(contacts).where(eq(contacts.externalId, GHOST));
  });

  it("a CRM stage event ADOPTS the contact's open event-minted deal (re-keys, no sibling)", async () => {
    const ADOPT = `${RUN}-adopt`;
    const ADOPT_EMAIL = `${ADOPT}@example.com`;
    // A hybrid funnel in its own container: event trigger opens the deal,
    // the CRM binding claims provider "adoptcrm" (the demo-funnel flow).
    const hybrid = defineFunnel({
      id: `${RUN}-hybrid-adopt`,
      stages: [
        { id: "open", on: `${RUN}.adopt_open` },
        { id: "won_stage", milestone: "won" },
      ],
      bindings: [
        crmPipeline({
          provider: "adoptcrm",
          pipeline: "*",
          stages: { "s-won": "won_stage" },
        }),
      ],
    });
    const hybridContainer = createHogsendClient({
      funnels: [hybrid],
      overrides: { hatchet: mockHatchet },
    });

    // Event trigger opens the synthetic deal (email-keyed contact so the
    // CRM event resolves to the same person).
    await ingestEvent({
      db: hybridContainer.db,
      registry: hybridContainer.registry,
      hatchet: hybridContainer.hatchet,
      logger: hybridContainer.logger,
      event: {
        event: `${RUN}.adopt_open`,
        userId: ADOPT,
        userEmail: ADOPT_EMAIL,
        eventProperties: {},
        occurredAt: "2026-07-12T14:00:00Z",
        idempotencyKey: `${RUN}:adopt:open`,
        source: "api",
      },
    });
    const contact = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.externalId, ADOPT));
    const contactId = contact[0]?.id as string;
    const before = await db
      .select()
      .from(deals)
      .where(eq(deals.contactId, contactId));
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ provider: "events" });

    // The CRM now reports the same deal under its native id — the open
    // synthetic row is ADOPTED (re-keyed), not shadowed by a sibling, and
    // the won stage mints exactly one deal.sold on the adopted row.
    await ingestCrmStageEvents({
      db,
      registry,
      hatchet,
      logger,
      providerId: "adoptcrm",
      events: [
        {
          dealId: "native-777",
          email: ADOPT_EMAIL,
          pipelineId: "p-x",
          stageId: "s-won",
          value: { amount: 6000, currency: "GBP" },
          occurredAt: "2026-07-12T15:00:00.000Z",
          raw: {},
        },
      ],
      funnels: hybridContainer.funnels,
    });

    const rows = await db
      .select()
      .from(deals)
      .where(eq(deals.contactId, contactId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "adoptcrm",
      externalId: "native-777",
      canonicalStage: "won_stage",
      value: 6000,
    });
    expect(rows[0]?.soldAt).not.toBeNull();
    const sold = await eventsFor(ADOPT, "deal.sold");
    expect(sold).toHaveLength(1);

    await db.delete(deals).where(eq(deals.contactId, contactId));
    await db
      .delete(crmLinks)
      .where(inArray(crmLinks.externalId, ["native-777"]));
    await db.delete(userEvents).where(eq(userEvents.userId, ADOPT));
    await db.delete(contacts).where(eq(contacts.id, contactId));
  });
});
