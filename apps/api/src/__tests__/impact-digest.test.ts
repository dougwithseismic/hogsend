import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// DB-touching suite (later blocks): point at the real docker TimescaleDB,
// overriding the vitest.config placeholder DATABASE_URL. Must run before
// the engine import below.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Config-preserving Hatchet mock (mirrors outbound-webhooks-emit.test.ts).
// Mock BOTH the engine's own lib/hatchet.ts (so importing @hogsend/engine
// never dials a live gRPC engine) AND the API's ../lib/hatchet.js.
// Spreading `config` keeps `fn` readable on task objects — later blocks
// invoke `impactDigestTask.fn` directly (the bucket-reconcile seam
// pattern), and `deliverWebhookTask.runNoWait` becomes a no-op so
// emitOutbound inserts delivery rows without dialing the broker.
const { hatchetMock } = vi.hoisted(() => {
  const factory = () => ({
    hatchet: {
      durableTask: vi.fn((config: Record<string, unknown>) => ({
        ...config,
        run: vi.fn(),
        runNoWait: vi.fn(),
        runAndWait: vi.fn(),
      })),
      task: vi.fn((config: Record<string, unknown>) => ({
        ...config,
        run: vi.fn(),
        runNoWait: vi.fn(async () => ({})),
      })),
      events: { push: vi.fn() },
      runs: { cancel: vi.fn(), get: vi.fn() },
      worker: vi.fn(),
    },
  });
  return { hatchetMock: factory };
});

vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

const { posthogDestination, segmentDestination, WEBHOOK_EVENT_TYPES } =
  await import("@hogsend/engine");

const {
  contacts,
  conversions,
  createDatabase,
  journeyStates,
  userEvents,
  webhookDeliveries,
  webhookEndpoints,
} = await import("@hogsend/db");
const { and, eq, like, sql } = await import("drizzle-orm");
const { detectLiftCrossings, detectShippedVersions } = await import(
  "@hogsend/engine"
);

const { db } = createDatabase({ url: process.env.DATABASE_URL as string });

const RUN = `impd-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
let contactId = "";

beforeAll(async () => {
  const [contact] = await db
    .insert(contacts)
    .values({ email: `${RUN}@example.com`, externalId: `${RUN}-contact` })
    .returning({ id: contacts.id });
  contactId = contact?.id ?? "";
});

afterAll(async () => {
  await db.delete(conversions).where(like(conversions.userKey, `${RUN}-%`));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  await db
    .delete(journeyStates)
    .where(like(journeyStates.journeyId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}-%`));
  await db
    .delete(webhookDeliveries)
    .where(eq(webhookDeliveries.eventType, "impact.digest"));
  await db
    .delete(webhookEndpoints)
    .where(like(webhookEndpoints.url, `https://example.com/${RUN}/%`));
});

/** Bulk-insert journey_states rows; returns the seeded userIds. */
async function seedStates(opts: {
  journeyId: string;
  prefix: string;
  count: number;
  createdAt: Date;
  status?: "completed" | "held_out";
  hash?: string | null;
  label?: string | null;
}): Promise<string[]> {
  const userIds = Array.from(
    { length: opts.count },
    (_, i) => `${RUN}-${opts.prefix}-${i}`,
  );
  await db.insert(journeyStates).values(
    userIds.map((userId) => ({
      userId,
      userEmail: `${userId}@example.com`,
      journeyId: opts.journeyId,
      currentNodeId: "entry",
      status: opts.status ?? ("completed" as const),
      journeyVersionHash: opts.hash ?? null,
      journeyVersionLabel: opts.label ?? null,
      createdAt: opts.createdAt,
      updatedAt: opts.createdAt,
    })),
  );
  return userIds;
}

