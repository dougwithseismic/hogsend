import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// DB-touching test against the real docker TimescaleDB (mirrors buckets.test.ts /
// bucket-backfill.test.ts), overriding the vitest.config placeholder DATABASE_URL.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Mock Hatchet so building the reconcile task at import does NOT construct a live
// gRPC engine, while PRESERVING the `fn` passed to `task()` so the test can invoke
// `bucketReconcileTask.fn()` directly (the documented test seam) and assert on the
// rows + emissions it materializes. `events.push` is a spy so we can prove the
// reconcile-discovered absence JOIN emits `bucket:entered` exactly once.
//
// The task is BUILT inside @hogsend/engine, which uses the ENGINE's own
// `lib/hatchet.js`, so we mock that module by its absolute source path (the engine
// is inlined by vitest, so the `.ts` source is the resolved module). `vi.hoisted`
// shares the spy + factory across both mocks.
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

const { bucketConfigs, bucketMemberships, contacts, userEvents } = await import(
  "@hogsend/db"
);
const { and, eq, like } = await import("drizzle-orm");
const {
  buildBucketRegistry,
  bucketReconcileTask,
  computeCriteriaHash,
  createHogsendClient,
  days,
  defineBucket,
  resetBucketRegistry,
  setBucketRegistry,
} = await import("@hogsend/engine");

const container = createHogsendClient();
const { db } = container;

// `bucketReconcileTask.fn` is the real cron body (the mock above preserved it). It
// self-bootstraps its own db from process.env.DATABASE_URL and reads the process
// bucket-registry singleton — both controlled here.
const reconcileTask = bucketReconcileTask as unknown as {
  fn: () => Promise<{ reconciled: number; joined: number }>;
};
const runReconcile = () => reconcileTask.fn();

