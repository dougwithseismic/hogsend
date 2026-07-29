/**
 * PRD 04 T4c — `bucket_memberships.contact_id` dual-write (the real-time join
 * site, `buckets/check-membership.ts`).
 *
 * `checkBucketMembership` already takes `contactId` as a documented param — the
 * subject row `ingestEvent` resolved before calling it — so the dual-write is
 * ZERO new queries and cannot fail. The tests drive BOTH ends:
 *
 *   - the REAL spine (`ingestEvent` → bucket eval → join) for an identified
 *     contact, proving the value actually arrives from the ingest resolve;
 *   - the pin-less caller, proving a join for an unknown subject is still
 *     recorded in full with a NULL stamp.
 */
import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// DB-touching test. Point a worktree at its own stack with
// HOGSEND_TEST_DATABASE_URL — never by editing the default.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Dual mock (config-preserving), the buckets.test.ts idiom: the bucket cron and
// the emit path are BUILT inside @hogsend/engine against the engine's own
// `lib/hatchet.js`, so both that absolute source path and the API's relative
// one resolve to ONE hoisted push spy.
const { enginePushSpy, hatchetMock } = vi.hoisted(() => {
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
  return { enginePushSpy: push, hatchetMock: factory };
});

vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

const { bucketConfigs, bucketMemberships, contacts, importJobs, userEvents } =
  await import("@hogsend/db");
const { and, eq, like, or } = await import("drizzle-orm");
const {
  bucketBackfillTask,
  bucketReconcileTask,
  buildBucketRegistry,
  checkBucketMembership,
  computeCriteriaHash,
  createHogsendClient,
  days,
  defineBucket,
  ingestEvent,
  resetBucketRegistry,
  resolveOrCreateContact,
  setBucketRegistry,
} = await import("@hogsend/engine");

const container = createHogsendClient();
const { db, logger, registry } = container;
const hatchet = { events: { push: enginePushSpy } };

const RUN = `cibk-${randomUUID().slice(0, 8)}-${Date.now()}`;
const uid = (label: string) => `${RUN}-${label}`;

// One property bucket: plan === "pro". The cheapest criteria shape that a
// single event can flip (no windows, no event history).
const BUCKET_ID = uid("pro");
const proBucket = defineBucket({
  meta: {
    id: BUCKET_ID,
    name: "Pro",
    enabled: true,
    criteria: {
      type: "property",
      property: "plan",
      operator: "eq",
      value: "pro",
    },
  },
});

// Set-based BACKFILL bucket (the `bucket-backfill.ts` writer). A count criterion
// on a RUN-namespaced event keeps the matcher scan bounded to seeded rows.
const BACKFILL_BUCKET_ID = uid("backfill");
const BACKFILL_EVENT = `${RUN}:backfill.action`;
const backfillBucket = defineBucket({
  meta: {
    id: BACKFILL_BUCKET_ID,
    name: "Backfill matchers",
    enabled: true,
    timeBased: true,
    criteria: (b) => b.event(BACKFILL_EVENT).within(days(30)).atLeast(2),
  },
});

// Cron RECONCILE-join bucket (the `bucket-reconcile.ts` writer). The
// lapsed-active composite is one of the auto-inferred, EXACT set-based shapes,
// and its `ever_fired` floor bounds the candidate scan to users who fired this
// RUN-namespaced event — so the cron cannot wander into the shared database.
const RECONCILE_BUCKET_ID = uid("reconcile");
const RECONCILE_EVENT = `${RUN}:reconcile.active`;
const reconcileBucket = defineBucket({
  meta: {
    id: RECONCILE_BUCKET_ID,
    name: "Went dormant",
    enabled: true,
    timeBased: true,
    criteria: (b) =>
      b.all(
        b.event(RECONCILE_EVENT).exists(),
        b.event(RECONCILE_EVENT).within(days(7)).notExists(),
      ),
  },
});

const TEST_BUCKETS = [proBucket, backfillBucket, reconcileBucket];
const BUCKET_IDS = TEST_BUCKETS.map((b) => b.meta.id);

/** `.fn` survives the config-preserving hatchet mock — the documented seam. */
const backfillTask = bucketBackfillTask as unknown as {
  fn: (input: {
    jobId: string;
    bucketId: string;
    mode: "first-time" | "reeval";
  }) => Promise<{ status: string }>;
};
const reconcileTask = bucketReconcileTask as unknown as {
  fn: () => Promise<{ reconciled: number; joined: number }>;
};

const membershipsIn = (bucketId: string, userId: string) =>
  db
    .select()
    .from(bucketMemberships)
    .where(
      and(
        eq(bucketMemberships.bucketId, bucketId),
        eq(bucketMemberships.userId, userId),
      ),
    );
