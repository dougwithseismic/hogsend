/**
 * PRD 05 T5 — the bucket subsystem reads membership and criteria BY SUBJECT.
 *
 * Two behaviours, pulling in opposite directions — which is the point. One says
 * "reach further", the other says "reach no further than you did yesterday",
 * and a flip that gets either half wrong fails exactly one of them:
 *
 *   (a) DIVERGENT KEY — a bucket entered during the anonymous era, whose
 *       membership and events were then ADOPTED onto a contact registered under
 *       a different canonical key. `bucket.has(currentKey)` must be true, and
 *       the reconcile cron must SEE that member (it evaluates them) and KEEP
 *       them. Reading `bucket_memberships.user_id` answers "not a member" and
 *       the cron cannot see the row at all — the person is in the bucket, every
 *       accessor says they are not, and their membership can never end.
 *
 *   (b) D8 COHORT PRESERVATION — the backfill's matcher selection joined
 *       `contacts.external_id`, which has never materialized an email-only or
 *       anonymous contact (their `external_id` is NULL). Flipping that join to
 *       `user_events.contact_id` would silently admit that whole cohort and
 *       move every bucket's count on a release billed as a read flip. The
 *       count must be IDENTICAL on identical data, with the email-only contact
 *       still excluded — and the fixture below contains one that matches the
 *       criteria on every axis except the one being held.
 *
 * Why (a)'s fixture stamps `contact_id` with a raw UPDATE instead of calling
 * `resolveOrCreateContact`: adoption today does BOTH halves — it stamps
 * `contact_id` AND rewrites `user_id` onto the new canonical key — so a
 * resolve-driven fixture leaves the rows reachable by the string key and the
 * flip becomes unobservable (a test that certifies rather than tests). The
 * UPDATE is PRD 05 D4's adoption statement verbatim
 * (`SET contact_id = :id WHERE user_id = :fromKey AND contact_id IS NULL`) —
 * the shape T9 makes permanent once the string rewrite is deleted.
 *
 * Fixture law: every identity value is run-namespaced, nothing is asserted
 * against a whole-table count, and no fixture is "owned-but-NULL" (a row whose
 * `user_id` resolves to a live contact while `contact_id` is NULL — another
 * file in this suite runs a global backfill sweep that stamps exactly those
 * mid-run). The stale keys below are owned by NO contact, so nothing can stamp
 * them out from under the fixture.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

// DB-touching test. The DEFAULT below is the repo-wide one every file in this
// directory shares, and it is what CI's service container listens on. Point a
// worktree at its own stack by exporting HOGSEND_TEST_DATABASE_URL — never by
// editing the default.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Dual mock: the reconcile + backfill tasks are BUILT inside @hogsend/engine
// against the ENGINE's own `lib/hatchet.js`, so both that path and the API's
// must be mocked. The mock PRESERVES `config` so `.fn` survives and the task
// bodies can be invoked directly without a live gRPC engine.
const hatchetMock = () => ({
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
    events: { push: vi.fn(async () => {}) },
    runs: { cancel: vi.fn(async () => {}), get: vi.fn() },
    worker: vi.fn(),
  },
});
vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

const { bucketConfigs, bucketMemberships, contacts, importJobs, userEvents } =
  await import("@hogsend/db");
const { and, eq, inArray, isNull, like } = await import("drizzle-orm");
const {
  bucketBackfillTask,
  bucketReconcileTask,
  computeCriteriaHash,
  createHogsendClient,
  days,
  defineBucket,
  resetBucketRegistry,
  resolveOrCreateContact,
} = await import("@hogsend/engine");

const container = createHogsendClient();
const { db } = container;

// The mocks preserved each task's `config`, so `.fn` is the real body. Both
// self-bootstrap their own db from process.env and read the process
// bucket-registry singleton — all installed by `createHogsendClient` below.
const reconcileTask = bucketReconcileTask as unknown as {
  fn: () => Promise<{ reconciled: number; joined: number }>;
};
const backfillTask = bucketBackfillTask as unknown as {
  fn: (input: {
    jobId: string;
    bucketId: string;
    mode: "first-time" | "reeval";
  }) => Promise<{ status: string; joined?: number }>;
};

const RUN = `t5flip-${randomUUID()}`;
const uid = (label: string) => `${RUN}-${label}`;

const DAY = 24 * 60 * 60 * 1000;

// (a) — the anon-era key the membership and events were written under, the
// post-registration canonical key, and the bucket.
const A_ANON = uid("a-anon");
const A_USER = uid("a-user");
const A_BUCKET = uid("a-bucket");
const A_EVENT = `${RUN}:a.active`;

// (b) — the D8 cohort fixture: one external-id contact (materialized today) and
// one email-only contact (excluded today) with identical qualifying history.
const B_BUCKET = uid("b-bucket");
const B_EVENT = `${RUN}:b.action`;
const B_EXTERNAL = uid("b-external");

const createdContactIds: string[] = [];

afterAll(async () => {
  resetBucketRegistry();
  await db
    .delete(bucketMemberships)
    .where(inArray(bucketMemberships.bucketId, [A_BUCKET, B_BUCKET]));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  await db
    .delete(bucketConfigs)
    .where(inArray(bucketConfigs.bucketId, [A_BUCKET, B_BUCKET]));
  await db.delete(importJobs).where(like(importJobs.fileName, `${RUN}-%`));
  if (createdContactIds.length > 0) {
    await db
      .delete(userEvents)
      .where(inArray(userEvents.contactId, createdContactIds));
    await db.delete(contacts).where(inArray(contacts.id, createdContactIds));
  }
});

/**
 * Persist a bucket's criteriaHash so `firstTimeBackfillIncomplete` returns
 * false, mirroring the real lifecycle where the backfill settles before the
 * cron's leave pass may act.
 */