const RUN = `rcj-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const uid = (label: string) => `${RUN}-${label}`;

// ---------------------------------------------------------------------------
// Test buckets — absence-shaped, so the inference turns the cron JOIN path on.
// ---------------------------------------------------------------------------

// Composite lapsed-active: was active once AND has NOT been active in the last
// 7 days (the flagship went-dormant shape). reconcileJoins UNSET → inferred on.
const COMPOSITE_BUCKET_ID = `${RUN}-went-dormant`;
const ACTIVE_EVENT = `${RUN}:app.active`;
const compositeBucket = defineBucket({
  meta: {
    id: COMPOSITE_BUCKET_ID,
    name: "Went dormant (composite absence)",
    enabled: true,
    timeBased: true,
    criteria: (b) =>
      b.all(
        b.event(ACTIVE_EVENT).exists(),
        b.event(ACTIVE_EVENT).within(days(7)).notExists(),
      ),
  },
});

// OR-of-absence composite: stopped doing A in 7d OR stopped doing B in 7d (both
// legs need an exists-ever anchor — bare OR'd not_exists is otherwise degenerate;
// the within window makes each leg a legitimate anchor per bucket.schema.ts).
// An OR-of-absence is NOT one of the two SAFE set-based shapes (single-event
// not_exists / lapsed-active composite), so it is no longer AUTO-inferred —
// reconcileJoins must be set explicitly to turn the bounded per-member confirm
// path on (Fix #3).
const OR_BUCKET_ID = `${RUN}-stopped-either`;
const EVENT_A = `${RUN}:feature.a`;
const EVENT_B = `${RUN}:feature.b`;
const orBucket = defineBucket({
  meta: {
    id: OR_BUCKET_ID,
    name: "Stopped A or B (OR absence)",
    enabled: true,
    timeBased: true,
    reconcileJoins: true,
    criteria: (b) =>
      b.any(
        b.event(EVENT_A).within(days(7)).notExists(),
        b.event(EVENT_B).within(days(7)).notExists(),
      ),
  },
});

// entryLimit:"once" single-event windowed not_exists absence bucket. This is one
// of the two SAFE set-based shapes (single-event not_exists within), so the cron
// JOIN path is AUTO-inferred on (reconcileJoins UNSET). It exists to prove the
// cron-discovered JOIN respects the SAME entryLimit emit gate as the real-time
// path (reconcileJoinOne -> shouldEmitJoin): a re-join after a prior leave writes
// the active row + advances the epoch but does NOT emit bucket:entered.
const ONCE_BUCKET_ID = `${RUN}-once-stopped`;
const ONCE_EVENT = `${RUN}:once.active`;
const onceBucket = defineBucket({
  meta: {
    id: ONCE_BUCKET_ID,
    name: "Stopped (entryLimit once)",
    enabled: true,
    timeBased: true,
    entryLimit: "once",
    criteria: (b) => b.event(ONCE_EVENT).within(days(7)).notExists(),
  },
});

const TEST_BUCKETS = [compositeBucket, orBucket, onceBucket];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

async function seedContact(userId: string): Promise<void> {
  await db
    .insert(contacts)
    .values({
      externalId: userId,
      email: `${userId}@example.com`,
      properties: {},
    })
    .onConflictDoNothing();
}

/** Insert one userEvents row at a controlled `occurredAt`. */
async function seedEvent(
  userId: string,
  event: string,
  agoMs: number,
): Promise<void> {
  await db.insert(userEvents).values({
    userId,
    event,
    properties: {},
    occurredAt: new Date(Date.now() - agoMs),
  });
}

/**
 * Bulk-seed N currently-active contacts (ever-fired + present-in-window) sharing
 * a sortable id prefix, so the starvation test can place a wide active cohort
 * BEFORE the dormant target in `externalId asc` order without per-row round-trips.
 */
async function seedActiveCohort(
  prefix: string,
  event: string,
  count: number,
): Promise<void> {
  const ids = Array.from({ length: count }, (_, i) =>
    // zero-pad so lexical order == numeric order and the whole cohort sorts first.
    uid(`${prefix}-${String(i).padStart(5, "0")}`),
  );
  await db
    .insert(contacts)
    .values(
      ids.map((externalId) => ({
        externalId,
        email: `${externalId}@example.com`,
        properties: {},
      })),
    )
    .onConflictDoNothing();
  // Two events each: one 30d ago (ever-fired) and one inside the 7d window
  // (present), so each is a member-failing active user, not a join candidate.
  await db.insert(userEvents).values(
    ids.flatMap((userId) => [
      {
        userId,
        event,
        properties: {},
        occurredAt: new Date(Date.now() - 30 * DAY),
      },
      {
        userId,
        event,
        properties: {},
        occurredAt: new Date(Date.now() - 1 * DAY),
      },
    ]),
  );
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

/**
 * Seed a prior COMPLETED ("left") membership cycle for (user, bucket) so the next
 * join's priorCount is >= 1 — the precondition the entryLimit emit gate keys on.
 * `entryCount` is the ordinal of that prior cycle (so the re-join advances to
 * entryCount + 1).
 */
async function seedPriorLeave(
  userId: string,
  bucketId: string,
  entryCount: number,
): Promise<void> {
  await db.insert(bucketMemberships).values({
    userId,
    userEmail: `${userId}@example.com`,
    bucketId,
    status: "left",
    source: "event",
    entryCount,
    enteredAt: new Date(Date.now() - 60 * DAY),
    leftAt: new Date(Date.now() - 40 * DAY),
    lastEvaluatedAt: new Date(Date.now() - 40 * DAY),
  });
}

function enteredPushCount(bucketId: string): number {
  const name = `bucket:entered:${bucketId}`;
  return pushSpy.mock.calls.filter((c) => c[0] === name).length;
}

/**
 * How many `bucket:entered:<id>` pushes targeted a SPECIFIC userId — the pushed
 * payload carries `userId` (ingestEvent). Lets a test assert on its own user's
 * emit without counting joins of sibling-test rows still in the bucket (the file
 * does not wipe rows between `it`s, only between RUNs).
 */
function enteredPushCountForUser(bucketId: string, userId: string): number {
  const name = `bucket:entered:${bucketId}`;
  return pushSpy.mock.calls.filter(
    (c) =>
      c[0] === name &&
      (c[1] as { userId?: string } | undefined)?.userId === userId,
  ).length;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  pushSpy.mockClear();
  setBucketRegistry(buildBucketRegistry(TEST_BUCKETS, "*"));
  // Persist each bucket's criteriaHash so the cron JOIN path's first-deploy guard
  // (firstTimeBackfillIncomplete) treats the historical backfill as COMPLETED —
  // otherwise it skips the join scan to avoid a historical blast (Fix #2). This
  // mirrors the real lifecycle: backfill finishes (persists the hash) before the
  // cron's absence-join scan is allowed to emit live joins.
  for (const bucket of TEST_BUCKETS) {
    await db
      .insert(bucketConfigs)
      .values({
        bucketId: bucket.meta.id,
        criteriaHash: computeCriteriaHash(bucket.meta.criteria),
      })
      .onConflictDoUpdate({
        target: bucketConfigs.bucketId,
        set: {
          criteriaHash: computeCriteriaHash(bucket.meta.criteria),
          updatedAt: new Date(),
        },
      });
  }
});

afterAll(async () => {
  resetBucketRegistry();
  for (const bucketId of [COMPOSITE_BUCKET_ID, OR_BUCKET_ID, ONCE_BUCKET_ID]) {
    await db
      .delete(bucketMemberships)
      .where(eq(bucketMemberships.bucketId, bucketId));
    await db.delete(bucketConfigs).where(eq(bucketConfigs.bucketId, bucketId));
  }
  // This file seeds a >BATCH_SIZE contact cohort, so clean the RUN-namespaced
  // contacts + userEvents too (everything is prefixed by the unique RUN).
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}-%`));
});

