/**
 * GET /v1/admin/flow — `defineSurface` external touchpoints + acquisition lanes
 * (P3).
 *
 * Proves: surfaces auto-register as `surface:<id>` nodes with their declared
 * tier/name; the classifier's surface seam (exact events → prefixes, longest
 * first → source+where) resolves correctly and BELOW journeys/funnels but ABOVE
 * revenue; LIKE-special prefix chars match only literally; and `laneBy` colours
 * the map by first-touch `campaign.arrived` value (edge breakdowns + a
 * top-level summary + `organic` for the un-attributed).
 *
 * And — the load-bearing one — CLASSIFIER PARITY extends to surfaces: every
 * synthetic row runs through the TS classifier (`classifyEvent`) AND the SQL
 * classifier (`classifierSql`) and the node ids must match exactly.
 *
 * Everything is run-scoped (surface prefixes, sources, event names, journey +
 * funnel ids, campaign values) so counts stay exact on a shared dev database.
 */
import type { HogsendClient } from "@hogsend/engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, journeyStates, userEvents } = await import("@hogsend/db");
const { inArray, like, sql } = await import("drizzle-orm");
const { days } = await import("@hogsend/core");
const {
  createApp,
  createHogsendClient,
  defineFunnel,
  defineJourney,
  defineSurface,
} = await import("@hogsend/engine");

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

const RUN = `sflow-${Date.now()}`;
const JOURNEY_ID = `${RUN}-journey`;
const FUNNEL_ID = `${RUN}-funnel`;

// Run-scoped surface ids, prefixes, sources, event names.
const S = {
  docs: `${RUN}docs`,
  docsApi: `${RUN}docsapi`,
  promo: `${RUN}promo`,
  exact: `${RUN}exact`,
  exact2: `${RUN}exact2`,
  app: `${RUN}app`,
  billing: `${RUN}billing`,
  team: `${RUN}team`,
  guest: `${RUN}guest`,
  neq: `${RUN}neq`,
  contains: `${RUN}contains`,
  num: `${RUN}num`,
};
const DOCS_PREFIX = `${RUN}.docs.`;
const DOCS_API_PREFIX = `${RUN}.docs.api.`;
// A prefix carrying BOTH LIKE specials (% and _) — must match ONLY literally.
const PROMO_PREFIX = `${RUN}.100%_x.`;
const EXACT_EVENT = `${RUN}.exact_hit`;
const SHARED_EXACT = `${RUN}.shared_exact`;
const FUNNEL_TRIGGER = `${RUN}.docs.converted`;
const SRC_API = `${RUN}-api`;
const SRC_BILLING = `${RUN}-billing`;
const SRC_TEAM = `${RUN}-team`;
const SRC_GUEST = `${RUN}-guest`;
const SRC_NEQ = `${RUN}-neq`;
const SRC_CONTAINS = `${RUN}-contains`;
const SRC_NUM = `${RUN}-num`;

// Node ids.
const DOCS_NODE = `surface:${S.docs}`;
const DOCS_API_NODE = `surface:${S.docsApi}`;
const PROMO_NODE = `surface:${S.promo}`;
const EXACT_NODE = `surface:${S.exact}`;
const APP_NODE = `surface:${S.app}`;
const BILLING_NODE = `surface:${S.billing}`;
const TEAM_NODE = `surface:${S.team}`;
const GUEST_NODE = `surface:${S.guest}`;
const NEQ_NODE = `surface:${S.neq}`;
const CONTAINS_NODE = `surface:${S.contains}`;
const NUM_NODE = `surface:${S.num}`;
const JOURNEY_NODE = `journey:${JOURNEY_ID}`;
const FUNNEL_NODE = `funnel:${FUNNEL_ID}:enquiry`;
const REVENUE_NODE = "revenue";