async function settleBackfill(
  bucket: ReturnType<typeof defineBucket>,
): Promise<void> {
  const hash = computeCriteriaHash(bucket.meta.criteria);
  await db
    .insert(bucketConfigs)
    .values({ bucketId: bucket.meta.id, criteriaHash: hash })
    .onConflictDoUpdate({
      target: bucketConfigs.bucketId,
      set: { criteriaHash: hash, updatedAt: new Date() },
    });
}

/** D4's adoption statement verbatim — stamps the owner, never the string key. */
async function adoptHistory(fromKey: string, contactId: string): Promise<void> {
  await db
    .update(userEvents)
    .set({ contactId })
    .where(and(eq(userEvents.userId, fromKey), isNull(userEvents.contactId)));
  await db
    .update(bucketMemberships)
    .set({ contactId })
    .where(
      and(
        eq(bucketMemberships.userId, fromKey),
        isNull(bucketMemberships.contactId),
      ),
    );
}

describe("T5 — bucket membership follows the CONTACT across a key divergence", () => {
  it("stays a member, and stays visible to reconcile, when the membership sits under an adopted anon key", async () => {
    // A composite criterion: an event leg (read by subject) AND a property leg
    // (read off the joined contact row). Composite routes the reconcile leave
    // pass through `reconcileCompositeLeaves`, which bumps `lastEvaluatedAt`
    // for EVERY member it evaluates — the observable proof below that the cron
    // actually SAW this member rather than silently skipping a row it could not
    // join.
    const bucket = defineBucket({
      meta: {
        id: A_BUCKET,
        name: "Recently active pro (composite)",
        enabled: true,
        timeBased: true,
        criteria: (b) =>
          b.all(
            b.event(A_EVENT).within(days(30)).exists(),
            b.prop("plan").eq("pro"),
          ),
      },
    });
    createHogsendClient({ buckets: [bucket] });
    await settleBackfill(bucket);

    // (1) The anonymous era. No contact exists for A_ANON — the engine refuses
    // to mint one on observation — so both the qualifying event and the
    // membership are contactless.
    await db.insert(userEvents).values({
      userId: A_ANON,
      event: A_EVENT,
      properties: {},
      occurredAt: new Date(Date.now() - DAY),
    });
    const [membership] = await db
      .insert(bucketMemberships)
      .values({
        userId: A_ANON,
        userEmail: null,
        bucketId: A_BUCKET,
        status: "active",
        source: "event",
        entryCount: 1,
        enteredAt: new Date(Date.now() - 10 * DAY),
        lastEvaluatedAt: new Date(Date.now() - 5 * DAY),
      })
      .returning({
        id: bucketMemberships.id,
        lastEvaluatedAt: bucketMemberships.lastEvaluatedAt,
      });
    if (!membership)
      throw new Error("bucketMemberships insert returned no row");

    // (2) Registration mints the contact under a DIFFERENT canonical key...
    const contact = await resolveOrCreateContact({ db, userId: A_USER });
    createdContactIds.push(contact.id);
    // ...carrying the property the criteria's property leg reads.
    await db
      .update(contacts)
      .set({ properties: { plan: "pro" } })
      .where(eq(contacts.id, contact.id));
    // ...and adoption stamps the anon-era history onto it WITHOUT rewriting
    // `user_id`. From here the rows are reachable ONLY by `contact_id`.
    await adoptHistory(A_ANON, contact.id);

    // (3) THE ACCESSOR. `has()` is asked under the contact's CURRENT key, and
    // the row it must find is keyed on the stale one. A `user_id = A_USER`
    // probe returns false, and every gate built on `bucket.has(...)` silently
    // opens for someone who IS in the bucket.
    const { data: isMember, error: hasError } = await bucket.has(A_USER);
    expect(hasError).toBeNull();
    expect(isMember).toBe(true);

    // ...and `count()` agrees: exactly this one member, scoped to this bucket.
    const { data: counted } = await bucket.count();
    expect(counted).toBe(1);

    // (4) THE CRON. The member still satisfies both legs, so the sweep must
    // evaluate them and keep them. `lastEvaluatedAt` advancing is what
    // separates "kept because it was seen and still matches" from "kept because
    // the join could not reach the row" — the two are indistinguishable on
    // status alone, and only the first is the behaviour being pinned.
    await reconcileTask.fn();

    const [after] = await db
      .select({
        status: bucketMemberships.status,
        lastEvaluatedAt: bucketMemberships.lastEvaluatedAt,
        userId: bucketMemberships.userId,
      })
      .from(bucketMemberships)
      .where(eq(bucketMemberships.id, membership.id));

    expect(after?.status).toBe("active");
    expect(after?.userId).toBe(A_ANON);
    expect(after?.lastEvaluatedAt?.getTime() ?? 0).toBeGreaterThan(
      membership.lastEvaluatedAt?.getTime() ?? 0,
    );
  });
});

