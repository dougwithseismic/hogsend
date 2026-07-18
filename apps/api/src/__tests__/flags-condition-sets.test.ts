import { createHash } from "node:crypto";
import type { HogsendClient } from "@hogsend/engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const {
  evaluateFlag,
  evaluateFlagsForContact,
  loadTargetingSnapshot,
  emptySnapshot,
  flagBucket,
} = await import("@hogsend/engine");

import type { EvaluableFlag, TargetingSnapshot } from "@hogsend/engine";

const {
  apiKeys,
  bucketMemberships,
  contacts,
  deals,
  emailSends,
  flags,
  journeyStates,
  userEvents,
} = await import("@hogsend/db");
const { eq, inArray } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");

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
const app = createApp(container);
const { db } = container;

function boolFlag(overrides: Partial<EvaluableFlag> = {}): EvaluableFlag {
  return {
    key: "cs-flag",
    enabled: true,
    type: "boolean",
    variants: [],
    defaultValue: false,
    targeting: [],
    rollout: 100,
    conditionSets: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PURE unit tests: condition-set ordering + per-set rollout + leaves.
// ---------------------------------------------------------------------------
describe("evaluateFlag — condition sets (pure)", () => {
  it("first MATCHING set wins; a targeting-true but rollout-0 set is NOT a match", () => {
    // set0: everyone but rollout 0 → never a match. set1: everyone rollout 100.
    const flag = boolFlag({
      conditionSets: [
        { targeting: [], rollout: 0 },
        { targeting: [], rollout: 100 },
      ],
    });
    // Falls through set0 (rollout 0) to set1 (rollout 100) → ON.
    for (const key of ["a", "b", "c", "d"]) {
      expect(evaluateFlag(flag, { contactKey: key, properties: {} })).toBe(
        true,
      );
    }
  });

  it("stops at the first set whose targeting matches AND rollout admits", () => {
    // set0 targets plan=pro at 100%; set1 everyone at 0%.
    const flag = boolFlag({
      conditionSets: [
        {
          targeting: {
            type: "property",
            property: "plan",
            operator: "eq",
            value: "pro",
          },
          rollout: 100,
        },
        { targeting: [], rollout: 0 },
      ],
    });
    // pro → set0 matches → ON.
    expect(
      evaluateFlag(flag, { contactKey: "u", properties: { plan: "pro" } }),
    ).toBe(true);
    // free → set0 targeting fails, set1 rollout 0 → no match → default.
    expect(
      evaluateFlag(flag, { contactKey: "u", properties: { plan: "free" } }),
    ).toBe(false);
  });

  it("a set at 0% never matches; a set at 100% always matches given targeting", () => {
    const zero = boolFlag({ conditionSets: [{ targeting: [], rollout: 0 }] });
    const full = boolFlag({ conditionSets: [{ targeting: [], rollout: 100 }] });
    for (let i = 0; i < 200; i++) {
      expect(evaluateFlag(zero, { contactKey: `k${i}`, properties: {} })).toBe(
        false,
      );
      expect(evaluateFlag(full, { contactKey: `k${i}`, properties: {} })).toBe(
        true,
      );
    }
  });

  it("empty conditionSets → one everyone-set at the flag's rollout (back-compat)", () => {
    const full = boolFlag({ conditionSets: [], rollout: 100 });
    const none = boolFlag({ conditionSets: [], rollout: 0 });
    expect(evaluateFlag(full, { contactKey: "x", properties: {} })).toBe(true);
    expect(evaluateFlag(none, { contactKey: "x", properties: {} })).toBe(false);
  });

  it("null conditionSets still evaluates via legacy targeting+rollout", () => {
    const flag = boolFlag({
      conditionSets: null,
      targeting: [
        { type: "property", property: "plan", operator: "eq", value: "pro" },
      ],
      rollout: 100,
    });
    expect(
      evaluateFlag(flag, { contactKey: "u", properties: { plan: "pro" } }),
    ).toBe(true);
    expect(
      evaluateFlag(flag, { contactKey: "u", properties: { plan: "free" } }),
    ).toBe(false);
  });

  it("bucket / journey / deal leaves resolve from the snapshot (± negate)", () => {
    const snapshot: TargetingSnapshot = {
      properties: {},
      email: null,
      buckets: new Set(["beta"]),
      journeys: new Map([
        ["onboarding", { active: false, completed: true }],
        ["dunning", { active: true, completed: false }],
      ]),
      deals: { won: true, open: false, stage: "sold" },
    };
    const check = (targeting: EvaluableFlag["targeting"]) =>
      evaluateFlag(boolFlag({ targeting }), {
        contactKey: "u",
        properties: {},
        snapshot,
      });

    expect(check({ type: "bucket", bucketId: "beta" })).toBe(true);
    expect(check({ type: "bucket", bucketId: "gamma" })).toBe(false);
    expect(check({ type: "bucket", bucketId: "beta", negate: true })).toBe(
      false,
    );
    expect(
      check({ type: "journey", journeyId: "onboarding", state: "completed" }),
    ).toBe(true);
    expect(
      check({ type: "journey", journeyId: "onboarding", state: "active" }),
    ).toBe(false);
    expect(
      check({ type: "journey", journeyId: "dunning", state: "active" }),
    ).toBe(true);
    expect(check({ type: "deal", predicate: "won" })).toBe(true);
    expect(check({ type: "deal", predicate: "open" })).toBe(false);
    expect(check({ type: "deal", predicate: "stage", stage: "sold" })).toBe(
      true,
    );
    expect(check({ type: "deal", predicate: "stage", stage: "quoted" })).toBe(
      false,
    );
  });

  it("legacy (null conditionSets) rollout stays bucketed on the BARE key — sticky across the Phase-2 upgrade", () => {
    // The synthesized single set (index 0) MUST key its rollout bucket on the
    // pre-Phase-2 `${contactKey}:${flagKey}` — NOT `...:0`. Otherwise every
    // existing partial-rollout flag re-randomizes its audience on deploy. This
    // golden test pins evaluateFlag to the exact legacy bucket for a specific
    // contact + flag at rollout 30, so a regression to the `:0` key is caught.
    const flag = boolFlag({ key: "sticky-golden", conditionSets: null });
    for (const contactKey of ["u1", "u2", "u3", "alice@x.com", "anon-42"]) {
      const legacyBucket = flagBucket(`${contactKey}:${flag.key}`);
      for (const rollout of [0, 10, 30, 50, 70, 100]) {
        const expected = legacyBucket < rollout;
        expect(
          evaluateFlag({ ...flag, rollout }, { contactKey, properties: {} }),
        ).toBe(expected);
      }
    }
  });

  it("multi-set rollout: set 0 uses the bare key, later sets use `:i` (independent dice)", () => {
    // set0 targets everyone but is keyed on the bare key; set1 targets everyone
    // keyed on `:1`. A contact that FAILS set0's rollout can still PASS set1's.
    const contactKey = "multi-user";
    const flagKey = "multi-golden";
    const set0Bucket = flagBucket(`${contactKey}:${flagKey}`);
    const set1Bucket = flagBucket(`${contactKey}:${flagKey}:1`);
    // Choose rollouts so set0 fails and set1 admits (independent buckets).
    const set0Rollout = Math.max(0, Math.floor(set0Bucket)); // bucket >= rollout
    const set1Rollout = Math.min(100, Math.ceil(set1Bucket) + 1); // bucket < rollout
    const flag = boolFlag({
      key: flagKey,
      conditionSets: [
        { targeting: [], rollout: set0Rollout },
        { targeting: [], rollout: set1Rollout },
      ],
    });
    expect(set0Bucket >= set0Rollout).toBe(true);
    expect(set1Bucket < set1Rollout).toBe(true);
    expect(evaluateFlag(flag, { contactKey, properties: {} })).toBe(true);
  });

  it("event / email_engagement leaves are FALSE in the browser-pure evaluator", () => {
    const flag = boolFlag({
      targeting: { type: "event", eventName: "purchased", check: "exists" },
    });
    expect(
      evaluateFlag(flag, {
        contactKey: "u",
        properties: {},
        snapshot: emptySnapshot(),
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// INTEGRATION: snapshot loading + browser vs server mode + O(1) query count.
// ---------------------------------------------------------------------------
const RUN = `cs-${Date.now()}`;
const USER = `${RUN}-user`;
const BUCKET_ID = `${RUN}-beta`;
const JOURNEY_ID = `${RUN}-onboarding`;
const flagKeys = [
  `${RUN}-bucket`,
  `${RUN}-journey`,
  `${RUN}-deal`,
  `${RUN}-event`,
  `${RUN}-count-a`,
  `${RUN}-count-b`,
  `${RUN}-count-c`,
  `${RUN}-count-d`,
  `${RUN}-engagement`,
];
// The contact's REAL email — `email_engagement` leaves must key `email_sends`
// on this, NOT on `USER` (the contactKey), which is never an address.
const CONTACT_EMAIL = `${RUN}-real@example.com`;
const WELCOME_TEMPLATE = `${RUN}-welcome`;
const SECRET_KEY = `sk_${RUN}_ingest`;
let contactId = "";
let secretId = "";

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

const AUTH_SECRET = { Authorization: `Bearer ${SECRET_KEY}` };

async function seedFlag(
  key: string,
  targeting: EvaluableFlag["targeting"],
): Promise<void> {
  await db.insert(flags).values({
    key,
    name: key,
    type: "boolean",
    defaultValue: false,
    rollout: 100,
    targeting: targeting as never,
    conditionSets: [{ targeting, rollout: 100 }] as never,
  });
}

beforeAll(async () => {
  const [sk] = await db
    .insert(apiKeys)
    .values({
      name: "cs secret",
      keyPrefix: SECRET_KEY.slice(0, 8),
      keyHash: hashKey(SECRET_KEY),
      scopes: ["ingest"],
    })
    .returning({ id: apiKeys.id });
  secretId = sk?.id ?? "";

  const [contact] = await db
    .insert(contacts)
    .values({ externalId: USER, email: CONTACT_EMAIL, properties: {} })
    .returning({ id: contacts.id });
  contactId = contact?.id ?? "";

  // An OPENED welcome send addressed to the contact's real email — the
  // `email_engagement` leaf must resolve it via that address, not the contactKey.
  await db.insert(emailSends).values({
    fromEmail: "hello@hogsend.com",
    toEmail: CONTACT_EMAIL,
    subject: "Welcome",
    templateKey: WELCOME_TEMPLATE,
    status: "sent",
    openedAt: new Date(),
  });

  await db.insert(bucketMemberships).values({
    userId: USER,
    bucketId: BUCKET_ID,
    status: "active",
  });
  await db.insert(journeyStates).values({
    userId: USER,
    userEmail: `${USER}@example.com`,
    journeyId: JOURNEY_ID,
    currentNodeId: "done",
    status: "completed",
  });
  await db.insert(deals).values({
    provider: "test",
    externalId: `${RUN}-deal-1`,
    contactId,
    canonicalStage: "sold",
    stageRank: 5,
    soldAt: new Date(),
  });
  await db.insert(userEvents).values({ userId: USER, event: "purchased" });

  await seedFlag(`${RUN}-bucket`, { type: "bucket", bucketId: BUCKET_ID });
  await seedFlag(`${RUN}-journey`, {
    type: "journey",
    journeyId: JOURNEY_ID,
    state: "completed",
  });
  await seedFlag(`${RUN}-deal`, { type: "deal", predicate: "won" });
  await seedFlag(`${RUN}-event`, {
    type: "event",
    eventName: "purchased",
    check: "exists",
  });
  await seedFlag(`${RUN}-engagement`, {
    type: "email_engagement",
    templateKey: WELCOME_TEMPLATE,
    check: "opened",
  });
});

afterAll(async () => {
  await db.delete(flags).where(inArray(flags.key, flagKeys));
  await db.delete(emailSends).where(eq(emailSends.toEmail, CONTACT_EMAIL));
  await db.delete(userEvents).where(eq(userEvents.userId, USER));
  await db.delete(bucketMemberships).where(eq(bucketMemberships.userId, USER));
  await db.delete(journeyStates).where(eq(journeyStates.userId, USER));
  if (contactId) await db.delete(deals).where(eq(deals.contactId, contactId));
  await db.delete(contacts).where(eq(contacts.externalId, USER));
  if (secretId) await db.delete(apiKeys).where(eq(apiKeys.id, secretId));
});

describe("flags condition sets — snapshot leaves over HTTP", () => {
  it("GET /v1/flags (browser): pure leaves resolve, event leaf is FALSE", async () => {
    // A secret caller on the browser GET route resolves the seeded contact by
    // userId (server-trusted) — the route still evaluates in mode:"browser".
    const res = await app.request(
      `/v1/flags?userId=${encodeURIComponent(USER)}`,
      { method: "GET", headers: AUTH_SECRET },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flags: Record<string, unknown> };
    // Snapshot-backed pure leaves evaluate on the browser path.
    expect(body.flags[`${RUN}-bucket`]).toBe(true);
    expect(body.flags[`${RUN}-journey`]).toBe(true);
    expect(body.flags[`${RUN}-deal`]).toBe(true);
    // The server-only event + email_engagement leaves short-circuit to false on
    // the browser path.
    expect(body.flags[`${RUN}-event`]).toBe(false);
    expect(body.flags[`${RUN}-engagement`]).toBe(false);
  });

  it("POST /v1/flags/evaluate (server): the event leaf resolves TRUE", async () => {
    const res = await app.request("/v1/flags/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_SECRET },
      body: JSON.stringify({ userId: USER }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flags: Record<string, unknown> };
    expect(body.flags[`${RUN}-bucket`]).toBe(true);
    // event leaf now resolves server-side against user_events.
    expect(body.flags[`${RUN}-event`]).toBe(true);
    // email_engagement resolves against email_sends keyed on the contact's REAL
    // email (CONTACT_EMAIL) — NOT the contactKey. Regressing to the contactKey
    // lookup makes this false.
    expect(body.flags[`${RUN}-engagement`]).toBe(true);
  });

  it("browser query count is FIXED — independent of flag count (O(1))", async () => {
    // Count `db.select()` invocations while evaluating N vs 2N flags. The flags
    // query (1) + the snapshot's fixed ~4 selects must NOT grow per flag on the
    // browser path (server-only leaves never touch the DB).
    let selects = 0;
    const spyDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "select") {
          selects++;
          return (target.select as (...a: unknown[]) => unknown).bind(target);
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof db;

    // With 4 seeded flags:
    selects = 0;
    await evaluateFlagsForContact({
      db: spyDb,
      contactKey: USER,
      contactId,
      mode: "browser",
    });
    const withFour = selects;

    // Add 4 more flags (8 total) and re-run.
    await seedFlag(`${RUN}-count-a`, []);
    await seedFlag(`${RUN}-count-b`, []);
    await seedFlag(`${RUN}-count-c`, []);
    await seedFlag(`${RUN}-count-d`, []);
    selects = 0;
    await evaluateFlagsForContact({
      db: spyDb,
      contactKey: USER,
      contactId,
      mode: "browser",
    });
    const withEight = selects;

    expect(withEight).toBe(withFour);
    // Sanity: it is the fixed flags(1) + snapshot(4) shape.
    expect(withFour).toBe(5);
  });

  it("loadTargetingSnapshot materializes the contact's state", async () => {
    const snap = await loadTargetingSnapshot({
      db,
      contactKey: USER,
      contactId,
    });
    expect(snap.buckets.has(BUCKET_ID)).toBe(true);
    expect(snap.journeys.get(JOURNEY_ID)?.completed).toBe(true);
    expect(snap.deals.won).toBe(true);
    expect(snap.deals.stage).toBe("sold");
  });
});
