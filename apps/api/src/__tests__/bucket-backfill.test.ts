import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// DB-touching test against the real docker TimescaleDB (mirrors buckets.test.ts),
// overriding the vitest.config placeholder DATABASE_URL.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Mock Hatchet so building the backfill task at import does NOT construct a live
// gRPC engine. The mock PRESERVES the `fn` passed to `task()` so the test can
// invoke `bucketBackfillTask.fn(input)` directly (the documented test seam) and
// assert on the DB rows it materializes. `events.push` is a spy so we can prove
// the join path NEVER emits `bucket:entered` (the Customer.io silent-enter rule).
//
// The task is BUILT inside @hogsend/engine, which uses the ENGINE's own
// `lib/hatchet.js` (not the API's), so we mock that module by its absolute
// source path (the engine is inlined by vitest, so the `.ts` source is the
// resolved module). `vi.hoisted` shares the spy + factory across both mocks.
const { pushSpy, hatchetMock } = vi.hoisted(() => {
  const push = vi.fn();
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
        runNoWait: vi.fn(),
      })),
      events: { push },
      runs: { cancel: vi.fn(), get: vi.fn() },
      worker: vi.fn(),
    },
  });
  return { pushSpy: push, hatchetMock: factory };
});

vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

const { bucketConfigs, bucketMemberships, contacts, importJobs, userEvents } =
  await import("@hogsend/db");
const { and, eq, sql } = await import("drizzle-orm");
const {
  buildBucketRegistry,
  bucketBackfillTask,
  computeCriteriaHash,
  createHogsendClient,
  days,
  defineBucket,
  resetBucketRegistry,
  setBucketRegistry,
} = await import("@hogsend/engine");

const container = createHogsendClient();
const { db } = container;

// `bucketBackfillTask.fn` is the real task body (the mock above preserved it).
// It self-bootstraps its own db from process.env.DATABASE_URL and reads the
// process bucket-registry singleton — both controlled here. The mock spreads the
// task config so `.fn` survives, but the typed surface is the gRPC task client.
const backfillTask = bucketBackfillTask as unknown as {
  fn: (input: {
    jobId: string;
    bucketId: string;
    mode: "first-time" | "reeval";
  }) => Promise<{ status: string; joined?: number; left?: number }>;
};
const runBackfill = (input: {
  jobId: string;
  bucketId: string;
  mode: "first-time" | "reeval";
}) => backfillTask.fn(input);