describe("T5 — D8: the flip does not widen the materialized cohort", () => {
  it("backfills the external-id contact and still excludes the email-only one", async () => {
    // A count criterion, so the backfill takes `selectEventMatchers`' exists /
    // count branch — the join D8 is about.
    const bucket = defineBucket({
      meta: {
        id: B_BUCKET,
        name: "Power users (count)",
        enabled: true,
        timeBased: true,
        criteria: (b) => b.event(B_EVENT).within(days(30)).atLeast(3),
      },
    });
    createHogsendClient({ buckets: [bucket] });

    // The contact that IS materialized today: canonical key == external_id.
    const external = await resolveOrCreateContact({ db, userId: B_EXTERNAL });
    createdContactIds.push(external.id);

    // The contact that is NOT: `external_id` NULL, so its canonical key is its
    // own uuid. Its history is otherwise identical — same event, same count,
    // same window — so the ONLY thing keeping it out is the cohort guard.
    const [emailOnly] = await db
      .insert(contacts)
      .values({
        externalId: null,
        email: `${uid("b-email-only")}@flip.test`,
        properties: {},
      })
      .returning({ id: contacts.id });
    if (!emailOnly) throw new Error("contacts insert returned no row");
    createdContactIds.push(emailOnly.id);

    // Three qualifying events each, dual-written with the owning contact
    // exactly as `ingestEvent` writes them.
    await db.insert(userEvents).values(
      [
        { userKey: B_EXTERNAL, contactId: external.id },
        { userKey: emailOnly.id, contactId: emailOnly.id },
      ].flatMap((subject) =>
        Array.from({ length: 3 }, (_, i) => ({
          userId: subject.userKey,
          event: B_EVENT,
          properties: {},
          contactId: subject.contactId,
          occurredAt: new Date(Date.now() - (i + 1) * DAY),
        })),
      ),
    );

    const [job] = await db
      .insert(importJobs)
      .values({
        fileName: B_BUCKET,
        format: "bucket-backfill",
        status: "pending",
      })
      .returning({ id: importJobs.id });
    if (!job) throw new Error("importJobs insert returned no row");

    const result = await backfillTask.fn({
      jobId: job.id,
      bucketId: B_BUCKET,
      mode: "first-time",
    });
    expect(result.status).toBe("completed");

    // THE D8 ASSERTION. Both contacts match the criteria on every axis; only
    // the external-id one has ever been materialized, and the flip must not
    // change that. A flip that dropped the cohort guard reports 2 here — a
    // count that moved on a release that promised not to move it.
    const { data: counted } = await bucket.count();
    expect(counted).toBe(1);

    const members = await db
      .select({
        userId: bucketMemberships.userId,
        contactId: bucketMemberships.contactId,
      })
      .from(bucketMemberships)
      .where(eq(bucketMemberships.bucketId, B_BUCKET));
    expect(members).toHaveLength(1);
    expect(members[0]?.userId).toBe(B_EXTERNAL);
    // ...and the row the flip DOES depend on: the membership carries its owner,
    // so every downstream read can find it by subject.
    expect(members[0]?.contactId).toBe(external.id);
  });
});
