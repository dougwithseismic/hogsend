/**
 * GET /v1/admin/flow?mode=curated — the registry-backed control room (P2).
 *
 * Proves: journeys and funnel stages auto-register as nodes with real tiers;
 * the classifier's precedence (a journey stamp beats a funnel trigger beats a
 * valued event); heat (attributed revenue from the ledger, direct revenue from
 * valued events, conversion rate) never merges the two revenue kinds; dwell
 * finds the pile-up and excludes revenue-tier destinations; journey nodes carry
 * a live enrollment count.
 *
 * And — the load-bearing one — CLASSIFIER PARITY: the TS classifier
 * (`topology.classifyEvent`, the live path) and the SQL classifier
 * (`topology.classifierSql`, the aggregate path) are two compilations of one
 * rule list. A table of synthetic events is run through BOTH and the node ids
 * must match exactly. If they ever drift, the live map and the windowed map
 * tell different stories about the same event.
 *
 * The fixtures are a purpose-built journey + funnel (not the app's), so every
 * count is exact on a shared dev database. The one exception is the builtin
 * `revenue` node, which any valued event in the window lands on — those
 * assertions are scoped to a currency this suite alone uses.
 */
import type { HogsendClient } from "@hogsend/engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { attributionCredits, contacts, conversions, journeyStates, userEvents } =
  await import("@hogsend/db");
const { inArray, like, sql } = await import("drizzle-orm");
const { days } = await import("@hogsend/core");
const { createApp, createHogsendClient, defineFunnel, defineJourney } =
  await import("@hogsend/engine");

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

// Run-scoped everything: ids, event names, journey + funnel ids. A shared
// docker DB carries other suites' rows, and the curated classifier is keyed by
// the registry — so the fixtures must own their own namespace to stay exact.
const RUN = `cflow-${Date.now()}`;
const JOURNEY_ID = `${RUN}-journey`;
const FUNNEL_ID = `${RUN}-funnel`;
const ENQUIRY_EVENT = `${RUN}.enquiry_received`;
const SIGNED_EVENT = `${RUN}.contract_signed`;
const STAMPED_EVENT = `${RUN}.email_opened`;
const PURCHASE_EVENT = `${RUN}.purchase_completed`;
const NOISE_EVENT = `${RUN}.noise`;
/** A currency no other suite uses — the shared `revenue` node's escape hatch. */
const CURRENCY = "CHF";

const JOURNEY_NODE = `journey:${JOURNEY_ID}`;
const ENQUIRY_NODE = `funnel:${FUNNEL_ID}:enquiry`;
const PROPOSAL_NODE = `funnel:${FUNNEL_ID}:proposal`;
const SIGNED_NODE = `funnel:${FUNNEL_ID}:contract_signed`;
const REVENUE_NODE = "revenue";

const testJourney = defineJourney({
  meta: {
    id: JOURNEY_ID,
    name: "Flow map fixture",
    enabled: true,
    trigger: { event: `${RUN}.enrolled` },
    entryLimit: "unlimited",
    suppress: days(0),
  },
  run: async () => {},
});

const PROPOSAL_EVENT = `${RUN}.proposal_sent`;

const testFunnel = defineFunnel({
  id: FUNNEL_ID,
  name: "Flow map funnel",
  stages: [
    { id: "enquiry", on: ENQUIRY_EVENT },
    "site_visit",
    { id: "proposal", on: PROPOSAL_EVENT, milestone: "quoted" },
    { id: "contract_signed", on: SIGNED_EVENT, milestone: "won" },
  ],
});