/** One userEvents + conversions row per user (FK chain satisfied). */
async function seedConversions(
  userIds: string[],
  definitionId: string,
  occurredAt: Date,
): Promise<void> {
  if (userIds.length === 0) return;
  const eventRows = await db
    .insert(userEvents)
    .values(
      userIds.map((userId) => ({
        userId,
        event: "digest.converted",
        properties: {},
      })),
    )
    .returning({ id: userEvents.id, userId: userEvents.userId });
  await db.insert(conversions).values(
    eventRows.map((row) => ({
      definitionId,
      contactId,
      userKey: row.userId,
      eventId: row.id,
      occurredAt,
    })),
  );
}

const DAY = 86_400_000;

// A frozen impact.digest envelope as the delivery task would hand a preset.
const digestEnvelope = {
  id: "msg_test-digest",
  type: "impact.digest",
  timestamp: "2026-07-20T09:00:00.000Z",
  data: {
    periodKey: "2026-07-20",
    since: "2026-07-13T09:00:00.000Z",
    until: "2026-07-20T09:00:00.000Z",
    entries: [],
    truncated: false,
  },
} as unknown as Parameters<typeof posthogDestination.transform>[0];

const presetLogger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
};

describe("impact.digest catalog membership", () => {
  it("is a member of WEBHOOK_EVENT_TYPES (count 30)", () => {
    expect(WEBHOOK_EVENT_TYPES).toContain("impact.digest");
    expect(WEBHOOK_EVENT_TYPES).toHaveLength(30);
  });
});

describe("impact.digest destination preset guards", () => {
  it("posthog preset returns null (no person identity — capture would 400)", () => {
    const ctx = {
      endpoint: { config: { apiKey: "phc_test" } },
      logger: presetLogger,
    } as unknown as Parameters<typeof posthogDestination.transform>[1];
    expect(posthogDestination.transform(digestEnvelope, ctx)).toBeNull();
  });

  it("segment preset returns null (no subject — track would be junk)", () => {
    const ctx = {
      endpoint: { config: { writeKey: "sk_test" } },
      logger: presetLogger,
    } as unknown as Parameters<typeof segmentDestination.transform>[1];
    expect(segmentDestination.transform(digestEnvelope, ctx)).toBeNull();
  });
});

type LiftEntry = import("@hogsend/engine").ImpactDigestLiftEntry;
type ShippedEntry = import("@hogsend/engine").ImpactDigestShippedEntry;

// The workflow file is not exported from @hogsend/engine yet (Tasks 3-5
// still fill it in), so it's loaded at runtime through Vite. A LITERAL
// static import into another package's src would pull those files into
// THIS package's TS program and trip rootDir (TS6059) under
// `tsc --noEmit`; the variable specifier keeps tsc out of it (same idiom
// as provision-posthog-loop.test.ts / analytics-admin.test.ts).
const impactDigestModulePath = new URL(
  "../../../../packages/engine/src/workflows/impact-digest.ts",
  import.meta.url,
).pathname;
const { assembleDigestEntries, deriveDigestWindow } = (await import(
  /* @vite-ignore */ impactDigestModulePath
)) as {
  deriveDigestWindow: (opts: { lastDeliveryAt: Date | null; now: Date }) => {
    since: Date;
    until: Date;
  };
  assembleDigestEntries: (opts: {
    lift: LiftEntry[];
    shipped: ShippedEntry[];
    cap: number;
  }) => { entries: (LiftEntry | ShippedEntry)[]; truncated: boolean };
};

function liftEntry(
  overrides: Partial<LiftEntry> & { journeyId: string; winProbability: number },
): LiftEntry {
  return {
    kind: "lift",
    causal: true,
    journeyName: null,
    goalDefinitionId: null,
    windowDays: 90,
    direction: "up",
    treatment: { contacts: 100, converters: 10, rate: 0.1 },
    control: { contacts: 100, converters: 5, rate: 0.05 },
    liftPercent: 100,
    previousWinProbability: null,
    smallSample: false,
    ...overrides,
  };
}