const surfaces = [
  defineSurface({
    id: S.docs,
    name: "Docs site",
    tier: "acquisition",
    match: { eventPrefix: DOCS_PREFIX },
  }),
  // Longer prefix — must win over `docs.` for `docs.api.*` events.
  defineSurface({
    id: S.docsApi,
    tier: "acquisition",
    match: { eventPrefix: DOCS_API_PREFIX },
  }),
  defineSurface({
    id: S.promo,
    tier: "activation",
    match: { eventPrefix: PROMO_PREFIX },
  }),
  // Declared FIRST for the shared exact event — declaration order wins the tie.
  defineSurface({
    id: S.exact,
    tier: "activation",
    match: { events: [EXACT_EVENT, SHARED_EXACT] },
  }),
  defineSurface({
    id: S.exact2,
    tier: "activation",
    match: { events: [SHARED_EXACT] },
  }),
  defineSurface({
    id: S.app,
    tier: "activation",
    match: { source: SRC_API },
  }),
  defineSurface({
    id: S.billing,
    tier: "revenue",
    match: {
      source: SRC_BILLING,
      where: [{ property: "plan", operator: "eq", value: "pro" }],
    },
  }),
  defineSurface({
    id: S.team,
    tier: "retention",
    match: {
      source: SRC_TEAM,
      where: [{ property: "teamId", operator: "exists" }],
    },
  }),
  defineSurface({
    id: S.guest,
    tier: "acquisition",
    match: {
      source: SRC_GUEST,
      where: [{ property: "teamId", operator: "not_exists" }],
    },
  }),
  defineSurface({
    id: S.neq,
    tier: "acquisition",
    match: {
      source: SRC_NEQ,
      where: [{ property: "plan", operator: "neq", value: "pro" }],
    },
  }),
  defineSurface({
    id: S.contains,
    tier: "acquisition",
    match: {
      source: SRC_CONTAINS,
      where: [{ property: "q", operator: "contains", value: "hog" }],
    },
  }),
  // eq value "7" — a NUMERIC 7 must NOT match (string-only comparison law).
  defineSurface({
    id: S.num,
    tier: "acquisition",
    match: {
      source: SRC_NUM,
      where: [{ property: "n", operator: "eq", value: "7" }],
    },
  }),
];

const testJourney = defineJourney({
  meta: {
    id: JOURNEY_ID,
    name: "Surface fixture journey",
    enabled: true,
    trigger: { event: `${RUN}.enrolled` },
    entryLimit: "unlimited",
    suppress: days(0),
  },
  run: async () => {},
});

const testFunnel = defineFunnel({
  id: FUNNEL_ID,
  name: "Surface funnel",
  stages: [{ id: "enquiry", on: FUNNEL_TRIGGER }, "closed"],
});