const container = createHogsendClient({
  journeys: [testJourney],
  funnels: [testFunnel],
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db, flowTopology } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

type FlowNode = {
  id: string;
  kind: string;
  name: string;
  tier: string;
  contacts: number;
  events: number;
  live: number | null;
  heat: {
    conversionRate: number | null;
    attributedRevenue: { amount: number; currency: string }[];
    directRevenue: { amount: number; currency: string }[];
  } | null;
  dwell: {
    stuckContacts: number;
    thresholdHours: number;
    oldestLastSeenAt: string | null;
    p50HoursStuck: number | null;
  } | null;
};
type FlowResponse = {
  nodes: FlowNode[];
  edges: { from: string; to: string; transitions: number; contacts: number }[];
};

let flow: FlowResponse;

const HOUR = 60 * 60 * 1000;
const base = Date.now() - HOUR;
/** Distinct, ordered timestamps — the edge sequence orders by (occurred_at, id). */
const at = (step: number) => new Date(base + step * 1000);
/** Three days idle: past the 48h dwell threshold, inside the 7d window. */
const stuckAt = new Date(Date.now() - 72 * HOUR);

const C1 = `${RUN}-c1`;
const C2 = `${RUN}-c2`;
const STUCK = `${RUN}-stuck`;
const STUCK_WON = `${RUN}-stuck-won`;
/** The conversion's instant — after every node the walker reached. */
const CONVERTED_AT = new Date(Date.now() - 30 * 60 * 1000);

type EventRow = typeof userEvents.$inferInsert;

beforeAll(async () => {
  // Self-healing sweep (P1's convention): a run killed before afterAll strands
  // rows that skew every later run. Clear ALL cflow litter, not just this run's.
  await db.delete(contacts).where(like(contacts.externalId, "cflow-%"));
  await db.delete(journeyStates).where(like(journeyStates.userId, "cflow-%"));
  await db.delete(userEvents).where(like(userEvents.userId, "cflow-%"));

  // Two contacts walk enquiry → (a journey-stamped engagement event) → signed.
  // The middle event carries `properties.journeyId`, which is exactly how the
  // tracked mailer stamps an open/click — so it must classify to the JOURNEY,
  // not to the surface the link happened to point at.
  const rows: EventRow[] = [C1, C2].flatMap((userId) => [
    { userId, event: ENQUIRY_EVENT, source: "test", occurredAt: at(0) },
    {
      userId,
      event: STAMPED_EVENT,
      source: "tracking",
      properties: { journeyId: JOURNEY_ID },
      occurredAt: at(1),
    },
    { userId, event: SIGNED_EVENT, source: "test", occurredAt: at(2) },
  ]);

  rows.push(
    // Money that lands nowhere else → the builtin revenue node.
    {
      userId: C1,
      event: PURCHASE_EVENT,
      source: "test",
      value: 49.99,
      currency: CURRENCY,
      occurredAt: at(3),
    },
    // Noise nobody claims — must NOT become a node.
    {
      userId: `${RUN}-c3`,
      event: NOISE_EVENT,
      source: "test",
      occurredAt: at(0),
    },
    // The pile-up: last classified event is the enquiry stage, three days ago.
    {
      userId: STUCK,
      event: ENQUIRY_EVENT,
      source: "test",
      occurredAt: stuckAt,
    },
    // …and a contact "stuck" on a WON stage, which is a destination, not a
    // pile-up. Conversion destinations are excluded from dwell by default.
    {
      userId: STUCK_WON,
      event: SIGNED_EVENT,
      source: "test",
      occurredAt: stuckAt,
    },
    // …but a contact stuck on the QUOTED stage is THE pile-up that matters —
    // quoted is revenue-TIER (display) yet absolutely dwell-eligible: a quote
    // with no signature is what #486 exists to surface.
    {
      userId: `${RUN}-stuck-quoted`,
      event: PROPOSAL_EVENT,
      source: "test",
      occurredAt: stuckAt,
    },
    // A second run-scoped currency on the revenue node — the money arrays
    // must come back deterministically ordered (currency asc) across polls.
    {
      userId: `${RUN}-dkk`,
      event: PURCHASE_EVENT,
      source: "test",
      value: 10,
      currency: "DKK",
      occurredAt: at(4),
    },
  );

  const inserted = await db.insert(userEvents).values(rows).returning({
    id: userEvents.id,
    userId: userEvents.userId,
    event: userEvents.event,
  });
  const eventId = (event: string, userId: string) =>
    inserted.find((r) => r.event === event && r.userId === userId)
      ?.id as string;

  // A conversion for walker #1, after it reached every node → conversionRate.
  const [contact] = await db
    .insert(contacts)
    .values({ externalId: C1, email: `${C1}@example.test` })
    .returning({ id: contacts.id });
  const [conversion] = await db
    .insert(conversions)
    .values({
      definitionId: `${RUN}-sale`,
      contactId: contact?.id as string,
      userKey: C1,
      eventId: eventId(PURCHASE_EVENT, C1),
      value: 500,
      currency: CURRENCY,
      occurredAt: CONVERTED_AT,
    })
    .returning({ id: conversions.id });

  // Ledger credit for the journey — under TWO models, so the `model` param is
  // doing real work: the flow map (default `linear`) must report 250, never 999.
  await db.insert(attributionCredits).values([
    {
      conversionId: conversion?.id as string,
      model: "linear",
      touchpointEventId: eventId(STAMPED_EVENT, C1),
      touchpointEvent: STAMPED_EVENT,
      channel: "email",
      touchpointAt: at(1),
      weight: 0.5,
      value: 250,
      currency: CURRENCY,
      journeyId: JOURNEY_ID,
      convertedAt: CONVERTED_AT,
    },
    {
      conversionId: conversion?.id as string,
      model: "first",
      touchpointEventId: eventId(STAMPED_EVENT, C1),
      touchpointEvent: STAMPED_EVENT,
      channel: "email",
      touchpointAt: at(1),
      weight: 1,
      value: 999,
      currency: CURRENCY,
      journeyId: JOURNEY_ID,
      convertedAt: CONVERTED_AT,
    },
  ]);

  // One live enrollment → the journey node's `live` count.
  await db.insert(journeyStates).values({
    userId: `${RUN}-live`,
    userEmail: `${RUN}-live@example.test`,
    journeyId: JOURNEY_ID,
    currentNodeId: "start",
    status: "active",
  });

  const res = await app.request(
    "/v1/admin/flow?windowDays=7&mode=curated&dwellThresholdHours=48",
    { headers: AUTH_HEADER },
  );
  expect(res.status).toBe(200);
  flow = (await res.json()) as FlowResponse;
});

afterAll(async () => {
  // contacts → conversions → attribution_credits all cascade.
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}%`));
  await db.delete(journeyStates).where(like(journeyStates.userId, `${RUN}%`));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}%`));
});