const membershipsFor = (userId: string) => membershipsIn(BUCKET_ID, userId);

beforeEach(async () => {
  enginePushSpy.mockClear();
  setBucketRegistry(buildBucketRegistry(TEST_BUCKETS, "*"));
  // Persist each criteriaHash so the cron's first-deploy guard
  // (`firstTimeBackfillIncomplete`) treats the historical backfill as done and
  // the JOIN leg is allowed to run — the same lifecycle bucket-reconcile.test.ts
  // reproduces.
  for (const bucket of TEST_BUCKETS) {
    await db
      .insert(bucketConfigs)
      .values({
        bucketId: bucket.meta.id,
        criteriaHash: computeCriteriaHash(bucket.meta.criteria),
      })
      .onConflictDoUpdate({
        target: bucketConfigs.bucketId,
        set: { criteriaHash: computeCriteriaHash(bucket.meta.criteria) },
      });
  }
});

afterEach(() => {
  resetBucketRegistry();
});

afterAll(async () => {
  for (const bucketId of BUCKET_IDS) {
    await db
      .delete(bucketMemberships)
      .where(eq(bucketMemberships.bucketId, bucketId));
    await db.delete(bucketConfigs).where(eq(bucketConfigs.bucketId, bucketId));
  }
  await db.delete(importJobs).where(like(importJobs.fileName, `${RUN}-%`));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  await db
    .delete(contacts)
    .where(
      or(
        like(contacts.externalId, `${RUN}-%`),
        like(contacts.anonymousId, `${RUN}-%`),
        like(contacts.email, `${RUN}-%`),
      ),
    );
  await container.dbClient.end({ timeout: 5 }).catch(() => {});
});

describe("T4c — bucket_memberships.contact_id at the real-time join", () => {
  it("the REAL ingest spine stamps the resolved contacts.id on the join", async () => {
    const userId = uid("member");
    const contact = await resolveOrCreateContact({ db, userId });

    // `ingestEvent` resolves the subject, then hands that id to
    // `checkBucketMembership` as the provenance pin — which the join now also
    // writes to `contact_id`.
    await ingestEvent({
      db,
      registry,
      hatchet: hatchet as never,
      logger,
      event: {
        event: `${RUN}.upgraded`,
        userId,
        userEmail: "",
        eventProperties: {},
        contactProperties: { plan: "pro" },
      },
    });

    const rows = await membershipsFor(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("active");
    expect(rows[0]?.contactId).toBe(contact.id);
  });

  it("a pin-less caller still records the join; the transition's own re-ingest then adopts it", async () => {
    const userId = uid("pinless");

    const transitions = await checkBucketMembership({
      db,
      registry,
      // biome-ignore lint/suspicious/noExplicitAny: mocked hatchet client
      hatchet: hatchet as any,
      logger,
      userId,
      userEmail: `${userId}@example.com`,
      event: `${RUN}.upgraded`,
      eventProperties: {},
      contactProperties: { plan: "pro" },
      // No `contactId` — the degraded, pin-less shape.
    });

    expect(
      transitions.filter(
        (t) => t.bucketId === BUCKET_ID && t.transition === "entered",
      ),
    ).toHaveLength(1);

    const rows = await membershipsFor(userId);
    expect(rows).toHaveLength(1);
    // The membership is FULLY recorded (text-keyed, no contact FK) — the
    // pin-less join itself writes NO contact id (D6: bookkeeping degrades to
    // NULL, it never fails the join).
    expect(rows[0]?.status).toBe("active");
    expect(rows[0]?.entryCount).toBe(1);
    // …but the transition emit re-ingests `bucket.entered` for this very key,
    // which mints the contact — and PRD 05 T4's own-key adoption then stamps
    // the row that predated it. A NULL here would mean a contact-scoped read
    // could not see its own membership.
    const [owner] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.externalId, userId));
    expect(owner?.id).toBeTruthy();
    expect(rows[0]?.contactId).toBe(owner?.id);
  });

  it("an explicit contactId param is written verbatim", async () => {
    const userId = uid("explicit");
    const contact = await resolveOrCreateContact({
      db,
      userId: uid("explicit-owner"),
    });

    await checkBucketMembership({
      db,
      registry,
      // biome-ignore lint/suspicious/noExplicitAny: mocked hatchet client
      hatchet: hatchet as any,
      logger,
      userId,
      userEmail: `${userId}@example.com`,
      contactId: contact.id,
      event: `${RUN}.upgraded`,
      eventProperties: {},
      contactProperties: { plan: "pro" },
    });

    const rows = await membershipsFor(userId);
    expect(rows).toHaveLength(1);
    // `userId` owns no contact of its own, so only the passed pin can produce
    // this id — the value is threaded, not re-derived.
    expect(rows[0]?.contactId).toBe(contact.id);
  });
});