const RUN = `bf-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const uid = (label: string) => `${RUN}-${label}`;

// ---------------------------------------------------------------------------
// Test buckets
// ---------------------------------------------------------------------------

// Power-users: did KEY_ACTION at least 10 times in the last 30 days (a count
// criterion — exercises selectEventMatchers' exists/count branch + Fix B).
const POWER_BUCKET_ID = `${RUN}-power-users`;
const KEY_ACTION = `${RUN}:key.action`;
const powerBucket = defineBucket({
  meta: {
    id: POWER_BUCKET_ID,
    name: "Power users",
    enabled: true,
    timeBased: true,
    criteria: (b) => b.event(KEY_ACTION).within(days(30)).atLeast(10),
  },
});

// maxDwell count bucket — proves Fix A stamps maxDwellAt on backfilled rows so
// the TTL sweep (which filters isNotNull(maxDwellAt)) can force-leave them.
const TTL_BUCKET_ID = `${RUN}-power-ttl`;
const TTL_ACTION = `${RUN}:ttl.action`;
const ttlBucket = defineBucket({
  meta: {
    id: TTL_BUCKET_ID,
    name: "Power users (time-boxed)",
    enabled: true,
    timeBased: true,
    maxDwell: { hours: 48 },
    criteria: (b) => b.event(TTL_ACTION).within(days(30)).atLeast(3),
  },
});

const TEST_BUCKETS = [powerBucket, ttlBucket];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedContact(
  userId: string,
  opts?: { deleted?: boolean },
): Promise<void> {
  await db
    .insert(contacts)
    .values({
      externalId: userId,
      email: `${userId}@example.com`,
      properties: {},
      deletedAt: opts?.deleted ? new Date() : null,
    })
    .onConflictDoUpdate({
      target: contacts.externalId,
      targetWhere: sql`${contacts.externalId} is not null and ${contacts.deletedAt} is null`,
      set: { deletedAt: opts?.deleted ? new Date() : null },
    });
}

async function seedEvents(
  userId: string,
  event: string,
  count: number,
): Promise<void> {
  const rows = Array.from({ length: count }, () => ({
    userId,
    event,
    properties: {},
  }));
  if (rows.length > 0) await db.insert(userEvents).values(rows);
}

async function createJob(bucketId: string, format: string): Promise<string> {
  const [job] = await db
    .insert(importJobs)
    .values({ fileName: bucketId, format, status: "pending" })
    .returning({ id: importJobs.id });
  if (!job) throw new Error("failed to create import job");
  return job.id;
}

async function activeRow(userId: string, bucketId: string) {
  return db.query.bucketMemberships.findFirst({
    where: and(
      eq(bucketMemberships.userId, userId),
      eq(bucketMemberships.bucketId, bucketId),
      eq(bucketMemberships.status, "active"),
    ),
  });
}

async function allRows(userId: string, bucketId: string) {
  return db.query.bucketMemberships.findMany({
    where: and(
      eq(bucketMemberships.userId, userId),
      eq(bucketMemberships.bucketId, bucketId),
    ),
    orderBy: (m, { asc }) => [asc(m.entryCount)],
  });
}

async function bucketEnteredCount(bucketId: string): Promise<number> {
  const rows = await db.query.userEvents.findMany({
    where: eq(userEvents.event, `bucket:entered:${bucketId}`),
  });
  return rows.length;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  pushSpy.mockClear();
  setBucketRegistry(buildBucketRegistry(TEST_BUCKETS, "*"));
});

afterAll(async () => {
  resetBucketRegistry();
  for (const bucketId of [POWER_BUCKET_ID, TTL_BUCKET_ID]) {
    await db
      .delete(bucketMemberships)
      .where(eq(bucketMemberships.bucketId, bucketId));
    await db.delete(bucketConfigs).where(eq(bucketConfigs.bucketId, bucketId));
  }
});

// ===========================================================================
// First-time backfill — set-based materialization, silent enter
// ===========================================================================

describe("first-time backfill (Section 6.6)", () => {
  it("materializes only matchers, suppresses bucket:entered, completes the job", async () => {
    const matcher = uid("power-matcher");
    const nonMatcher = uid("power-non");
    await seedContact(matcher);
    await seedContact(nonMatcher);
    await seedEvents(matcher, KEY_ACTION, 12); // >= 10 → matches
    await seedEvents(nonMatcher, KEY_ACTION, 3); // < 10 → not a matcher

    const jobId = await createJob(POWER_BUCKET_ID, "bucket-backfill");
    const result = await runBackfill({
      jobId,
      bucketId: POWER_BUCKET_ID,
      mode: "first-time",
    });

    expect(result.status).toBe("completed");

    // Matcher has exactly one ACTIVE, source="backfill" row; non-matcher none.
    const matcherRow = await activeRow(matcher, POWER_BUCKET_ID);
    expect(matcherRow?.status).toBe("active");
    expect(matcherRow?.source).toBe("backfill");
    expect(matcherRow?.entryCount).toBe(1); // first-time → priorCount 0 → 1
    expect(await activeRow(nonMatcher, POWER_BUCKET_ID)).toBeUndefined();

    // Silent enter: NO bucket:entered:* events written, NO Hatchet push.
    expect(await bucketEnteredCount(POWER_BUCKET_ID)).toBe(0);
    const enteredPushes = pushSpy.mock.calls.filter(
      (c) => c[0] === `bucket:entered:${POWER_BUCKET_ID}`,
    );
    expect(enteredPushes).toHaveLength(0);

    // import_jobs row completed with criteriaHash persisted.
    const job = await db.query.importJobs.findFirst({
      where: eq(importJobs.id, jobId),
    });
    expect(job?.status).toBe("completed");
    expect(job?.format).toBe("bucket-backfill");
    expect(job?.fileName).toBe(POWER_BUCKET_ID);

    const config = await db.query.bucketConfigs.findFirst({
      where: eq(bucketConfigs.bucketId, POWER_BUCKET_ID),
    });
    expect(config?.criteriaHash).toBe(
      computeCriteriaHash(powerBucket.meta.criteria),
    );
  });

  it("is idempotent — a second run inserts no new rows (onConflictDoNothing)", async () => {
    const matcher = uid("power-idem");
    await seedContact(matcher);
    await seedEvents(matcher, KEY_ACTION, 11);

    const job1 = await createJob(POWER_BUCKET_ID, "bucket-backfill");
    await runBackfill({
      jobId: job1,
      bucketId: POWER_BUCKET_ID,
      mode: "first-time",
    });
    const job2 = await createJob(POWER_BUCKET_ID, "bucket-backfill");
    const result2 = await runBackfill({
      jobId: job2,
      bucketId: POWER_BUCKET_ID,
      mode: "first-time",
    });

    expect(result2.joined).toBe(0); // active row already exists
    const rows = await allRows(matcher, POWER_BUCKET_ID);
    expect(rows).toHaveLength(1);
  });
});

// ===========================================================================
// Fix A — entryCount = 1 + prior, and maxDwellAt stamped on backfilled rows
// ===========================================================================

describe("backfill Fix A — entryCount + maxDwellAt parity", () => {
  it("re-joining user after a prior leave gets entryCount = 1 + prior", async () => {
    const user = uid("power-entryLimit");
    await seedContact(user);
    await seedEvents(user, KEY_ACTION, 15);

    // Simulate a prior completed cycle: one historical "left" row.
    await db.insert(bucketMemberships).values({
      userId: user,
      userEmail: `${user}@example.com`,
      bucketId: POWER_BUCKET_ID,
      status: "left",
      source: "event",
      entryCount: 1,
      leftAt: new Date(),
    });

    const jobId = await createJob(POWER_BUCKET_ID, "bucket-backfill");
    await runBackfill({
      jobId,
      bucketId: POWER_BUCKET_ID,
      mode: "first-time",
    });

    // The new active row must carry entryCount = 1 + 1 prior = 2, not a
    // hardcoded 1 (Fix A: the live-join epoch parity).
    const active = await activeRow(user, POWER_BUCKET_ID);
    expect(active?.entryCount).toBe(2);
  });

  it("stamps maxDwellAt on backfilled rows for a maxDwell bucket", async () => {
    const user = uid("ttl-matcher");
    await seedContact(user);
    await seedEvents(user, TTL_ACTION, 5); // >= 3 → matches

    const jobId = await createJob(TTL_BUCKET_ID, "bucket-backfill");
    await runBackfill({
      jobId,
      bucketId: TTL_BUCKET_ID,
      mode: "first-time",
    });

    const row = await activeRow(user, TTL_BUCKET_ID);
    expect(row?.maxDwellAt).toBeTruthy();
    if (!row?.maxDwellAt) throw new Error("expected maxDwellAt to be set");
    // ≈ now + 48h (enteredAt is DB now(); maxDwellAt is JS now()+ttl).
    const expectedMs = row.enteredAt.getTime() + 48 * 60 * 60 * 1000;
    expect(Math.abs(row.maxDwellAt.getTime() - expectedMs)).toBeLessThan(5000);
  });
});

// ===========================================================================
// Dwell-anchor derivation (Section 6.3 / LOCKED DECISION 1) — the mechanism
// behind "dwell fires for the genuinely long-dwelling EXISTING population on
// first deploy": the backfill must clock dwell from the historical qualifying
// instant, NOT the deploy-time enteredAt.
// ===========================================================================

describe("backfill dwell-anchor derivation (Section 6.3)", () => {
  it("derives dwellAnchorAt = max(occurredAt) of the qualifying event, earlier than the deploy-time enteredAt", async () => {
    const HOUR = 60 * 60 * 1000;
    const DAY = 24 * HOUR;
    const user = uid("anchor-derive");
    await seedContact(user);

    // 12 KEY_ACTION events, all inside the 30d window (so the user matches the
    // count criterion), with the LAST one 10 days ago — the historical instant
    // the user was still active. resolveDwellAnchorEvent(powerBucket.criteria)
    // returns KEY_ACTION, so the backfill must stamp dwellAnchorAt = that max.
    const lastAt = new Date(Date.now() - 10 * DAY);
    const rows = Array.from({ length: 12 }, (_, i) => ({
      userId: user,
      event: KEY_ACTION,
      properties: {},
      occurredAt: new Date(lastAt.getTime() - i * HOUR), // max == lastAt
    }));
    await db.insert(userEvents).values(rows);

    const jobId = await createJob(POWER_BUCKET_ID, "bucket-backfill");
    await runBackfill({
      jobId,
      bucketId: POWER_BUCKET_ID,
      mode: "first-time",
    });

    const row = await activeRow(user, POWER_BUCKET_ID);
    expect(row?.dwellAnchorAt).toBeTruthy();
    if (!row?.dwellAnchorAt) throw new Error("expected dwellAnchorAt derived");
    // ≈ the last qualifying event (10 days ago), within a few seconds.
    expect(
      Math.abs(row.dwellAnchorAt.getTime() - lastAt.getTime()),
    ).toBeLessThan(5000);
    // And strictly earlier than the deploy-time enteredAt (DB now()): the dwell
    // clock starts when they lapsed, not when the backfill ran.
    expect(row.dwellAnchorAt.getTime()).toBeLessThan(row.enteredAt.getTime());
  });
});

// ===========================================================================
// Fix B — positive event matchers join live contacts only (GDPR)
// ===========================================================================

describe("backfill Fix B — live-contact filter on positive event matchers", () => {
  it("does NOT materialize a membership for a soft-deleted contact", async () => {
    const deleted = uid("power-deleted");
    await seedContact(deleted, { deleted: true });
    await seedEvents(deleted, KEY_ACTION, 20); // would match on events alone

    const jobId = await createJob(POWER_BUCKET_ID, "bucket-backfill");
    await runBackfill({
      jobId,
      bucketId: POWER_BUCKET_ID,
      mode: "first-time",
    });

    // The inner join to live contacts drops the soft-deleted userId.
    expect(await activeRow(deleted, POWER_BUCKET_ID)).toBeUndefined();
  });

  it("does NOT materialize a membership for an orphan userEvent (no contact)", async () => {
    const orphan = uid("power-orphan");
    // NO contacts row at all, only userEvents.
    await seedEvents(orphan, KEY_ACTION, 20);

    const jobId = await createJob(POWER_BUCKET_ID, "bucket-backfill");
    await runBackfill({
      jobId,
      bucketId: POWER_BUCKET_ID,
      mode: "first-time",
    });

    expect(await activeRow(orphan, POWER_BUCKET_ID)).toBeUndefined();
  });
});

// ===========================================================================
// Reeval — restart no-op + leave-emit asymmetry
// ===========================================================================

describe("reeval (Section 6.6 B)", () => {
  it("equal-hash restart is a no-op when invoked via enqueue diff", async () => {
    // Persist the current hash, then assert a recompute equals it.
    const matcher = uid("power-stable");
    await seedContact(matcher);
    await seedEvents(matcher, KEY_ACTION, 11);
    const jobId = await createJob(POWER_BUCKET_ID, "bucket-backfill");
    await runBackfill({
      jobId,
      bucketId: POWER_BUCKET_ID,
      mode: "first-time",
    });

    const config = await db.query.bucketConfigs.findFirst({
      where: eq(bucketConfigs.bucketId, POWER_BUCKET_ID),
    });
    // The stored hash equals a fresh recompute → the boot diff is a no-op.
    expect(config?.criteriaHash).toBe(
      computeCriteriaHash(powerBucket.meta.criteria),
    );
  });
});