const nodeOf = (id: string) => flow.nodes.find((n) => n.id === id);
const edgeOf = (from: string, to: string) =>
  flow.edges.find((e) => e.from === from && e.to === to);

describe("curated classification", () => {
  it("registers journeys as retention nodes with real counts", () => {
    expect(nodeOf(JOURNEY_NODE)).toMatchObject({
      kind: "journey",
      name: "Flow map fixture",
      tier: "retention",
      contacts: 2,
      events: 2,
    });
  });

  it("registers funnel stages, with the money stages in the revenue tier", () => {
    expect(nodeOf(ENQUIRY_NODE)).toMatchObject({
      kind: "funnelStage",
      tier: "activation",
      // both walkers + the stuck contact
      contacts: 3,
      events: 3,
    });
    // `quoted` and everything at-or-after `won` are money stages.
    expect(nodeOf(PROPOSAL_NODE)?.tier).toBe("revenue");
    expect(nodeOf(SIGNED_NODE)).toMatchObject({
      tier: "revenue",
      contacts: 3,
    });
  });

  it("renders a registered stage with zero traffic (the registry is the node set)", () => {
    // Nobody ever hit `site_visit` — "nobody is here" is the answer, and it can
    // only be shown if the node is drawn.
    expect(nodeOf(`funnel:${FUNNEL_ID}:site_visit`)).toMatchObject({
      kind: "funnelStage",
      contacts: 0,
      events: 0,
    });
  });

  it("sends valued events nobody else claims to the builtin revenue node", () => {
    const revenue = nodeOf(REVENUE_NODE);
    expect(revenue).toMatchObject({ kind: "builtin", tier: "revenue" });
    expect(revenue?.contacts).toBeGreaterThanOrEqual(1);
  });

  it("drops unclassified events instead of inventing a node", () => {
    expect(flow.nodes.some((n) => n.id.includes(NOISE_EVENT))).toBe(false);
    // …and the raw classifier's prefix node is nowhere to be seen either.
    expect(nodeOf(RUN)).toBeUndefined();
  });

  it("draws edges through the journey the engagement event was stamped with", () => {
    expect(edgeOf(ENQUIRY_NODE, JOURNEY_NODE)).toMatchObject({
      transitions: 2,
      contacts: 2,
    });
    expect(edgeOf(JOURNEY_NODE, SIGNED_NODE)).toMatchObject({
      transitions: 2,
      contacts: 2,
    });
  });
});