// ===========================================================================
// Composite absence JOIN materialization (the path with NO prior coverage).
// ===========================================================================

describe("reconcile composite-absence JOIN (Section 6.4)", () => {
  it("enrolls a dormant user past a >BATCH_SIZE active prefix (no starvation)", async () => {
    // The starvation regression: the candidate scan is paged by externalId asc
    // with a hard BATCH_SIZE (500) cap. Seed MORE THAN one page of currently-
    // active users whose ids sort BEFORE the dormant target. Without the
    // present-in-window exclusion (old code) those 501 actives fill the entire
    // candidate page, the per-member confirm skips them all, and the dormant
    // user — past the page — is NEVER reached on any tick (hard prefix lock).
    // The exclusion drops the active cohort from candidates entirely, so the
    // dormant user is in the page and is enrolled in a single tick.
    await seedActiveCohort("active", ACTIVE_EVENT, 501);

    // `zzz-` sorts AFTER the whole `active-#####` cohort in externalId asc.
    const dormant = uid("zzz-dormant");
    await seedContact(dormant);
    // Was active once (30 days ago) but nothing in the last 7 days.
    await seedEvent(dormant, ACTIVE_EVENT, 30 * DAY);

    await runReconcile();

    // The dormant user is now an active member despite sorting last.
    const row = await activeRow(dormant, COMPOSITE_BUCKET_ID);
    expect(row?.status).toBe("active");
    // entryCount is the first epoch; source records the discoverer.
    expect(row?.entryCount).toBe(1);
    expect(row?.source).toBe("reconcile");

    // Reconcile-discovered absence joins DO emit bucket:entered (unlike backfill),
    // and none of the active cohort was enrolled (so exactly one emit).
    expect(enteredPushCount(COMPOSITE_BUCKET_ID)).toBe(1);
  });

  it("never enrolls a brand-new never-active signup (exists-ever floor)", async () => {
    const signup = uid("never-active-signup");
    await seedContact(signup);
    // No ACTIVE_EVENT ever → fails the exists() leg, excluded by the floor.

    await runReconcile();

    expect(await activeRow(signup, COMPOSITE_BUCKET_ID)).toBeUndefined();
  });
});

// ===========================================================================
// OR-of-absence: a user who only ever fired the OTHER leg must still enroll.
// ===========================================================================

describe("reconcile OR-of-absence JOIN — multi-leg candidate floor", () => {
  it("enrolls a user who only ever fired leg B and went absent on B", async () => {
    // Regression for the single-leg candidate floor: with only the FIRST absence
    // leg's ever-fired set as the superset, a user who only ever touched leg B
    // (event B) was silently never a candidate. The UNION across legs fixes it.
    const onlyB = uid("only-b-dormant");
    await seedContact(onlyB);
    // Fired B once, 30 days ago — ever-active on B, absent on B in the window.
    await seedEvent(onlyB, EVENT_B, 30 * DAY);

    await runReconcile();

    expect((await activeRow(onlyB, OR_BUCKET_ID))?.status).toBe("active");
    expect(enteredPushCount(OR_BUCKET_ID)).toBe(1);
  });

  it("does NOT enroll a user present in the window of every absence leg", async () => {
    // Present in BOTH A and B windows → fails both not_exists legs → qualifies via
    // neither (OR). The present-in-all-windows exclusion drops them as candidates.
    const activeBoth = uid("active-both");
    await seedContact(activeBoth);
    await seedEvent(activeBoth, EVENT_A, 30 * DAY);
    await seedEvent(activeBoth, EVENT_A, 1 * DAY);
    await seedEvent(activeBoth, EVENT_B, 30 * DAY);
    await seedEvent(activeBoth, EVENT_B, 1 * DAY);

    await runReconcile();

    expect(await activeRow(activeBoth, OR_BUCKET_ID)).toBeUndefined();
  });
});