function shippedEntry(
  overrides: Partial<ShippedEntry> & { journeyId: string; firstSeenAt: string },
): ShippedEntry {
  return {
    kind: "shipped",
    causal: false,
    journeyName: null,
    versionHash: "aaaaaaaaaaaa",
    versionLabel: null,
    change: "new_version",
    previousVersionLabel: null,
    goalDefinitionId: null,
    current: {
      versionHash: "aaaaaaaaaaaa",
      versionLabel: null,
      enrollmentsAllTime: 10,
      converters: 1,
      conversionRate: 0.1,
      firstSeenAt: overrides.firstSeenAt,
      exposureDays: 3,
    },
    previous: null,
    ...overrides,
  };
}

describe("deriveDigestWindow (watermark)", () => {
  const now = new Date("2026-07-20T09:00:00.000Z");

  it("first-ever run defaults to a 7-day window", () => {
    const { since, until } = deriveDigestWindow({ lastDeliveryAt: null, now });
    expect(until.toISOString()).toBe(now.toISOString());
    expect(since.toISOString()).toBe(
      new Date(now.getTime() - 7 * DAY).toISOString(),
    );
  });

  it("uses the last delivery time as the watermark", () => {
    const last = new Date(now.getTime() - 3 * DAY);
    const { since } = deriveDigestWindow({ lastDeliveryAt: last, now });
    expect(since.toISOString()).toBe(last.toISOString());
  });

  it("clamps a stale watermark to 30 days (self-healing after pruning)", () => {
    const last = new Date(now.getTime() - 45 * DAY);
    const { since } = deriveDigestWindow({ lastDeliveryAt: last, now });
    expect(since.toISOString()).toBe(
      new Date(now.getTime() - 30 * DAY).toISOString(),
    );
  });
});

describe("assembleDigestEntries (cap + ordering)", () => {
  it("orders lift by desc |winProbability − 0.5| first, then shipped by desc firstSeenAt", () => {
    const nearCoin = liftEntry({ journeyId: "j-near", winProbability: 0.97 });
    const extreme = liftEntry({
      journeyId: "j-extreme",
      winProbability: 0.02,
      direction: "down",
    });
    const older = shippedEntry({
      journeyId: "j-old",
      firstSeenAt: "2026-07-14T00:00:00.000Z",
    });
    const newer = shippedEntry({
      journeyId: "j-new",
      firstSeenAt: "2026-07-19T00:00:00.000Z",
    });
    const { entries, truncated } = assembleDigestEntries({
      lift: [nearCoin, extreme],
      shipped: [older, newer],
      cap: 50,
    });
    expect(entries.map((e) => e.journeyId)).toEqual([
      "j-extreme",
      "j-near",
      "j-new",
      "j-old",
    ]);
    expect(truncated).toBe(false);
  });

  it("caps at `cap` entries and reports truncated", () => {
    const lift = Array.from({ length: 30 }, (_, i) =>
      liftEntry({
        journeyId: `l-${String(i).padStart(2, "0")}`,
        winProbability: 0.99,
      }),
    );
    const shipped = Array.from({ length: 30 }, (_, i) =>
      shippedEntry({
        journeyId: `s-${i}`,
        firstSeenAt: "2026-07-19T00:00:00.000Z",
      }),
    );
    const { entries, truncated } = assembleDigestEntries({
      lift,
      shipped,
      cap: 50,
    });
    expect(entries).toHaveLength(50);
    expect(truncated).toBe(true);
    expect(entries.slice(0, 30).every((e) => e.kind === "lift")).toBe(true);
  });
});

