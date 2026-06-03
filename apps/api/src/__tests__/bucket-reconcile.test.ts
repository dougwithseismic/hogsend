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

const { bucketMemberships, contacts, userEvents } = await import("@hogsend/db");
const { and, eq, like } = await import("drizzle-orm");
const {
  buildBucketRegistry,
  bucketReconcileTask,
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
const OR_BUCKET_ID = `${RUN}-stopped-either`;
const EVENT_A = `${RUN}:feature.a`;
const EVENT_B = `${RUN}:feature.b`;
const orBucket = defineBucket({
  meta: {
    id: OR_BUCKET_ID,
    name: "Stopped A or B (OR absence)",
    enabled: true,
    timeBased: true,
    criteria: (b) =>
      b.any(
        b.event(EVENT_A).within(days(7)).notExists(),
        b.event(EVENT_B).within(days(7)).notExists(),
      ),
  },
});

const TEST_BUCKETS = [compositeBucket, orBucket];

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

function enteredPushCount(bucketId: string): number {
  const name = `bucket:entered:${bucketId}`;
  return pushSpy.mock.calls.filter((c) => c[0] === name).length;
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
  for (const bucketId of [COMPOSITE_BUCKET_ID, OR_BUCKET_ID]) {
    await db
      .delete(bucketMemberships)
      .where(eq(bucketMemberships.bucketId, bucketId));
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