// ===========================================================================
// Fix #1 — cron-discovered JOIN respects entryLimit. The reconcile JOIN path
// (reconcileJoinOne) must apply the SAME shouldEmitJoin gate as the real-time
// join: an entryLimit:"once" bucket re-joined after a prior leave WRITES the
// active row + advances the epoch but does NOT emit bucket:entered.
// ===========================================================================

describe("reconcile JOIN entryLimit gate (Fix #1)", () => {
  it("first cron-join of an entryLimit:once bucket writes the row AND emits", async () => {
    // priorCount === 0 → first-ever join always emits, regardless of entryLimit.
    const firstJoin = uid("once-first-join");
    await seedContact(firstJoin);
    // Was active once (30d ago), absent in the 7d window → lapsed-only candidate.
    await seedEvent(firstJoin, ONCE_EVENT, 30 * DAY);

    await runReconcile();

    const row = await activeRow(firstJoin, ONCE_BUCKET_ID);
    expect(row?.status).toBe("active");
    expect(row?.entryCount).toBe(1);
    expect(row?.source).toBe("reconcile");
    expect(enteredPushCount(ONCE_BUCKET_ID)).toBe(1);
  });

  it("second cron-join after a prior leave writes the row but SUPPRESSES the emit", async () => {
    // priorCount >= 1 + entryLimit:"once" → shouldEmitJoin returns false. The
    // active row is still written (Studio size must reflect reality) and the
    // epoch still advances (the insert is unconditional); only the bucket:entered
    // recursion is gated. This is the cron mirror of the real-time
    // entryLimit:"once" suppression already covered in buckets.test.ts.
    const reJoin = uid("once-rejoin");
    await seedContact(reJoin);
    // A prior COMPLETED cycle (entryCount 1) → priorCount is 1 at the next join.
    await seedPriorLeave(reJoin, ONCE_BUCKET_ID, 1);
    // Was active once (30d ago), absent in the 7d window → re-qualifies now.
    await seedEvent(reJoin, ONCE_EVENT, 30 * DAY);

    await runReconcile();

    // The active row IS written and the epoch advanced to 2 (1 + priorCount).
    const row = await activeRow(reJoin, ONCE_BUCKET_ID);
    expect(row?.status).toBe("active");
    expect(row?.entryCount).toBe(2);
    expect(row?.source).toBe("reconcile");

    // ...but the bucket:entered EMIT is suppressed by entryLimit:"once".
    expect(enteredPushCount(ONCE_BUCKET_ID)).toBe(0);
  });
});

// ===========================================================================
// Fix #2 — the no-blast first-deploy guard. reconcileBucketJoins must SKIP the
// absence-join scan (no row written, no emit) while the bucket's first-time
// backfill has not persisted its criteriaHash, so a concurrent cron tick never
// re-discovers + re-emits the historical cohort the backfill is claiming
// silently (firstTimeBackfillIncomplete).
// ===========================================================================

