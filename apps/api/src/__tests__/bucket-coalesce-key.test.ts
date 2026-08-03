/**
 * Bucket cron join-key asymmetry.
 *
 * `bucket_memberships.user_id` holds the CANONICAL contact key
 * (`external_id ?? anonymous_id ?? id`), but every leave/dwell query joined
 * `contacts.external_id = bucket_memberships.user_id`. So a contact whose
 * canonical key is NOT its `external_id` — an email-only contact keyed on its
 * uuid, or an anonymous contact keyed on its `anonymous_id` — was invisible to
 * the cron: it could be ENROLLED (the join path already scans on the coalesce
 * key) but never left, never dwell-fired, never re-evaluated. A one-way door.
 *
 * The join side's own comment states the hazard verbatim — joining on
 * `contacts.externalId` "would silently drop exactly the dormant email-only
 * contacts this cron exists to reconcile". That fix was applied to the join
 * side and never to the leave side.
 *
 * Two behaviours are pinned here, and they pull in opposite directions:
 *
 *  1. VISIBILITY — an email-only member must now be seen by the dwell pass.
 *  2. NO STALE BURST — the cohort stranded while the join was wrong must NOT
 *     have its months-overdue age-driven emissions all fire on the first tick
 *     after the fix ships. A dwell reaction is a full journey
 *     (`buckets/bucket-reactions.ts` — same `(user, ctx)` shape as a journey
 *     `run`), so it can `sendEmail`. Firing the backlog would deliver
 *     months-old lifecycle mail to real inboxes — worse than the bug.
 *
 * The claim reconciles them: the first tick per bucket RESETS the cohort's
 * membership-age clocks to now rather than emitting or silently swallowing.
 * Nothing is lost — every age-driven emission still happens, on an honest
 * schedule.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Dual mock (mirrors bucket-dwell.test.ts): the reconcile task is BUILT inside
// @hogsend/engine against the ENGINE's own `lib/hatchet.js`, so both that path
// and the API's must be mocked. The mock PRESERVES `config` so
// `bucketReconcileTask.fn` survives and the cron body can be invoked directly.
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
const { and, eq, inArray, like, sql } = await import("drizzle-orm");
const {
  bucketReconcileTask,
  computeCriteriaHash,
  createHogsendClient,
  days,
  defineBucket,
  durationToMs,
  resetBucketRegistry,
} = await import("@hogsend/engine");

const container = createHogsendClient();
const { db } = container;

const reconcileTask = bucketReconcileTask as unknown as {
  fn: () => Promise<{ reconciled: number; joined: number }>;
};
const runReconcile = () => reconcileTask.fn();

const RUN = `bck-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const uid = (label: string) => `${RUN}-${label}`;

const DAY = 24 * 60 * 60 * 1000;
const seededContactIds: string[] = [];

/**
 * An EMAIL-ONLY contact: `external_id` NULL, so its canonical key is its own
 * uuid. This is the population the old `contacts.external_id` join could not
 * see. Returns that uuid — which is what the membership keys on.
 */
async function seedEmailOnlyContact(label: string): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({
      externalId: null,
      email: `${uid(label)}@coalesce.test`,
      properties: {},
    })
    .returning({ id: contacts.id });
  if (!row) throw new Error("failed to seed email-only contact");
  seededContactIds.push(row.id);
  return row.id;
}

/** An ANONYMOUS contact: canonical key is its `anonymous_id`. */
async function seedAnonKeyedContact(label: string): Promise<string> {
  const anonymousId = `${uid(label)}-anon`;
  const [row] = await db
    .insert(contacts)
    .values({ externalId: null, anonymousId, properties: {} })
    .returning({ id: contacts.id });
  if (!row) throw new Error("failed to seed anon-keyed contact");
  seededContactIds.push(row.id);
  return anonymousId;
}

/** An ordinary contact: canonical key IS its `external_id` (visible either way). */
async function seedExternalContact(label: string): Promise<string> {
  const externalId = uid(label);
  const [row] = await db
    .insert(contacts)
    .values({
      externalId,
      email: `${externalId}@coalesce.test`,
      properties: {},
    })
    .returning({ id: contacts.id });
  if (!row) throw new Error("failed to seed external contact");
  seededContactIds.push(row.id);
  return externalId;
}

/**
 * The contact a canonical key resolves to. PRD 05 T5 flipped every cron join
 * onto `bucket_memberships.contact_id`, and PRD 04 made a stamped id the
 * invariant for any membership whose subject has a contact — so the fixture
 * stamps it rather than describing a pre-04 row.
 */
async function contactIdFor(userKey: string): Promise<string | null> {
  const [row] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      sql`coalesce(${contacts.externalId}, ${contacts.anonymousId}, ${contacts.id}::text) = ${userKey}`,
    )
    .limit(1);
  return row?.id ?? null;
}

async function seedActiveMembership(opts: {
  userId: string;
  bucketId: string;
  ageMs: number;
}): Promise<void> {
  await db.insert(bucketMemberships).values({
    userId: opts.userId,
    userEmail: null,
    bucketId: opts.bucketId,
    status: "active",
    source: "reconcile",
    entryCount: 1,
    contactId: await contactIdFor(opts.userId),
    enteredAt: new Date(Date.now() - opts.ageMs),
    dwellState: {},
    lastEvaluatedAt: new Date(Date.now() - DAY),
  });
}

/** Satisfy the first-deploy quiet window (mirrors bucket-dwell.test.ts). */
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

function dwellPushCount(
  bucketId: string,
  label: string,
  userId: string,
): number {
  const name = `bucket:dwell:${bucketId}:${label}`;
  return pushSpy.mock.calls.filter(
    (c) =>
      c[0] === name &&
      (c[1] as { userId?: string } | undefined)?.userId === userId,
  ).length;
}