describe("detectShippedVersions (Detection A + label pass)", () => {
  // Far-future anchor isolates these fixtures from every other suite's
  // rows: Detection A scans journey_states GLOBALLY, so the window must
  // contain only rows this test seeded.
  const A0 = new Date(Date.now() + 400 * DAY);
  const since = A0;
  const until = new Date(A0.getTime() + 7 * DAY);
  const pre = new Date(A0.getTime() - 40 * DAY);
  const inWin = new Date(A0.getTime() + 1 * DAY);

  const J_NEW = `${RUN}-shipped-new`;
  const J_VER = `${RUN}-shipped-ver`;
  const J_LAB = `${RUN}-shipped-lab`;
  const J_PRE = `${RUN}-shipped-pre`;
  const GOAL = `${RUN}-goal`;
  const H_NEW = "aaaaaaaaaaa1";
  const H_V1 = "bbbbbbbbbbb1";
  const H_V2 = "ccccccccccc1";
  const H_LAB = "ddddddddddd1";
  const H_PRE = "eeeeeeeeeee1";

  const registry = {
    get: (id: string) =>
      id === J_VER ? { goal: GOAL, name: "Versioned journey" } : undefined,
  };

  beforeAll(async () => {
    // J_NEW: first hash ever, first seen in-window → new_journey.
    await seedStates({
      journeyId: J_NEW,
      prefix: "new",
      count: 3,
      createdAt: inWin,
      hash: H_NEW,
      label: "v1",
    });
    // J_VER: v1 pre-window, v2 in-window → new_version (previous = v1).
    await seedStates({
      journeyId: J_VER,
      prefix: "ver1",
      count: 4,
      createdAt: pre,
      hash: H_V1,
      label: "v1",
    });
    const treated = await seedStates({
      journeyId: J_VER,
      prefix: "ver2",
      count: 6,
      createdAt: inWin,
      hash: H_V2,
      label: "v2",
    });
    await seedStates({
      journeyId: J_VER,
      prefix: "ver2h",
      count: 2,
      createdAt: inWin,
      status: "held_out",
      hash: H_V2,
      label: "v2",
    });
    // Conversions AFTER entry: 2 on the goal definition, 1 on another —
    // goal-scoped converters must count 2; any-definition counts 3.
    const convertedAt = new Date(inWin.getTime() + 60 * 60 * 1000);
    await seedConversions(treated.slice(0, 2), GOAL, convertedAt);
    await seedConversions(treated.slice(2, 3), `${RUN}-other`, convertedAt);
    // J_LAB: same hash pre-window ("L1") and in-window ("L2") → new_label.
    await seedStates({
      journeyId: J_LAB,
      prefix: "lab1",
      count: 3,
      createdAt: pre,
      hash: H_LAB,
      label: "L1",
    });
    await seedStates({
      journeyId: J_LAB,
      prefix: "lab2",
      count: 3,
      createdAt: inWin,
      hash: H_LAB,
      label: "L2",
    });
    // J_PRE: hash first observed before the window → silent.
    await seedStates({
      journeyId: J_PRE,
      prefix: "pre",
      count: 3,
      createdAt: pre,
      hash: H_PRE,
      label: "v1",
    });
  });

  it("classifies a brand-new journey as new_journey with previous null", async () => {
    const { entries } = await detectShippedVersions({
      db,
      since,
      until,
      registry,
    });
    expect(entries.filter((e) => e.journeyId === J_NEW)).toHaveLength(1);
    const entry = entries.find((e) => e.journeyId === J_NEW);
    expect(entry).toMatchObject({
      kind: "shipped",
      causal: false,
      change: "new_journey",
      versionHash: H_NEW,
      versionLabel: "v1",
      previous: null,
      journeyName: null,
      goalDefinitionId: null,
    });
  });

  it("classifies a new hash on an existing journey as new_version with the previous cohort", async () => {
    const { entries } = await detectShippedVersions({
      db,
      since,
      until,
      registry,
    });
    const forJourney = entries.filter((e) => e.journeyId === J_VER);
    // The new label "v2" rides the hash entry — no duplicate new_label.
    expect(forJourney).toHaveLength(1);
    expect(forJourney[0]).toMatchObject({
      change: "new_version",
      versionHash: H_V2,
      versionLabel: "v2",
      journeyName: "Versioned journey",
      goalDefinitionId: GOAL,
    });
    expect(forJourney[0]?.previous).toMatchObject({
      versionHash: H_V1,
      versionLabel: "v1",
      enrollmentsAllTime: 4,
    });
  });

  it("cohorts exclude held_out, honor the goal, and carry firstSeenAt/exposureDays", async () => {
    const { entries } = await detectShippedVersions({
      db,
      since,
      until,
      registry,
    });
    const entry = entries.find((e) => e.journeyId === J_VER);
    // 6 treated (2 held_out rows excluded); goal-scoped converters = 2.
    expect(entry?.current).toMatchObject({
      enrollmentsAllTime: 6,
      converters: 2,
      conversionRate: 2 / 6,
    });
    expect(entry?.current.firstSeenAt).toBe(inWin.toISOString());
    expect(entry?.current.exposureDays).toBe(6);
    // Without a registry (no goal) the converters fall back to any
    // definition.
    const { entries: unscoped } = await detectShippedVersions({
      db,
      since,
      until,
    });
    expect(
      unscoped.find((e) => e.journeyId === J_VER)?.current.converters,
    ).toBe(3);
  });

  it("reports a label-only change as new_label with previousVersionLabel", async () => {
    const { entries } = await detectShippedVersions({
      db,
      since,
      until,
      registry,
    });
    const entry = entries.find((e) => e.journeyId === J_LAB);
    expect(entry).toMatchObject({
      change: "new_label",
      versionHash: H_LAB,
      versionLabel: "L2",
      previousVersionLabel: "L1",
      previous: null,
    });
    // The cohort is the WHOLE hash cohort (both eras).
    expect(entry?.current.enrollmentsAllTime).toBe(6);
  });

  it("stays silent for hashes first observed before the window", async () => {
    const { entries } = await detectShippedVersions({
      db,
      since,
      until,
      registry,
    });
    expect(entries.find((e) => e.journeyId === J_PRE)).toBeUndefined();
  });
});

