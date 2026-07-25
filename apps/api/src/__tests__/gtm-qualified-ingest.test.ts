import { afterAll, beforeEach, expect, it, vi } from "vitest";

// DB-touching test. This worktree runs its OWN isolated stack (DECISIONS §4b) —
// 5438/6383. Never 5434: those containers belong to the main checkout.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5438/growthhog";

// Mock Hatchet: `ingestEvent` pushes every event to Hatchet and rethrows on a
// failed push. The spy stands in for a live gRPC engine.
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

const { bucketMemberships, contacts, userEvents } = await import("@hogsend/db");
const { and, eq, like, or } = await import("drizzle-orm");
const {
  buildBucketRegistry,
  createHogsendClient,
  getJourneyRegistrySingleton,
  hatchet,
  ingestEvent,
  resetBucketRegistry,
  setBucketRegistry,
} = await import("@hogsend/engine");
const { gtmQualified } = await import("../buckets/gtm-qualified.js");

// GOTCHA (PRD 07): `createHogsendClient` builds its OWN bucket registry from
// `opts.buckets` and calls `setBucketRegistry` itself. Set the registry BEFORE
// this line and it is silently clobbered — membership never fills, no error.
const container = createHogsendClient();
const { db, logger } = container;

const RUN = `gtmq-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const uid = (label: string) => `${RUN}-${label}`;

async function seedContact(label: string): Promise<string> {
  const userId = uid(label);
  await db.insert(contacts).values({
    externalId: userId,
    // `contacts.email` is UNIQUE — a RUN-namespaced address keeps a re-seed from
    // silently no-opping into another test's row.
    email: `${userId}@acme-gtm.test`,
    properties: {},
  });
  return userId;
}

/**
 * An ANONYMOUS-ONLY contact: `anonymous_id` set, `external_id` NULL. This is the
 * ordinary shape for a browser-SDK visitor who has never identified, and it is
 * the shape that exposes the phantom-twin defect — every other fixture in this
 * file seeds an `externalId`, which is exactly why the bug survived the first
 * green run.
 */
async function seedAnonContact(label: string) {
  const anonymousId = uid(label);
  const [row] = await db
    .insert(contacts)
    .values({ anonymousId, properties: {} })
    .returning({ id: contacts.id });
  if (!row) throw new Error("seedAnonContact: insert returned no row");
  return { anonymousId, contactId: row.id };
}

/**
 * Write a score exactly the way the nightly workflow does: through `ingestEvent`,
 * INCLUDING the `contactId` provenance pin. The pin is not incidental — see the
 * comment at the `ingestEvent` call in src/workflows/gtm-score.ts.
 */
async function writeScore(
  userId: string,
  gtmScore: number,
  contactId?: string,
) {
  await ingestEvent({
    db,
    registry: getJourneyRegistrySingleton(),
    hatchet,
    logger,
    event: {
      event: "gtm.scored",
      userId,
      contactId,
      eventProperties: { gtmScore },
      contactProperties: { gtmScore },
      source: "gtm-score",
    },
  });
}

async function membership(userId: string) {
  return db.query.bucketMemberships.findFirst({
    where: and(
      eq(bucketMemberships.userId, userId),
      eq(bucketMemberships.bucketId, "gtm-qualified"),
      eq(bucketMemberships.status, "active"),
    ),
  });
}

beforeEach(() => {
  enginePushSpy.mockClear();
  // GOTCHA (PRD 07): the second argument is the ENABLED-buckets filter
  // (`ENABLED_BUCKETS` semantics). Omit it and nothing is enabled, silently.
  setBucketRegistry(buildBucketRegistry([gtmQualified], "*"));
});

afterAll(async () => {
  resetBucketRegistry();
  await db
    .delete(bucketMemberships)
    .where(like(bucketMemberships.userId, `${RUN}-%`));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}-%`));
  // The anon-only fixtures carry no `external_id` — and if the provenance pin
  // ever regresses, the phantom twin they mint DOES. Both legs, so a failing run
  // does not leave rows behind.
  await db.delete(contacts).where(like(contacts.anonymousId, `${RUN}-%`));
});