describe("T4c — bucket_memberships.contact_id at the BACKFILL insert", () => {
  it("the set-based materialization stamps each matcher's contacts.id", async () => {
    const matcher = uid("bf-matcher");
    const nonMatcher = uid("bf-non");
    const contact = await resolveOrCreateContact({
      db,
      userId: matcher,
      email: `${matcher}@example.com`,
    });
    await resolveOrCreateContact({ db, userId: nonMatcher });
    await db.insert(userEvents).values([
      { userId: matcher, event: BACKFILL_EVENT, properties: {} },
      { userId: matcher, event: BACKFILL_EVENT, properties: {} },
      // 1 < 2 → not a matcher; guards against a blanket "everyone joins".
      { userId: nonMatcher, event: BACKFILL_EVENT, properties: {} },
    ]);

    const [job] = await db
      .insert(importJobs)
      .values({
        fileName: BACKFILL_BUCKET_ID,
        format: "bucket-backfill",
        status: "pending",
      })
      .returning({ id: importJobs.id });
    if (!job) throw new Error("failed to create import job");

    const result = await backfillTask.fn({
      jobId: job.id,
      bucketId: BACKFILL_BUCKET_ID,
      mode: "first-time",
    });
    expect(result.status).toBe("completed");

    const rows = await membershipsIn(BACKFILL_BUCKET_ID, matcher);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("backfill");
    // The id rides in on the SAME per-chunk contacts read the userEmail
    // backfill already issued — one extra column, zero extra queries.
    expect(rows[0]?.contactId).toBe(contact.id);
    expect(rows[0]?.userEmail).toBe(`${matcher}@example.com`);

    expect(await membershipsIn(BACKFILL_BUCKET_ID, nonMatcher)).toHaveLength(0);
  });

  it("a soft-deleted contact is never materialized at all", async () => {
    // The NULL leg of the backfill map is defensive only: every matcher shape
    // (`selectEventMatchers` / `selectCompositeMatchers`) derives its keys by
    // joining LIVE contacts, so a chunk key owned by no live contact cannot be
    // produced. The reachable outcome is no row — asserted here so the claim is
    // pinned by a test rather than by a comment.
    const dead = uid("bf-dead");
    const contact = await resolveOrCreateContact({ db, userId: dead });
    await db.insert(userEvents).values([
      { userId: dead, event: BACKFILL_EVENT, properties: {} },
      { userId: dead, event: BACKFILL_EVENT, properties: {} },
    ]);
    await db
      .update(contacts)
      .set({ deletedAt: new Date() })
      .where(eq(contacts.id, contact.id));

    const [job] = await db
      .insert(importJobs)
      .values({
        fileName: BACKFILL_BUCKET_ID,
        format: "bucket-backfill",
        status: "pending",
      })
      .returning({ id: importJobs.id });
    if (!job) throw new Error("failed to create import job");

    await backfillTask.fn({
      jobId: job.id,
      bucketId: BACKFILL_BUCKET_ID,
      mode: "first-time",
    });

    expect(await membershipsIn(BACKFILL_BUCKET_ID, dead)).toHaveLength(0);
  });
});

describe("T4c — bucket_memberships.contact_id at the RECONCILE join", () => {
  it("the cron-discovered join stamps the candidate row's contacts.id", async () => {
    // Lapsed-active: fired the event once, 30 days ago — outside the 7d window.
    const userId = uid("rc-dormant");
    const contact = await resolveOrCreateContact({ db, userId });
    await db.insert(userEvents).values({
      userId,
      event: RECONCILE_EVENT,
      properties: {},
      occurredAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });

    // Still active (fired inside the window) ⇒ excluded by present-in-all.
    const stillActive = uid("rc-active");
    await resolveOrCreateContact({ db, userId: stillActive });
    await db.insert(userEvents).values([
      {
        userId: stillActive,
        event: RECONCILE_EVENT,
        properties: {},
        occurredAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      },
      {
        userId: stillActive,
        event: RECONCILE_EVENT,
        properties: {},
        occurredAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    ]);

    await reconcileTask.fn();

    const rows = await membershipsIn(RECONCILE_BUCKET_ID, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("reconcile");
    // The candidate scan already reads `contacts.id` (the emit's provenance
    // pin); the join row now persists the same value.
    expect(rows[0]?.contactId).toBe(contact.id);

    expect(await membershipsIn(RECONCILE_BUCKET_ID, stillActive)).toHaveLength(
      0,
    );
  });
});