const container = createHogsendClient({
  journeys: [testJourney],
  funnels: [testFunnel],
  surfaces,
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db, flowTopology } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

type ClassCase = {
  label: string;
  event: string;
  source: string | null;
  properties?: Record<string, unknown> | null;
  value?: number | null;
  expected: string | null;
};

// The one table that drives BOTH the correctness assertions and the TS↔SQL
// parity check.
const CASES: ClassCase[] = [
  {
    label: "exact event",
    event: EXACT_EVENT,
    source: "test",
    expected: EXACT_NODE,
  },
  {
    label: "shared exact event — first-declared surface wins",
    event: SHARED_EXACT,
    source: "test",
    expected: EXACT_NODE,
  },
  {
    label: "prefix match",
    event: `${RUN}.docs.page`,
    source: "web",
    expected: DOCS_NODE,
  },
  {
    label: "longest prefix wins (docs.api. beats docs.)",
    event: `${RUN}.docs.api.call`,
    source: "web",
    expected: DOCS_API_NODE,
  },
  {
    label: "LIKE-special prefix matches literally",
    event: `${RUN}.100%_x.go`,
    source: "web",
    expected: PROMO_NODE,
  },
  {
    label: "LIKE-special prefix does NOT wildcard-match",
    event: `${RUN}.100ABCDx.go`,
    source: "web",
    expected: null,
  },
  {
    label: "source match",
    event: `${RUN}.feature_used`,
    source: SRC_API,
    expected: APP_NODE,
  },
  {
    label: "source + where eq matches",
    event: `${RUN}.charge`,
    source: SRC_BILLING,
    properties: { plan: "pro" },
    expected: BILLING_NODE,
  },
  {
    label: "source + where eq wrong value → null",
    event: `${RUN}.charge`,
    source: SRC_BILLING,
    properties: { plan: "free" },
    expected: null,
  },
  {
    label: "source + where eq missing property → null",
    event: `${RUN}.charge`,
    source: SRC_BILLING,
    expected: null,
  },
  {
    label: "source + where exists matches",
    event: `${RUN}.team_ping`,
    source: SRC_TEAM,
    properties: { teamId: "t1" },
    expected: TEAM_NODE,
  },
  {
    label: "source + where exists missing property → null",
    event: `${RUN}.team_ping`,
    source: SRC_TEAM,
    properties: {},
    expected: null,
  },
  {
    label: "source + where not_exists with property present → null",
    event: `${RUN}.guest_hit`,
    source: SRC_GUEST,
    properties: { teamId: "x" },
    expected: null,
  },
  {
    label: "source + where not_exists with property absent matches",
    event: `${RUN}.guest_hit`,
    source: SRC_GUEST,
    properties: { other: "y" },
    expected: GUEST_NODE,
  },
  {
    label: "source + where not_exists with NULL properties column matches",
    event: `${RUN}.guest_hit`,
    source: SRC_GUEST,
    properties: null,
    expected: GUEST_NODE,
  },
  {
    label: "source + where neq matches (plan != pro)",
    event: `${RUN}.neq_hit`,
    source: SRC_NEQ,
    properties: { plan: "free" },
    expected: NEQ_NODE,
  },
  {
    label: "source + where neq with missing property → null",
    event: `${RUN}.neq_hit`,
    source: SRC_NEQ,
    properties: {},
    expected: null,
  },
  {
    label: "source + where neq with the equal value → null",
    event: `${RUN}.neq_hit`,
    source: SRC_NEQ,
    properties: { plan: "pro" },
    expected: null,
  },
  {
    label: "source + where contains matches",
    event: `${RUN}.contains_hit`,
    source: SRC_CONTAINS,
    properties: { q: "hogsend" },
    expected: CONTAINS_NODE,
  },
  {
    label: "source + where contains no substring → null",
    event: `${RUN}.contains_hit`,
    source: SRC_CONTAINS,
    properties: { q: "resend" },
    expected: null,
  },
  {
    label: "eq against a NON-scalar property → null",
    event: `${RUN}.charge`,
    source: SRC_BILLING,
    properties: { plan: { x: 1 } },
    expected: null,
  },
  {
    label: "exists with a JSON-null value counts as present → team",
    event: `${RUN}.team_ping`,
    source: SRC_TEAM,
    properties: { teamId: null },
    expected: TEAM_NODE,
  },
  {
    label: "eq against a NUMERIC property (string-only law) → null",
    event: `${RUN}.num_hit`,
    source: SRC_NUM,
    properties: { n: 7 },
    expected: null,
  },
  {
    label: "eq against a STRING property matches",
    event: `${RUN}.num_hit`,
    source: SRC_NUM,
    properties: { n: "7" },
    expected: NUM_NODE,
  },
  {
    label: "valued event matching a surface → surface wins over revenue",
    event: `${RUN}.docs.bought`,
    source: "web",
    value: 50,
    expected: DOCS_NODE,
  },
  {
    label: "valued event matching no surface → revenue",
    event: `${RUN}.random_purchase`,
    source: "test",
    value: 25,
    expected: REVENUE_NODE,
  },
  {
    label: "journey stamp beats a matching surface prefix",
    event: `${RUN}.docs.opened`,
    source: "tracking",
    properties: { journeyId: JOURNEY_ID },
    expected: JOURNEY_NODE,
  },
  {
    label: "funnel trigger beats a matching surface prefix",
    event: FUNNEL_TRIGGER,
    source: "test",
    expected: FUNNEL_NODE,
  },
  {
    label: "unclassified event → null",
    event: `${RUN}.noise`,
    source: "test",
    expected: null,
  },
];

beforeAll(async () => {
  // Self-healing sweep: a run killed before afterAll strands rows that skew
  // later runs. Clear ALL sflow litter, not just this run's.
  await db.delete(contacts).where(like(contacts.externalId, "sflow-%"));
  await db.delete(journeyStates).where(like(journeyStates.userId, "sflow-%"));
  await db.delete(userEvents).where(like(userEvents.userId, "sflow-%"));
});

afterAll(async () => {
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}%`));
  await db.delete(journeyStates).where(like(journeyStates.userId, `${RUN}%`));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}%`));
});