describe("heat", () => {
  it("attaches ledger credit to the journey node under the requested model", () => {
    const heat = nodeOf(JOURNEY_NODE)?.heat;
    // linear (the default), NOT the `first`-model 999 row on the same conversion.
    expect(heat?.attributedRevenue).toEqual([
      { amount: 250, currency: CURRENCY },
    ]);
  });

  it("never merges attributed and direct revenue", () => {
    const journey = nodeOf(JOURNEY_NODE)?.heat;
    // The journey's own events carry no value — its money is attributed only.
    expect(journey?.directRevenue).toEqual([]);

    const direct = nodeOf(REVENUE_NODE)?.heat?.directRevenue ?? [];
    expect(direct.find((m) => m.currency === CURRENCY)?.amount).toBeCloseTo(
      49.99,
      2,
    );
    // Money that landed AT the revenue node was never credited to it.
    expect(nodeOf(REVENUE_NODE)?.heat?.attributedRevenue).toEqual([]);
  });

  it("orders money arrays deterministically (currency asc) so identity survives polls", () => {
    const direct = nodeOf(REVENUE_NODE)?.heat?.directRevenue ?? [];
    const chf = direct.findIndex((m) => m.currency === CURRENCY);
    const dkk = direct.findIndex((m) => m.currency === "DKK");
    expect(chf).toBeGreaterThanOrEqual(0);
    expect(dkk).toBeGreaterThanOrEqual(0);
    // CHF sorts before DKK; other suites' currencies may interleave, but the
    // relative order must be stable.
    expect(chf).toBeLessThan(dkk);
  });

  it("computes a conversion rate per node", () => {
    // One of the two contacts who reached the journey converted afterwards.
    expect(nodeOf(JOURNEY_NODE)?.heat?.conversionRate).toBeCloseTo(0.5, 5);
    // Three reached the enquiry stage; the same one converted.
    expect(nodeOf(ENQUIRY_NODE)?.heat?.conversionRate).toBeCloseTo(1 / 3, 5);
  });

  it("gives an untouched node a zeroed heat object, not null", () => {
    // Curated mode measured this node and found nothing — a different claim
    // from raw mode's "not measured" (null).
    expect(nodeOf(`funnel:${FUNNEL_ID}:site_visit`)?.heat).toEqual({
      conversionRate: null,
      attributedRevenue: [],
      directRevenue: [],
    });
  });
});

