/**
 * /lift regression pin + the reconciled journey-lift helpers (impact
 * experiments phase 2a — spec D4.1–D4.3).
 *
 * The pin block asserts the PRE-refactor /lift wire shape and cohort math;
 * the Task-3 handler edit must keep every assertion green. The ONLY
 * tolerated change is the ADDED definitionSource field (asserted in its own
 * describe block) — which is why the pin uses toMatchObject, never toEqual,
 * on the response body.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// defineJourney calls hatchet.durableTask at define time; mock the broker
// module (the journey-holdout.test.ts pattern) so no live Hatchet is needed.
const { hatchetMock } = vi.hoisted(() => {
  const factory = () => ({
    hatchet: {
      durableTask: vi.fn(() => ({
        run: vi.fn(),
        runNoWait: vi.fn(),
        runAndWait: vi.fn(),
      })),
      task: vi.fn(() => ({
        run: vi.fn(),
        runNoWait: vi.fn(async () => ({})),
      })),
      events: { push: vi.fn(async () => {}) },
      runs: { cancel: vi.fn(), get: vi.fn() },
      worker: vi.fn(),
    },
  });
  return { hatchetMock: factory };
});
vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

const { contacts, conversions, journeyStates, userEvents } = await import(
  "@hogsend/db"
);
const { like } = await import("drizzle-orm");
const {
  computeJourneyLift,
  computeLift,
  computeLiftValues,
  createApp,
  createHogsendClient,
  defineJourney,
} = await import("@hogsend/engine");

const RUN = `lift2a-${Date.now()}`;
const J_NONE = `${RUN}-none`;
const J_GOAL = `${RUN}-goal`;
const J_EXCL = `${RUN}-excl`;
const DEF_OTHER = `${RUN}-other`;
const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

const DAY = 24 * 60 * 60 * 1000;
/** Entry instant for every route-fixture state row (inside days=30). */
const BASE = new Date(Date.now() - 10 * DAY);

const jNone = defineJourney({
  meta: {
    id: J_NONE,
    name: "Lift pin (no goal)",
    enabled: true,
    trigger: { event: `${RUN}.none.enroll` },
    entryLimit: "once",
    suppress: { hours: 0 },
  },
  run: async () => {},
});

const jGoal = defineJourney({
  meta: {
    id: J_GOAL,
    name: "Lift pin (goal: revenue)",
    enabled: true,
    trigger: { event: `${RUN}.goal.enroll` },
    entryLimit: "once",
    suppress: { hours: 0 },
    goal: "revenue",
  },
  run: async () => {},
});

const jExcluded = defineJourney({
  meta: {
    id: J_EXCL,
    name: "Lift pin (goal, ENABLED_JOURNEYS-excluded)",
    enabled: true,
    trigger: { event: `${RUN}.excl.enroll` },
    entryLimit: "once",
    suppress: { hours: 0 },
    goal: "revenue",
  },
  run: async () => {},
});

// 1c boot validation runs over these journeys: goal "revenue" must match
// the seeded zero-config revenue conversion (it does — regression-guarded
// by this container simply booting).
const container = createHogsendClient({ journeys: [jNone, jGoal] });
const app = createApp(container);
const { db } = container;

let contactId: string;

async function seedState(opts: {
  journeyId: string;
  userId: string;
  status: "completed" | "held_out";
  createdAt: Date;
}) {
  await db.insert(journeyStates).values({
    journeyId: opts.journeyId,
    userId: opts.userId,
    userEmail: `${opts.userId}@example.com`,
    currentNodeId: "entry",
    status: opts.status,
    createdAt: opts.createdAt,
  });
}

async function seedConversion(opts: {
  userKey: string;
  definitionId: string;
  value: number;
  currency: string;
  occurredAt: Date;
}) {
  const [event] = await db
    .insert(userEvents)
    .values({
      userId: opts.userKey,
      event: "test.lift.convert",
      properties: {},
      source: "test",
    })
    .returning({ id: userEvents.id });
  await db.insert(conversions).values({
    definitionId: opts.definitionId,
    contactId,
    userKey: opts.userKey,
    eventId: event?.id as string,
    value: opts.value,
    currency: opts.currency,
    occurredAt: opts.occurredAt,
  });
}