// ---------------------------------------------------------------------------
// AC 3 — a recomputed score crossing 20 enters `gtm-qualified` WITHOUT the
// reconcile cron. The only thing that runs here is `ingestEvent`.
// ---------------------------------------------------------------------------

it("AC 3: `gtm-qualified` is NOT time-based, so the reconcile cron never evaluates it", () => {
  // Load-bearing: `bucketReconcileTask` deliberately skips non-time-based
  // buckets. Ingest is the ONLY thing that can ever flip this membership.
  expect(gtmQualified.meta.timeBased).not.toBe(true);
});

it("AC 3: a score below 20 does not enter the bucket", async () => {
  const userId = await seedContact("below");

  await writeScore(userId, 19);

  expect(await membership(userId)).toBeUndefined();
});

it("AC 3: a recomputed score crossing 20 enters gtm-qualified via ingestEvent alone", async () => {
  const userId = await seedContact("cross");

  await writeScore(userId, 12);
  expect(await membership(userId)).toBeUndefined();

  // The nightly recompute lands a higher score. No cron, no reconcile sweep.
  await writeScore(userId, 34);

  const row = await membership(userId);
  expect(row).toBeDefined();

  // The score survived the jsonb round-trip as a real JSON NUMBER (law 2) —
  // a stringified "34" would never have matched `gte(20)`.
  const contact = await db.query.contacts.findFirst({
    where: eq(contacts.externalId, userId),
  });
  expect(typeof contact?.properties?.gtmScore).toBe("number");
  expect(contact?.properties?.gtmScore).toBe(34);

  // The transition event fired on the outbound spine.
  expect(
    enginePushSpy.mock.calls.some(
      (call) => call[0] === "bucket:entered:gtm-qualified",
    ),
  ).toBe(true);
});

it("AC 3: a later score falling back under 20 leaves the bucket", async () => {
  const userId = await seedContact("fall");

  await writeScore(userId, 40);
  expect(await membership(userId)).toBeDefined();

  await writeScore(userId, 5);
  expect(await membership(userId)).toBeUndefined();
});

// ---------------------------------------------------------------------------
// The provenance pin. `user_key` is COALESCE(external_id, anonymous_id, id) but
// a bare `userId` resolves as an EXTERNAL key only — `resolveOrCreateContact`
// never probes `anonymous_id`. Without `contactId` the resolver mints a phantom
// twin and the real contact is never scored. Reproduced live before the fix.
// ---------------------------------------------------------------------------

it("scores an anonymous-only contact IN PLACE, on the real row", async () => {
  const { anonymousId, contactId } = await seedAnonContact("anon");

  // A score BELOW the bar, deliberately: this test isolates the score write.
  // Crossing the bar would fire a bucket transition, which re-ingests through a
  // separate engine path with its own (unfixed) defect — see the next test.
  await writeScore(anonymousId, 12, contactId);

  const real = await db.query.contacts.findFirst({
    where: eq(contacts.id, contactId),
  });

  // The score landed on the ROW WE MEANT. Drop the `contactId` argument above
  // and this is `{}`: the resolver never probes `anonymous_id`, so it mints a
  // separate `external_id` row and the real contact is never scored.
  expect(real?.properties?.gtmScore).toBe(12);
  // The pin resolves rather than value-links, so no synthetic `external_id` is
  // stamped onto the contact as a side effect of being scored.
  expect(real?.externalId).toBeNull();

  // And no second row was minted by the score write.
  const matching = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      or(
        eq(contacts.externalId, anonymousId),
        eq(contacts.anonymousId, anonymousId),
      ),
    );
  expect(matching).toHaveLength(1);
});

/**
 * KNOWN ENGINE DEFECT — pinned deliberately so the fix has a target and this
 * cannot be forgotten. NOT introduced by this release and NOT fixable inside
 * `apps/api`.
 *
 * `emitBucketTransition` (packages/engine/src/lib/bucket-emit.ts) re-ingests
 * every bucket transition through `ingestEvent` with `userId` + `userEmail` and
 * NO `contactId` pin. For a contact whose canonical key is its `anonymous_id`,
 * the resolver treats that key as an EXTERNAL one, finds nothing, and mints a
 * phantom twin — so a browser visitor who has never identified gets a duplicate
 * contact row the moment they enter ANY bucket. `power-users`, `went-dormant`
 * and `trial-expiring-soon` have the same exposure; this is not a GTM problem.
 *
 * The fix is to thread the resolved contact id through the seven
 * `emitBucketTransition` call sites in `check-membership`, `bucket-reconcile`
 * and `bucket-backfill`. That is an engine change with its own review surface,
 * tracked as PRD 11.
 *
 * WHEN THAT LANDS, THIS TEST WILL FAIL. That is the point: change
 * `toHaveLength(2)` to `toHaveLength(1)` and delete this block.
 */