describe("surface classification (TS)", () => {
  it.each(
    CASES.map((c, i) => [i, c] as const),
  )("case %i — %o", (_i, testCase) => {
    expect(
      flowTopology.classifyEvent({
        event: testCase.event,
        source: testCase.source,
        properties: testCase.properties,
        value: testCase.value ?? null,
      }),
    ).toBe(testCase.expected);
  });

  // Storage-faithful presence (TS-only inputs — JSON.stringify drops undefined
  // keys, so the P4 live path can hand us `{k: undefined}` that stores no key).
  it("treats an undefined-valued property as absent for exists", () => {
    expect(
      flowTopology.classifyEvent({
        event: `${RUN}.team_ping`,
        source: SRC_TEAM,
        properties: { teamId: undefined },
        value: null,
      }),
    ).toBeNull();
  });
  it("treats an undefined-valued property as absent for not_exists", () => {
    expect(
      flowTopology.classifyEvent({
        event: `${RUN}.guest_hit`,
        source: SRC_GUEST,
        properties: { teamId: undefined },
        value: null,
      }),
    ).toBe(GUEST_NODE);
  });

  it("registers each surface as a node with its declared tier and name", () => {
    const byId = new Map(flowTopology.nodes().map((n) => [n.id, n]));
    expect(byId.get(DOCS_NODE)).toMatchObject({
      kind: "surface",
      name: "Docs site",
      tier: "acquisition",
    });
    // Name defaults to the id when omitted.
    expect(byId.get(DOCS_API_NODE)).toMatchObject({
      kind: "surface",
      name: S.docsApi,
      tier: "acquisition",
    });
    expect(byId.get(BILLING_NODE)?.tier).toBe("revenue");
    expect(byId.get(TEAM_NODE)?.tier).toBe("retention");
  });
});