/** Per-currency arrays come from an unordered GROUP BY — sort to compare. */
function byCurrency(v: Array<{ currency: string | null; value: number }>) {
  return [...v].sort((a, b) =>
    String(a.currency).localeCompare(String(b.currency)),
  );
}

beforeAll(async () => {
  const [contact] = await db
    .insert(contacts)
    .values({ email: `${RUN}@example.com`, externalId: `${RUN}-contact` })
    .returning({ id: contacts.id });
  contactId = contact?.id as string;

  const day = (n: number) => new Date(BASE.getTime() + n * DAY);

  // J_NONE — 4 treatment, 2 held_out, all entered at BASE.
  for (const u of ["t1", "t2", "t3", "t4"]) {
    await seedState({
      journeyId: J_NONE,
      userId: `${RUN}-${u}`,
      status: "completed",
      createdAt: BASE,
    });
  }
  for (const u of ["c1", "c2"]) {
    await seedState({
      journeyId: J_NONE,
      userId: `${RUN}-${u}`,
      status: "held_out",
      createdAt: BASE,
    });
  }
  // t1/t2: revenue converters. t3: other-definition converter (counts under
  // "any", drops under definitionId=revenue). t4: revenue conversion BEFORE
  // entry — the ITT clock must exclude it from counts AND values.
  await seedConversion({
    userKey: `${RUN}-t1`,
    definitionId: "revenue",
    value: 100,
    currency: "GBP",
    occurredAt: day(1),
  });
  await seedConversion({
    userKey: `${RUN}-t2`,
    definitionId: "revenue",
    value: 50,
    currency: "USD",
    occurredAt: day(2),
  });
  await seedConversion({
    userKey: `${RUN}-t3`,
    definitionId: DEF_OTHER,
    value: 30,
    currency: "GBP",
    occurredAt: day(1),
  });
  await seedConversion({
    userKey: `${RUN}-t4`,
    definitionId: "revenue",
    value: 75,
    currency: "GBP",
    occurredAt: day(-1),
  });
  await seedConversion({
    userKey: `${RUN}-c1`,
    definitionId: "revenue",
    value: 20,
    currency: "GBP",
    occurredAt: day(1),
  });

  // J_GOAL — 3 treatment, 1 held_out. g1 converts on the goal (revenue),
  // g2 on the other definition (visible only via explicit query param).
  for (const u of ["g1", "g2", "g3"]) {
    await seedState({
      journeyId: J_GOAL,
      userId: `${RUN}-${u}`,
      status: "completed",
      createdAt: BASE,
    });
  }
  await seedState({
    journeyId: J_GOAL,
    userId: `${RUN}-gc1`,
    status: "held_out",
    createdAt: BASE,
  });
  await seedConversion({
    userKey: `${RUN}-g1`,
    definitionId: "revenue",
    value: 10,
    currency: "GBP",
    occurredAt: day(1),
  });
  await seedConversion({
    userKey: `${RUN}-g2`,
    definitionId: DEF_OTHER,
    value: 99,
    currency: "USD",
    occurredAt: day(1),
  });

  // J_EXCL — 1 treatment with ONLY an other-definition conversion: if the
  // excluded journey's declared goal ("revenue") were wrongly applied, its
  // converter count would read 0; under "any definition" it reads 1.
  await seedState({
    journeyId: J_EXCL,
    userId: `${RUN}-e1`,
    status: "completed",
    createdAt: BASE,
  });
  await seedConversion({
    userKey: `${RUN}-e1`,
    definitionId: DEF_OTHER,
    value: 5,
    currency: "GBP",
    occurredAt: day(1),
  });
});