describe("dwell", () => {
  it("counts the contacts piled up on a node past the threshold", () => {
    const dwell = nodeOf(ENQUIRY_NODE)?.dwell;
    expect(dwell?.stuckContacts).toBe(1);
    expect(dwell?.thresholdHours).toBe(48);
    expect(Date.parse(dwell?.oldestLastSeenAt ?? "")).not.toBeNaN();
    // Idle ~72h.
    expect(dwell?.p50HoursStuck ?? 0).toBeGreaterThan(48);
  });

  it("excludes conversion destinations — a contact at the sale is not stuck", () => {
    // STUCK_WON's last event is 3 days old on the WON stage. It is a
    // destination, not a pile-up.
    expect(nodeOf(SIGNED_NODE)?.dwell?.stuckContacts).toBe(0);
  });

  it("measures dwell on the QUOTED stage — revenue-tier placement is not a dwell exclusion", () => {
    expect(nodeOf(PROPOSAL_NODE)?.dwell?.stuckContacts).toBe(1);
  });

  it("decouples the dwell lookback from the display window", async () => {
    // A 24h display window with a 48h threshold would be a structurally empty
    // band if the lookback were coupled — the stuck contact (72h idle) must
    // still be found.
    const res = await app.request(
      "/v1/admin/flow?windowDays=1&mode=curated&dwellThresholdHours=48",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const narrow = (await res.json()) as FlowResponse;
    const enquiry = narrow.nodes.find((n) => n.id === ENQUIRY_NODE);
    expect(enquiry?.dwell?.stuckContacts).toBe(1);
  });

  it("leaves a node with nobody stuck at zero, not null", () => {
    expect(nodeOf(JOURNEY_NODE)?.dwell).toMatchObject({
      stuckContacts: 0,
      thresholdHours: 48,
      oldestLastSeenAt: null,
    });
  });
});

describe("live overlay", () => {
  it("counts current enrollments on the journey node", () => {
    expect(nodeOf(JOURNEY_NODE)?.live).toBe(1);
  });

  it("leaves live null where 'currently in it' is not a state", () => {
    expect(nodeOf(ENQUIRY_NODE)?.live).toBeNull();
    expect(nodeOf(REVENUE_NODE)?.live).toBeNull();
  });
});

/**
 * THE load-bearing test. Every row here is run through the TS classifier and
 * the SQL classifier and must produce the same node id.
 */
describe("classifier parity (TS ↔ SQL)", () => {
  type Case = {
    label: string;
    event: string;
    source: string | null;
    properties?: Record<string, unknown>;
    value?: number | null;
    currency?: string;
  };

  const CASES: Case[] = [
    {
      label: "journey-stamped engagement event",
      event: STAMPED_EVENT,
      source: "tracking",
      properties: { journeyId: JOURNEY_ID },
    },
    {
      label: "funnel stage trigger",
      event: ENQUIRY_EVENT,
      source: "test",
    },
    {
      label: "valued event",
      event: PURCHASE_EVENT,
      source: "test",
      value: 12.5,
      currency: CURRENCY,
    },
    {
      label: "valued AND journey-stamped — the journey stamp wins",
      event: PURCHASE_EVENT,
      source: "api",
      properties: { journeyId: JOURNEY_ID },
      value: 20,
      currency: CURRENCY,
    },
    {
      label: "valued funnel trigger — the stage wins over revenue",
      event: SIGNED_EVENT,
      source: "test",
      value: 500,
      currency: CURRENCY,
    },
    {
      label: "unclassified",
      event: NOISE_EVENT,
      source: "test",
    },
    {
      label: "null source",
      event: ENQUIRY_EVENT,
      source: null,
    },
    {
      label: "weird properties — a NUMERIC journeyId is not a journey id",
      event: NOISE_EVENT,
      source: "test",
      properties: { journeyId: 7, nested: { a: [1, 2] } },
    },
    {
      label: "journeyId naming an unregistered journey",
      event: NOISE_EVENT,
      source: "test",
      properties: { journeyId: "no-such-journey" },
    },
    {
      label: "zero value is not revenue",
      event: NOISE_EVENT,
      source: "test",
      value: 0,
      currency: CURRENCY,
    },
    {
      label: "a refund (negative value) is not revenue",
      event: NOISE_EVENT,
      source: "test",
      value: -5,
      currency: CURRENCY,
    },
    {
      label: "empty properties bag",
      event: NOISE_EVENT,
      source: "test",
      properties: {},
    },
    {
      label:
        "sub-cent value rounds to 0.00 in storage — not revenue in EITHER compilation",
      event: NOISE_EVENT,
      source: "test",
      value: 0.004,
      currency: CURRENCY,
    },
    {
      label:
        "half-cent rounds UP to 0.01 in storage — revenue in BOTH compilations",
      event: NOISE_EVENT,
      source: "test",
      value: 0.005,
      currency: CURRENCY,
    },
  ];

  let sqlAnswers: Map<string, string | null>;

  beforeAll(async () => {
    const inserted = await db
      .insert(userEvents)
      .values(
        CASES.map((c, i) => ({
          userId: `${RUN}-parity-${i}`,
          event: c.event,
          source: c.source,
          properties: c.properties,
          value: c.value ?? null,
          currency: c.currency ?? null,
          occurredAt: at(100 + i),
        })),
      )
      .returning({ id: userEvents.id, userId: userEvents.userId });

    // The SAME `sql` fragment the aggregate query compiles, run over the rows.
    const rows = await db.execute<{ user_id: string; node_id: string | null }>(
      sql`
        select user_id, ${flowTopology.classifierSql()} as node_id
        from user_events
        where id in (${sql.join(
          inserted.map((r) => sql`${r.id}::uuid`),
          sql`, `,
        )})
      `,
    );
    sqlAnswers = new Map(rows.map((r) => [r.user_id, r.node_id]));
  });

  it.each(
    CASES.map((c, i) => [i, c] as const),
  )("case %i — %o", (i, testCase) => {
    const ts = flowTopology.classifyEvent({
      event: testCase.event,
      source: testCase.source,
      properties: testCase.properties,
      value: testCase.value ?? null,
    });
    const fromSql = sqlAnswers.get(`${RUN}-parity-${i}`);
    expect(fromSql).not.toBeUndefined();
    expect({ case: testCase.label, node: fromSql ?? null }).toEqual({
      case: testCase.label,
      node: ts,
    });
  });

  it("classifies the table the way the precedence rules say it should", () => {
    const answer = (i: number) => sqlAnswers.get(`${RUN}-parity-${i}`) ?? null;
    expect(answer(0)).toBe(JOURNEY_NODE);
    expect(answer(1)).toBe(ENQUIRY_NODE);
    expect(answer(2)).toBe(REVENUE_NODE);
    // Precedence 1 beats precedence 4.
    expect(answer(3)).toBe(JOURNEY_NODE);
    // Precedence 2 beats precedence 4.
    expect(answer(4)).toBe(SIGNED_NODE);
    for (const i of [5, 6, 7, 8, 9, 10, 11]) {
      if (i === 6) continue; // null source still matches the funnel trigger
      expect(answer(i)).toBeNull();
    }
    expect(answer(6)).toBe(ENQUIRY_NODE);
    // The numeric(14,2) storage boundary: 0.004 stores as 0.00 (not revenue),
    // 0.005 stores as 0.01 (revenue) — and the TS compilation must agree.
    expect(answer(12)).toBeNull();
    expect(answer(13)).toBe(REVENUE_NODE);
  });

  afterAll(async () => {
    await db.delete(userEvents).where(
      inArray(
        userEvents.userId,
        CASES.map((_, i) => `${RUN}-parity-${i}`),
      ),
    );
  });
});