describe("define-time validation", () => {
  const ok = { tier: "acquisition" as const, match: { eventPrefix: "x." } };

  it("rejects the reserved id", () => {
    expect(() => defineSurface({ id: "revenue", ...ok })).toThrow(/reserved/);
  });
  it("rejects a colon in the id", () => {
    expect(() => defineSurface({ id: "a:b", ...ok })).toThrow(/whitespace|:/);
  });
  it("rejects whitespace in the id", () => {
    expect(() => defineSurface({ id: "a b", ...ok })).toThrow(/whitespace|:/);
  });
  it("rejects the journey/funnel namespaces", () => {
    expect(() => defineSurface({ id: "journeyX", ...ok })).toThrow(/journey/);
    expect(() => defineSurface({ id: "funnelY", ...ok })).toThrow(/funnel/);
  });
  it("rejects an unknown tier", () => {
    expect(() =>
      defineSurface({
        id: "a",
        // biome-ignore lint/suspicious/noExplicitAny: forcing a bad tier
        tier: "growth" as any,
        match: { eventPrefix: "x." },
      }),
    ).toThrow(/tier/);
  });
  it("rejects no match dimension", () => {
    expect(() =>
      defineSurface({ id: "a", tier: "acquisition", match: {} }),
    ).toThrow(/at least one/);
  });
  it("rejects empty arrays and empty members", () => {
    expect(() =>
      defineSurface({ id: "a", tier: "acquisition", match: { events: [] } }),
    ).toThrow(/empty/);
    expect(() =>
      defineSurface({ id: "a", tier: "acquisition", match: { events: [""] } }),
    ).toThrow(/empty/);
  });
  it("rejects a where eq without a value", () => {
    expect(() =>
      defineSurface({
        id: "a",
        tier: "acquisition",
        match: { where: [{ property: "p", operator: "eq" }] },
      }),
    ).toThrow(/value/);
  });
  it("rejects an unknown operator", () => {
    expect(() =>
      defineSurface({
        id: "a",
        tier: "acquisition",
        // biome-ignore lint/suspicious/noExplicitAny: forcing a bad operator
        match: { where: [{ property: "p", operator: "gte" as any }] },
      }),
    ).toThrow(/operator/);
  });
});

/**
 * THE load-bearing test — every row runs through TS and SQL, ids must match.
 */