afterAll(async () => {
  await db.delete(conversions).where(like(conversions.userKey, `${RUN}-%`));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  await db
    .delete(journeyStates)
    .where(like(journeyStates.journeyId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}-%`));
});

describe("/lift regression pin (wire shape frozen across the 2a refactor)", () => {
  it("any-definition scope: counts, ITT clock, per-currency values, flat verdict", async () => {
    const res = await app.request(`/v1/admin/journeys/${J_NONE}/lift?days=30`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      journeyId: string;
      days: number;
      definitionId: string | null;
      treatment: {
        contacts: number;
        converters: number;
        rate: number;
        value: Array<{ currency: string | null; value: number }>;
      };
      control: {
        contacts: number;
        converters: number;
        rate: number;
        value: Array<{ currency: string | null; value: number }>;
      };
      liftPercent: number | null;
      winProbability: number | null;
      suppressed: boolean;
      smallSample: boolean;
    };
    expect(body).toMatchObject({
      journeyId: J_NONE,
      days: 30,
      definitionId: null,
      treatment: { contacts: 4, converters: 3, rate: 0.75 },
      control: { contacts: 2, converters: 1, rate: 0.5 },
      // 3+1 combined conversions < 10 → suppressed; both cohorts < 100.
      winProbability: null,
      suppressed: true,
      smallSample: true,
    });
    expect(body.liftPercent).toBeCloseTo(50, 6);
    // t1 £100 + t3 £30 (t4's pre-entry £75 excluded by the ITT clock).
    expect(byCurrency(body.treatment.value)).toEqual([
      { currency: "GBP", value: 130 },
      { currency: "USD", value: 50 },
    ]);
    expect(body.control.value).toEqual([{ currency: "GBP", value: 20 }]);
  });

  it("explicit definitionId narrows converters and values", async () => {
    const res = await app.request(
      `/v1/admin/journeys/${J_NONE}/lift?days=30&definitionId=revenue`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      definitionId: string | null;
      treatment: {
        contacts: number;
        converters: number;
        rate: number;
        value: Array<{ currency: string | null; value: number }>;
      };
      control: {
        converters: number;
        rate: number;
        value: Array<{ currency: string | null; value: number }>;
      };
      liftPercent: number | null;
      suppressed: boolean;
    };
    expect(body).toMatchObject({
      definitionId: "revenue",
      treatment: { contacts: 4, converters: 2, rate: 0.5 },
      control: { converters: 1, rate: 0.5 },
      suppressed: true,
    });
    expect(body.liftPercent).toBeCloseTo(0, 6);
    expect(byCurrency(body.treatment.value)).toEqual([
      { currency: "GBP", value: 100 },
      { currency: "USD", value: 50 },
    ]);
    expect(body.control.value).toEqual([{ currency: "GBP", value: 20 }]);
  });
});

describe("computeJourneyLift / computeLiftValues (D4.1 contract)", () => {
  const J_ASOF = `${RUN}-asof`;
  const SINCE = new Date(Date.now() - 20 * DAY);
  const ASOF = new Date(Date.now() - 5 * DAY);
  const at = (n: number) => new Date(ASOF.getTime() + n * DAY);

  beforeAll(async () => {
    // Treatment rows created 2 days before the asOf snapshot...
    for (const u of ["a", "b", "f", "g"]) {
      await seedState({
        journeyId: J_ASOF,
        userId: `${RUN}-${u}`,
        status: "completed",
        createdAt: at(-2),
      });
    }
    // ...one created EXACTLY at asOf (strict `<` must exclude it)...
    await seedState({
      journeyId: J_ASOF,
      userId: `${RUN}-c`,
      status: "completed",
      createdAt: ASOF,
    });
    // ...one created before `since` (always excluded)...
    await seedState({
      journeyId: J_ASOF,
      userId: `${RUN}-d`,
      status: "completed",
      createdAt: new Date(SINCE.getTime() - DAY),
    });
    // ...and one held_out control.
    await seedState({
      journeyId: J_ASOF,
      userId: `${RUN}-h`,
      status: "held_out",
      createdAt: at(-2),
    });

    // a: converts before asOf (counts). b: converts AFTER asOf (counts only
    // under the default asOf=now). f: other-definition converter (drops
    // under definitionId="revenue"). g: converts EXACTLY at asOf
    // (inclusive `<=` must count it). d: in-window conversion but the state
    // row predates `since` (never counts). h: control converter.
    await seedConversion({
      userKey: `${RUN}-a`,
      definitionId: "revenue",
      value: 10,
      currency: "GBP",
      occurredAt: at(-1),
    });
    await seedConversion({
      userKey: `${RUN}-b`,
      definitionId: "revenue",
      value: 6,
      currency: "GBP",
      occurredAt: at(1),
    });
    await seedConversion({
      userKey: `${RUN}-f`,
      definitionId: `${RUN}-nolift`,
      value: 4,
      currency: "USD",
      occurredAt: at(-1),
    });
    await seedConversion({
      userKey: `${RUN}-g`,
      definitionId: "revenue",
      value: 8,
      currency: "GBP",
      occurredAt: ASOF,
    });
    await seedConversion({
      userKey: `${RUN}-d`,
      definitionId: "revenue",
      value: 99,
      currency: "GBP",
      occurredAt: at(-1),
    });
    await seedConversion({
      userKey: `${RUN}-h`,
      definitionId: "revenue",
      value: 7,
      currency: "GBP",
      occurredAt: at(-1),
    });
  });

  it("snapshots at asOf: created_at < asOf (strict), occurred_at <= asOf (inclusive)", async () => {
    const res = await computeJourneyLift({
      db,
      journeyId: J_ASOF,
      since: SINCE,
      asOf: ASOF,
    });
    // a, b, f, g in the cohort (c excluded by strict <, d by since);
    // converters a, f, g (b's conversion is after asOf; g's is AT asOf).
    expect(res.treatment).toEqual({ contacts: 4, converters: 3, rate: 0.75 });
    expect(res.control).toEqual({ contacts: 1, converters: 1, rate: 1 });
    // The nested verdict IS computeLift of the counts — no drift allowed.
    expect(res.verdict).toEqual(
      computeLift({
        treatment: { contacts: 4, converters: 3 },
        control: { contacts: 1, converters: 1 },
      }),
    );
  });

  it("defaults asOf to now — both bounds are no-ops over historical rows", async () => {
    const res = await computeJourneyLift({
      db,
      journeyId: J_ASOF,
      since: SINCE,
    });
    // c joins the cohort; b becomes a converter.
    expect(res.treatment).toEqual({ contacts: 5, converters: 4, rate: 0.8 });
    expect(res.control).toEqual({ contacts: 1, converters: 1, rate: 1 });
  });

  it("narrows converters by definitionId (counts cohort unchanged)", async () => {
    const res = await computeJourneyLift({
      db,
      journeyId: J_ASOF,
      since: SINCE,
      asOf: ASOF,
      definitionId: "revenue",
    });
    expect(res.treatment).toEqual({ contacts: 4, converters: 2, rate: 0.5 });
    expect(res.control).toEqual({ contacts: 1, converters: 1, rate: 1 });
  });

  it("computeLiftValues honors since/asOf/definitionId and the ITT clock per currency", async () => {
    const atAsOf = await computeLiftValues({
      db,
      journeyId: J_ASOF,
      since: SINCE,
      asOf: ASOF,
    });
    // GBP: a £10 + g £8 (b's £6 is after asOf; d's £99 fails the since
    // bound on the state row). USD: f's other-definition $4.
    expect(byCurrency(atAsOf.treatment)).toEqual([
      { currency: "GBP", value: 18 },
      { currency: "USD", value: 4 },
    ]);
    expect(atAsOf.control).toEqual([{ currency: "GBP", value: 7 }]);

    const revenueOnly = await computeLiftValues({
      db,
      journeyId: J_ASOF,
      since: SINCE,
      asOf: ASOF,
      definitionId: "revenue",
    });
    expect(revenueOnly.treatment).toEqual([{ currency: "GBP", value: 18 }]);
    expect(revenueOnly.control).toEqual([{ currency: "GBP", value: 7 }]);

    const nowScoped = await computeLiftValues({
      db,
      journeyId: J_ASOF,
      since: SINCE,
    });
    expect(byCurrency(nowScoped.treatment)).toEqual([
      { currency: "GBP", value: 24 },
      { currency: "USD", value: 4 },
    ]);
  });
});

describe("goal-resolution ladder + definitionSource (D4.3)", () => {
  it("no goal, no query → source 'none', null definitionId, any-definition scope", async () => {
    const res = await app.request(`/v1/admin/journeys/${J_NONE}/lift?days=30`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.definitionSource).toBe("none");
    expect(body.definitionId).toBeNull();
  });

  it("explicit query param → source 'query', echoing the effective id", async () => {
    const res = await app.request(
      `/v1/admin/journeys/${J_NONE}/lift?days=30&definitionId=revenue`,
      { headers: AUTH_HEADER },
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.definitionSource).toBe("query");
    expect(body.definitionId).toBe("revenue");
  });

  it("meta.goal defaults the definition → source 'goal', converters narrowed to the goal", async () => {
    const res = await app.request(`/v1/admin/journeys/${J_GOAL}/lift?days=30`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      definitionId: string | null;
      definitionSource: string;
      treatment: {
        contacts: number;
        converters: number;
        rate: number;
        value: Array<{ currency: string | null; value: number }>;
      };
      control: { contacts: number; converters: number; rate: number };
      liftPercent: number | null;
      winProbability: number | null;
      suppressed: boolean;
      smallSample: boolean;
    };
    expect(body).toMatchObject({
      definitionId: "revenue",
      definitionSource: "goal",
      // g1 only — g2's other-definition conversion is outside the goal.
      treatment: { contacts: 3, converters: 1 },
      control: { contacts: 1, converters: 0, rate: 0 },
      // Control converts at 0% → liftPercent null; 1 combined conversion
      // < 10 → suppressed, winProbability null.
      liftPercent: null,
      winProbability: null,
      suppressed: true,
      smallSample: true,
    });
    expect(body.treatment.rate).toBeCloseTo(1 / 3, 10);
    expect(body.treatment.value).toEqual([{ currency: "GBP", value: 10 }]);
  });

  it("query param beats meta.goal", async () => {
    const res = await app.request(
      `/v1/admin/journeys/${J_GOAL}/lift?days=30&definitionId=${DEF_OTHER}`,
      { headers: AUTH_HEADER },
    );
    const body = (await res.json()) as {
      definitionId: string | null;
      definitionSource: string;
      treatment: {
        converters: number;
        value: Array<{ currency: string | null; value: number }>;
      };
    };
    expect(body).toMatchObject({
      definitionId: DEF_OTHER,
      definitionSource: "query",
      treatment: { converters: 1 },
    });
    expect(body.treatment.value).toEqual([{ currency: "USD", value: 99 }]);
  });

  it("never 404s: unknown journey id → zero cohorts, source 'none'", async () => {
    const res = await app.request(
      `/v1/admin/journeys/${RUN}-ghost/lift?days=30`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      definitionId: null,
      definitionSource: "none",
      treatment: { contacts: 0, converters: 0 },
      control: { contacts: 0, converters: 0 },
    });
  });
});

describe("ENABLED_JOURNEYS-excluded journey falls to source 'none' (D3 asymmetry)", () => {
  // Real exclusion path: J_EXCL is DEFINED (and 1c boot-validates its goal)
  // but the csv only enables J_GOAL, so J_EXCL never registers and its
  // declared goal must NOT scope the readout.
  const containerExcl = createHogsendClient({
    journeys: [jGoal, jExcluded],
    enabledJourneys: J_GOAL,
  });
  const appExcl = createApp(containerExcl);

  it("excluded journey: declared goal NOT applied — any-definition scope, source 'none'", async () => {
    const res = await appExcl.request(
      `/v1/admin/journeys/${J_EXCL}/lift?days=30`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      definitionId: null,
      definitionSource: "none",
      // e1's ONLY conversion is on the other definition: counting it
      // proves the excluded journey's goal ("revenue") was not applied.
      treatment: { contacts: 1, converters: 1 },
    });
  });

  it("the registered journey on the same app still resolves source 'goal'", async () => {
    const res = await appExcl.request(
      `/v1/admin/journeys/${J_GOAL}/lift?days=30`,
      { headers: AUTH_HEADER },
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.definitionSource).toBe("goal");
    expect(body.definitionId).toBe("revenue");
  });
});