it("KNOWN DEFECT (PRD 11): a bucket transition mints a phantom twin for an anonymous-only contact", async () => {
  const { anonymousId, contactId } = await seedAnonContact("anon-twin");

  // Crossing the bar fires `bucket:entered:gtm-qualified`, which re-ingests.
  await writeScore(anonymousId, 30, contactId);

  const matching = await db
    .select({
      id: contacts.id,
      externalId: contacts.externalId,
      anonymousId: contacts.anonymousId,
      source: contacts.source,
      properties: contacts.properties,
    })
    .from(contacts)
    .where(
      or(
        eq(contacts.externalId, anonymousId),
        eq(contacts.anonymousId, anonymousId),
      ),
    );

  expect(matching).toHaveLength(2);

  // The real row is correct — the score write's pin did its job.
  const real = matching.find((row) => row.id === contactId);
  expect(real?.properties?.gtmScore).toBe(30);
  expect(real?.externalId).toBeNull();

  // The twin is empty and stamped `source: "bucket"`, which names its producer.
  const twin = matching.find((row) => row.id !== contactId);
  expect(twin?.source).toBe("bucket");
  expect(twin?.externalId).toBe(anonymousId);
  expect(twin?.properties?.gtmScore).toBeUndefined();
});

it("an anonymous-only contact scored in place still enters gtm-qualified", async () => {
  const { anonymousId, contactId } = await seedAnonContact("anon-bucket");

  await writeScore(anonymousId, 30, contactId);

  // The membership is keyed by the contact's canonical key, which for this row
  // is its `anonymous_id` — the loop closes for anonymous visitors too.
  expect(await membership(anonymousId)).toBeDefined();
});

// ---------------------------------------------------------------------------
// Why the nightly write carries NO `idempotencyKey`. `ingestEvent` commits the
// contact-property patch in step (1) but returns early from the dedupe in step
// (4), BEFORE `checkBucketMembership` in step (6). A reused key therefore lands
// the score and silently skips the membership re-evaluation — and a pure `prop`
// bucket is invisible to the reconcile cron, so nothing heals it.
// ---------------------------------------------------------------------------

it("a reused idempotencyKey writes the score but SKIPS the bucket check", async () => {
  const userId = await seedContact("dedupe");
  const key = `${RUN}-dedupe-key`;

  await ingestEvent({
    db,
    registry: getJourneyRegistrySingleton(),
    hatchet,
    logger,
    event: {
      event: "gtm.scored",
      userId,
      eventProperties: { gtmScore: 40 },
      contactProperties: { gtmScore: 40 },
      source: "gtm-score",
      idempotencyKey: key,
    },
  });
  expect(await membership(userId)).toBeDefined();

  // Fall below the bar with a fresh key — the contact leaves, as it should.
  await writeScore(userId, 5);
  expect(await membership(userId)).toBeUndefined();

  // Now revisit 40 on the ALREADY-USED key. This is the trap: the property is
  // written, the dedupe returns `stored: false`, and step (6) never runs.
  await ingestEvent({
    db,
    registry: getJourneyRegistrySingleton(),
    hatchet,
    logger,
    event: {
      event: "gtm.scored",
      userId,
      eventProperties: { gtmScore: 40 },
      contactProperties: { gtmScore: 40 },
      source: "gtm-score",
      idempotencyKey: key,
    },
  });

  const contact = await db.query.contacts.findFirst({
    where: eq(contacts.externalId, userId),
  });
  expect(contact?.properties?.gtmScore).toBe(40);
  // Reads 40, absent from the bucket. This is why `gtm-score.ts` sends no key.
  expect(await membership(userId)).toBeUndefined();
});