describe("classifier parity (TS ↔ SQL)", () => {
  let sqlAnswers: Map<string, string | null>;

  beforeAll(async () => {
    const base = Date.now() - 60 * 60 * 1000;
    const inserted = await db
      .insert(userEvents)
      .values(
        CASES.map((c, i) => ({
          userId: `${RUN}-parity-${i}`,
          event: c.event,
          source: c.source,
          properties: c.properties ?? null,
          value: c.value ?? null,
          currency: c.value != null ? "USD" : null,
          occurredAt: new Date(base + i * 1000),
        })),
      )
      .returning({ id: userEvents.id, userId: userEvents.userId });

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
    // Both compilations must agree — AND both must equal the expected node.
    expect({ case: testCase.label, node: fromSql ?? null }).toEqual({
      case: testCase.label,
      node: ts,
    });
    expect(ts).toBe(testCase.expected);
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

describe("surface nodes + acquisition lanes (flow response)", () => {
  type Edge = {
    from: string;
    to: string;
    transitions: number;
    contacts: number;
    lanes: Record<string, number> | null;
  };
  type Flow = {
    nodes: {
      id: string;
      kind: string;
      name: string;
      tier: string;
      contacts: number;
      events: number;
    }[];
    edges: Edge[];
    lanes: { id: string; count: number }[];
  };

  const SPRING = `${RUN}-spring`;
  const SUMMER = `${RUN}-summer`;
  const DOCS_EVENT = `${RUN}.docs.opened`;
  const APP_EVENT = `${RUN}.feature_used`;

  let withLanes: Flow;
  let noLanes: Flow;

  beforeAll(async () => {
    const base = Date.now() - 2 * 60 * 60 * 1000;
    const at = (step: number) => new Date(base + step * 1000);

    // Each walker: campaign.arrived (sets the lane) → a docs event → an app
    // event. campaign.arrived is unclassified (no node) but seeds first-touch.
    // `campaign === null` = no campaign.arrived row; a string (INCLUDING "" and
    // "  ") = a campaign.arrived carrying that utm_campaign.
    const walk = (
      userId: string,
      campaign: string | null,
    ): (typeof userEvents.$inferInsert)[] => [
      ...(campaign !== null
        ? [
            {
              userId,
              event: "campaign.arrived",
              source: "web",
              properties: { utm_campaign: campaign },
              occurredAt: at(0),
            },
          ]
        : []),
      { userId, event: DOCS_EVENT, source: "web", occurredAt: at(1) },
      { userId, event: APP_EVENT, source: SRC_API, occurredAt: at(2) },
    ];

    const rows: (typeof userEvents.$inferInsert)[] = [
      ...walk(`${RUN}-w-spring1`, SPRING),
      ...walk(`${RUN}-w-spring2`, SPRING),
      ...walk(`${RUN}-w-summer`, SUMMER),
      ...walk(`${RUN}-w-organic`, null),
      // Empty + whitespace-only utm must fold into organic (no `""` lane).
      ...walk(`${RUN}-w-empty`, ""),
      ...walk(`${RUN}-w-ws`, "  "),
      // Noise nobody claims — must NOT become a node.
      {
        userId: `${RUN}-w-noise`,
        event: `${RUN}.noise`,
        source: "test",
        occurredAt: at(0),
      },
    ];
    await db.insert(userEvents).values(rows);

    const fetchFlow = async (query: string): Promise<Flow> => {
      const res = await app.request(`/v1/admin/flow?${query}`, {
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(200);
      return (await res.json()) as Flow;
    };
    withLanes = await fetchFlow(
      "windowDays=7&mode=curated&laneBy=utm_campaign",
    );
    noLanes = await fetchFlow("windowDays=7&mode=curated");
  });

  const nodeOf = (flow: Flow, id: string) =>
    flow.nodes.find((n) => n.id === id);
  const edgeOf = (flow: Flow, from: string, to: string) =>
    flow.edges.find((e) => e.from === from && e.to === to);

  it("renders surface nodes with declared tier/name and real traffic", () => {
    // 6 walkers (2 spring, 1 summer, 1 organic, 1 empty-utm, 1 whitespace-utm).
    expect(nodeOf(withLanes, DOCS_NODE)).toMatchObject({
      kind: "surface",
      name: "Docs site",
      tier: "acquisition",
      contacts: 6,
      events: 6,
    });
    expect(nodeOf(withLanes, APP_NODE)).toMatchObject({
      kind: "surface",
      tier: "activation",
      contacts: 6,
    });
  });

  it("drops unclassified events instead of inventing a node", () => {
    expect(withLanes.nodes.some((n) => n.id.includes(`${RUN}.noise`))).toBe(
      false,
    );
  });

  it("breaks each edge down by lane, folding empty/whitespace utm to organic", () => {
    const edge = edgeOf(withLanes, DOCS_NODE, APP_NODE);
    // organic pools the un-attributed walker + the empty + the whitespace one.
    expect(edge?.transitions).toBe(6);
    expect(edge?.lanes).toEqual({ [SPRING]: 2, [SUMMER]: 1, organic: 3 });
  });

  it("orders per-edge lane keys deterministically (count desc, id asc)", () => {
    const edge = edgeOf(withLanes, DOCS_NODE, APP_NODE);
    // organic (3) first, then spring (2), then summer (1).
    expect(Object.keys(edge?.lanes ?? {})).toEqual(["organic", SPRING, SUMMER]);
  });

  it("summarizes lanes by distinct contact, with no empty/whitespace lane", () => {
    const laneOf = (id: string) => withLanes.lanes.find((l) => l.id === id);
    expect(laneOf(SPRING)?.count).toBe(2);
    expect(laneOf(SUMMER)?.count).toBe(1);
    // organic pools this run's un-attributed + empty + whitespace walkers with
    // any other suite's — present, not asserted exact.
    expect(laneOf("organic")?.count ?? 0).toBeGreaterThanOrEqual(3);
    // The empty / whitespace-only utm never mint a lane id.
    expect(withLanes.lanes.some((l) => l.id === "")).toBe(false);
    expect(withLanes.lanes.some((l) => l.id.trim() === "")).toBe(false);
  });

  it("leaves lanes off entirely without laneBy", () => {
    expect(noLanes.lanes).toEqual([]);
    expect(edgeOf(noLanes, DOCS_NODE, APP_NODE)?.lanes).toBeNull();
  });
});