/** A dwell-only bucket: pure property criterion ⇒ not time-based, no maxDwell. */
function makeDwellBucket(id: string) {
  return defineBucket({
    meta: {
      id,
      name: "Coalesce-key dwell bucket",
      enabled: true,
      criteria: (b) => b.prop("plan").eq("x"),
    },
  });
}

beforeEach(() => {
  pushSpy.mockClear();
});

afterAll(async () => {
  resetBucketRegistry();
  // Memberships key on the CANONICAL key, which is the uuid only for the
  // email-only fixtures — the anon/external ones key on their own strings, so
  // sweep by both the id list and the run prefix.
  if (seededContactIds.length > 0) {
    await db
      .delete(bucketMemberships)
      .where(inArray(bucketMemberships.userId, seededContactIds));
    await db
      .delete(userEvents)
      .where(inArray(userEvents.userId, seededContactIds));
  }
  await db
    .delete(bucketMemberships)
    .where(like(bucketMemberships.userId, `${RUN}-%`));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  if (seededContactIds.length > 0) {
    await db.delete(contacts).where(inArray(contacts.id, seededContactIds));
  }
  await db
    .delete(bucketConfigs)
    .where(like(bucketConfigs.bucketId, `${RUN}-%`));
});

describe("cron sees members keyed on the canonical key, not just external_id", () => {
  it("an email-only member (uuid-keyed) is visible to the dwell pass", async () => {
    const bucketId = uid("visible");
    const bucket = makeDwellBucket(bucketId);
    bucket.on("dwell", { after: days(7) }, async () => {});
    const label = `after-${durationToMs(days(7))}`;

    createHogsendClient({ buckets: [bucket] });
    await settleBackfill(bucket);

    // Tick 1 with NO members: consumes this bucket's one-shot claim, so the
    // member seeded below is a NEW arrival on an already-claimed bucket — the
    // steady state, where a dwell fire is correct and expected.
    await runReconcile();

    const contactId = await seedEmailOnlyContact("visible-1");
    await seedActiveMembership({
      userId: contactId,
      bucketId,
      ageMs: 10 * DAY,
    });

    pushSpy.mockClear();
    await runReconcile();

    // THE REGRESSION ASSERTION. Under the old `contacts.external_id` join this
    // member is invisible and the count is 0.
    expect(dwellPushCount(bucketId, label, contactId)).toBe(1);
  });

  it("count() and has() agree with the members the reconcile pass acts on", async () => {
    // THE CONSISTENCY INVARIANT — the property that actually matters, and the
    // one that catches a scope split rather than a single bad join. Correcting
    // the cron without correcting the accessor would mean the cron acts on
    // members `count()`/`has()` cannot see: "Studio says 40 members but 55 got
    // the email". A per-site test would pass in that state; this one does not.
    const bucketId = uid("consistency");
    const bucket = makeDwellBucket(bucketId);
    bucket.on("dwell", { after: days(7) }, async () => {});
    const label = `after-${durationToMs(days(7))}`;

    createHogsendClient({ buckets: [bucket] });
    await settleBackfill(bucket);
    await runReconcile(); // consume the one-shot claim

    // One member per canonical-key SHAPE: uuid (email-only), anonymous_id, and
    // external_id. The last was always visible, so it pins that the fix widens
    // the set rather than swapping which rows are found.
    const keys = [
      await seedEmailOnlyContact("cons-email"),
      await seedAnonKeyedContact("cons-anon"),
      await seedExternalContact("cons-ext"),
    ];
    for (const key of keys) {
      await seedActiveMembership({ userId: key, bucketId, ageMs: 10 * DAY });
    }

    pushSpy.mockClear();
    await runReconcile();

    const actedOn = keys.reduce(
      (n, key) => n + dwellPushCount(bucketId, label, key),
      0,
    );
    const { data: counted } = await bucket.count();

    expect(actedOn).toBe(keys.length);
    expect(counted).toBe(actedOn);

    for (const key of keys) {
      const { data: present } = await bucket.has(key);
      expect(present).toBe(true);
    }
  });

  it("the stranded cohort does NOT fire its backlog on the first tick", async () => {
    const bucketId = uid("claim");
    const bucket = makeDwellBucket(bucketId);
    bucket.on("dwell", { after: days(7) }, async () => {});
    const label = `after-${durationToMs(days(7))}`;

    createHogsendClient({ buckets: [bucket] });
    await settleBackfill(bucket);

    // Stranded: enrolled 300 days ago, never evaluated (the join could not see
    // it). Without the claim this fires immediately — a 300-day-old nudge.
    const contactId = await seedEmailOnlyContact("claim-1");
    await seedActiveMembership({
      userId: contactId,
      bucketId,
      ageMs: 300 * DAY,
    });

    await runReconcile();

    expect(dwellPushCount(bucketId, label, contactId)).toBe(0);

    // Nothing swallowed: the age clock was RESET, so the fire is deferred to an
    // honest schedule rather than cancelled.
    const row = await db.query.bucketMemberships.findFirst({
      where: and(
        eq(bucketMemberships.userId, contactId),
        eq(bucketMemberships.bucketId, bucketId),
      ),
    });
    expect(row?.status).toBe("active");
    expect(row?.dwellAnchorAt).not.toBeNull();
    const anchorAge = Date.now() - new Date(row?.dwellAnchorAt ?? 0).getTime();
    expect(anchorAge).toBeLessThan(5 * 60 * 1000);

    // And the claim is ONE-SHOT: a second tick does not re-claim or emit.
    pushSpy.mockClear();
    await runReconcile();
    expect(dwellPushCount(bucketId, label, contactId)).toBe(0);
  });
});