describe("detectLiftCrossings (Detection B)", () => {
  // Disjoint future anchor: +500d keeps the 90-day candidate scan clear of
  // both the Detection A fixtures (+400d) and every real (past) row.
  const B0 = new Date(Date.now() + 500 * DAY);
  const since = B0;
  const until = new Date(B0.getTime() + 7 * DAY);
  // Inside BOTH 90-day lift windows ([until−90d, until) and
  // [since−90d, since)).
  const enrolledAt = new Date(until.getTime() - 60 * DAY);
  const convertedInWindow = new Date(until.getTime() - 1 * DAY);
  const convertedBeforeSince = new Date(enrolledAt.getTime() + 60 * 60 * 1000);
  const T = 0.95;

  const J_UP = `${RUN}-lift-up`;
  const J_DOWN = `${RUN}-lift-down`;
  const J_SUP = `${RUN}-lift-sup`;
  const J_OVR = `${RUN}-lift-ovr`;

  beforeAll(async () => {
    // UP: 40 treated (30 convert in-window) vs 40 held out (2 convert).
    const upT = await seedStates({
      journeyId: J_UP,
      prefix: "upt",
      count: 40,
      createdAt: enrolledAt,
    });
    const upC = await seedStates({
      journeyId: J_UP,
      prefix: "upc",
      count: 40,
      createdAt: enrolledAt,
      status: "held_out",
    });
    await seedConversions(upT.slice(0, 30), `${RUN}-rev`, convertedInWindow);
    await seedConversions(upC.slice(0, 2), `${RUN}-rev`, convertedInWindow);
    // DOWN: 40 treated (2 convert) vs 40 held out (30 convert).
    const downT = await seedStates({
      journeyId: J_DOWN,
      prefix: "dnt",
      count: 40,
      createdAt: enrolledAt,
    });
    const downC = await seedStates({
      journeyId: J_DOWN,
      prefix: "dnc",
      count: 40,
      createdAt: enrolledAt,
      status: "held_out",
    });
    await seedConversions(downT.slice(0, 2), `${RUN}-rev`, convertedInWindow);
    await seedConversions(downC.slice(0, 30), `${RUN}-rev`, convertedInWindow);
    // SUPPRESSED: combined conversions under the 10 floor.
    const supT = await seedStates({
      journeyId: J_SUP,
      prefix: "spt",
      count: 10,
      createdAt: enrolledAt,
    });
    await seedStates({
      journeyId: J_SUP,
      prefix: "spc",
      count: 10,
      createdAt: enrolledAt,
      status: "held_out",
    });
    await seedConversions(supT.slice(0, 3), `${RUN}-rev`, convertedInWindow);
    // OVERRIDE: crossing established long BEFORE `since` (all conversions
    // predate it), so the live recompute at asOf=since is ALSO above T.
    const ovrT = await seedStates({
      journeyId: J_OVR,
      prefix: "ovt",
      count: 40,
      createdAt: enrolledAt,
    });
    const ovrC = await seedStates({
      journeyId: J_OVR,
      prefix: "ovc",
      count: 40,
      createdAt: enrolledAt,
      status: "held_out",
    });
    await seedConversions(
      ovrT.slice(0, 30),
      `${RUN}-rev`,
      convertedBeforeSince,
    );
    await seedConversions(ovrC.slice(0, 2), `${RUN}-rev`, convertedBeforeSince);
  });

  it("reports an up-crossing (suppressed prev → null counts as below T)", async () => {
    const { entries } = await detectLiftCrossings({
      db,
      since,
      until,
      threshold: T,
    });
    const entry = entries.find((e) => e.journeyId === J_UP);
    expect(entry).toMatchObject({
      kind: "lift",
      causal: true,
      direction: "up",
      windowDays: 90,
      previousWinProbability: null,
      goalDefinitionId: null,
      journeyName: null,
    });
    expect(entry?.winProbability).toBeGreaterThanOrEqual(T);
    expect(entry?.treatment).toMatchObject({ contacts: 40, converters: 30 });
    expect(entry?.control).toMatchObject({ contacts: 40, converters: 2 });
  });

  it("reports a down-crossing", async () => {
    const { entries } = await detectLiftCrossings({
      db,
      since,
      until,
      threshold: T,
    });
    const entry = entries.find((e) => e.journeyId === J_DOWN);
    expect(entry?.direction).toBe("down");
    expect(entry?.winProbability).toBeLessThanOrEqual(1 - T);
  });

  it("smallSample rides the entry without blocking it", async () => {
    const { entries } = await detectLiftCrossings({
      db,
      since,
      until,
      threshold: T,
    });
    // 40-contact cohorts are under the 100 floor — flagged, not hidden.
    expect(entries.find((e) => e.journeyId === J_UP)?.smallSample).toBe(true);
  });

  it("suppression is absolute — under 10 combined conversions, no entry", async () => {
    const { entries } = await detectLiftCrossings({
      db,
      since,
      until,
      threshold: T,
    });
    expect(entries.find((e) => e.journeyId === J_SUP)).toBeUndefined();
  });

  it("already-above-threshold journeys are silent (crossing, not level)", async () => {
    const { entries } = await detectLiftCrossings({
      db,
      since,
      until,
      threshold: T,
      previousWinProbabilities: new Map([[J_UP, 0.99]]),
    });
    expect(entries.find((e) => e.journeyId === J_UP)).toBeUndefined();
  });

  it("frozen-payload override beats the live recompute for prev winProbability", async () => {
    // Live recompute at asOf=since is already above T → silent…
    const { entries: recomputed } = await detectLiftCrossings({
      db,
      since,
      until,
      threshold: T,
    });
    expect(recomputed.find((e) => e.journeyId === J_OVR)).toBeUndefined();
    // …but last week's digest REPORTED 0.6 (< T): the frozen value wins
    // and the crossing is reported.
    const { entries } = await detectLiftCrossings({
      db,
      since,
      until,
      threshold: T,
      previousWinProbabilities: new Map([[J_OVR, 0.6]]),
    });
    const entry = entries.find((e) => e.journeyId === J_OVR);
    expect(entry).toMatchObject({
      direction: "up",
      previousWinProbability: 0.6,
    });
  });
});