describe("reconcile JOIN no-blast guard (Fix #2)", () => {
  it("skips the join scan while criteriaHash is null (first-time backfill pending)", async () => {
    // Null out the persisted hash so firstTimeBackfillIncomplete is true — the
    // SAME state a brand-new bucket is in before its backfill finishes. (The
    // beforeEach seeds a non-null hash; we clear it for this one bucket.)
    await db
      .update(bucketConfigs)
      .set({ criteriaHash: null })
      .where(eq(bucketConfigs.bucketId, COMPOSITE_BUCKET_ID));

    const dormant = uid("blast-guard-dormant");
    await seedContact(dormant);
    // A textbook lapsed-active candidate that WOULD enroll if the gate were open.
    await seedEvent(dormant, ACTIVE_EVENT, 30 * DAY);

    await runReconcile();

    // The join scan was skipped: no active row, no bucket:entered emit for this
    // user. (Whole-bucket emits stay 0 too — the guard skips the entire scan, so
    // no other dormant cohort row is re-discovered while the gate is closed.)
    expect(await activeRow(dormant, COMPOSITE_BUCKET_ID)).toBeUndefined();
    expect(enteredPushCountForUser(COMPOSITE_BUCKET_ID, dormant)).toBe(0);
    expect(enteredPushCount(COMPOSITE_BUCKET_ID)).toBe(0);
  });

  it("resumes the join scan once the criteriaHash is persisted again", async () => {
    // Monotonic transition: after the (simulated) backfill persists the hash, the
    // very next tick proceeds with the absence-join scan and enrolls the cohort.
    const dormant = uid("blast-guard-resume");
    await seedContact(dormant);
    await seedEvent(dormant, ACTIVE_EVENT, 30 * DAY);

    // Hash is non-null (seeded by beforeEach) → gate is open.
    await runReconcile();

    // Assert per-user: the prior `skips` test left its un-enrolled dormant row in
    // the table, so once the gate re-opens that sibling row also enrolls in the
    // same tick — the whole-bucket count is therefore not deterministic here, but
    // THIS user's single emit is.
    expect((await activeRow(dormant, COMPOSITE_BUCKET_ID))?.status).toBe(
      "active",
    );
    expect(enteredPushCountForUser(COMPOSITE_BUCKET_ID, dormant)).toBe(1);
  });
});

// ===========================================================================
// Fix #3 — the lapsed-active composite is a SET-BASED / EXACT join: every
// candidate row is a true matcher, so NO per-member evaluateCondition runs. The
// candidate SQL must select EXACTLY the lapsed-active cohort — never-active
// signups (no exists-ever anchor) and still-active users (present in the window)
// are excluded by the SQL alone, in a single tick.
// ===========================================================================

describe("reconcile lapsed-active set-based JOIN exactness (Fix #3)", () => {
  it("enrolls only the lapsed-active user; never-active and still-active are excluded in one tick", async () => {
    // (1) lapsed-active: fired the event 30d ago, nothing in the 7d window → the
    //     exists() leg holds and the windowed not_exists() leg holds → MEMBER.
    const lapsed = uid("exact-lapsed");
    await seedContact(lapsed);
    await seedEvent(lapsed, ACTIVE_EVENT, 30 * DAY);

    // (2) never-active: no ACTIVE_EVENT ever → fails the exists() anchor → EXCLUDED
    //     by the everFired floor (not by a per-member confirm).
    const neverActive = uid("exact-never");
    await seedContact(neverActive);

    // (3) still-active: fired 30d ago AND inside the 7d window → present-in-window
    //     so the not_exists() leg fails → EXCLUDED by the present-in-all anti-join.
    const stillActive = uid("exact-still");
    await seedContact(stillActive);
    await seedEvent(stillActive, ACTIVE_EVENT, 30 * DAY);
    await seedEvent(stillActive, ACTIVE_EVENT, 1 * DAY);

    await runReconcile();

    // Exactly the lapsed-active user is enrolled; the never-active (no exists-ever
    // anchor) and still-active (present in the window) users are excluded by the
    // candidate SQL alone — no per-member evaluateCondition culled them.
    expect((await activeRow(lapsed, COMPOSITE_BUCKET_ID))?.status).toBe(
      "active",
    );
    expect(await activeRow(neverActive, COMPOSITE_BUCKET_ID)).toBeUndefined();
    expect(await activeRow(stillActive, COMPOSITE_BUCKET_ID)).toBeUndefined();

    // One emit for the lapsed matcher; none for the excluded set. Per-user so a
    // sibling test's pending dormant row enrolling in the same tick does not skew
    // the assertion.
    expect(enteredPushCountForUser(COMPOSITE_BUCKET_ID, lapsed)).toBe(1);
    expect(enteredPushCountForUser(COMPOSITE_BUCKET_ID, neverActive)).toBe(0);
    expect(enteredPushCountForUser(COMPOSITE_BUCKET_ID, stillActive)).toBe(0);
  });
});
