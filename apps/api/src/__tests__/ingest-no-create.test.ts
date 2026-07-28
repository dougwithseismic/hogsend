import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// DB-touching test. The DEFAULT below is the repo-wide one every file in this
// directory shares, and it is what CI's service container listens on. Point a
// worktree at its own stack by exporting HOGSEND_TEST_DATABASE_URL — never by
// editing the default.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Mock Hatchet: `ingestEvent` pushes every event and rethrows on a failed push,
// and the bucket transition re-ingests through the same spy. The push payload is
// also the ASSERTION SURFACE for site 2 (the `contactId` key must be OMITTED,
// never sent as JSON null, on a contactless ingest).
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

const { bucketMemberships, contacts, conversions, journeyStates, userEvents } =
  await import("@hogsend/db");
const { and, eq, like, or } = await import("drizzle-orm");
const {
  JourneyRegistry,
  createHogsendClient,
  defineBucket,
  defineConversion,
  hatchet,
  ingestEvent,
  ingestTransformResult,
  resetBucketRegistry,
} = await import("@hogsend/engine");

const RUN = `ingnc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const uid = (label: string) => `${RUN}-${label}`;

// An event-EXISTENCE bucket: no property predicate, so evaluation never needs a
// `contacts` row. `bucket_memberships` is text-keyed on the canonical key with
// NO contact FK, which is exactly why a contactless ingest must STILL evaluate
// buckets (D2) rather than skipping them.
const BUCKET_ID = uid("signed-up");
const BUCKET_EVENT = `${RUN}:signup`;
const signupBucket = defineBucket({
  meta: {
    id: BUCKET_ID,
    name: "Signed up",
    enabled: true,
    criteria: { type: "event", eventName: BUCKET_EVENT, check: "exists" },
  },
});

// A conversion whose trigger a contactless ingest matches. `conversions.
// contact_id` is a `.notNull()` FK, so there is no degraded write available and
// the whole block must be SKIPPED (D9) — cleanly, not by throwing into the
// hook's own catch (which the no-warn assertion below pins down).
const CONVERSION_ID = uid("checkout");
const CONVERSION_EVENT = `${RUN}:checkout`;
const checkoutConversion = defineConversion({
  id: CONVERSION_ID,
  name: "Checkout",
  trigger: { event: CONVERSION_EVENT },
  sources: "any",
});

const container = createHogsendClient({
  buckets: [signupBucket],
  conversions: [checkoutConversion],
});
const { db, registry, logger } = container;

/** Every live-or-dead contact row owning `key` as EITHER identity key. */
async function contactsForKey(key: string) {
  return db
    .select({
      id: contacts.id,
      externalId: contacts.externalId,
      anonymousId: contacts.anonymousId,
      source: contacts.source,
    })
    .from(contacts)
    .where(or(eq(contacts.externalId, key), eq(contacts.anonymousId, key)));
}

async function eventsForKey(key: string) {
  return db
    .select({ id: userEvents.id, event: userEvents.event })
    .from(userEvents)
    .where(eq(userEvents.userId, key));
}

/** The payload of the LAST Hatchet push for `eventName`. */
function lastPushPayload(eventName: string): Record<string, unknown> {
  const calls = enginePushSpy.mock.calls.filter(
    (call) => call[0] === eventName,
  );
  const last = calls.at(-1);
  if (!last) throw new Error(`no Hatchet push recorded for "${eventName}"`);
  return last[1] as Record<string, unknown>;
}

beforeEach(() => {
  enginePushSpy.mockClear();
});

afterAll(async () => {
  resetBucketRegistry();
  await db
    .delete(conversions)
    .where(eq(conversions.definitionId, CONVERSION_ID));
  await db
    .delete(bucketMemberships)
    .where(like(bucketMemberships.userId, `${RUN}-%`));
  await db.delete(journeyStates).where(like(journeyStates.userId, `${RUN}-%`));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}-%`));
  // Both legs: a regression that mints the ghost stamps `external_id`, while the
  // creating controls carry `anonymous_id`. Neither may be left behind.
  await db.delete(contacts).where(like(contacts.anonymousId, `${RUN}-%`));
});

// ===========================================================================
// The spine: a refused ingest still observes everything, and mints nothing.
// ===========================================================================
describe("ingestEvent with allowCreate: false", () => {
  it("stores the event under the anon key and mints NO contact", async () => {
    const anon = uid("store-anon");

    const result = await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      allowCreate: false,
      event: {
        event: `${RUN}.observed`,
        anonymousId: anon,
        eventProperties: { seen: true },
        source: "api",
      },
    });

    expect(result.stored).toBe(true);
    // The refusal key is the key the create arm would have made canonical, so
    // history is written under exactly the same string as before (D2).
    expect(result.contactKey).toBe(anon);

    const events = await eventsForKey(anon);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe(`${RUN}.observed`);

    // The load-bearing assertion: ZERO contacts, not merely a null id.
    expect(await contactsForKey(anon)).toHaveLength(0);
  });

  it("pushes to Hatchet WITHOUT a contactId key (site 2)", async () => {
    const anon = uid("push-anon");

    await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      allowCreate: false,
      event: {
        event: `${RUN}.pushed`,
        anonymousId: anon,
        eventProperties: {},
        source: "api",
      },
    });

    const payload = lastPushPayload(`${RUN}.pushed`);
    expect(payload.userId).toBe(anon);
    // NOT `toBeUndefined()` — a JSON `null` on the journey wire would satisfy
    // that while still travelling down to `execute-journey-run`, whose fallback
    // is `contact?.id`. The key must be ABSENT.
    expect(Object.hasOwn(payload, "contactId")).toBe(false);
  });

  it("still carries contactId on a creating ingest (the control)", async () => {
    const anon = uid("push-control");

    await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event: `${RUN}.pushed`,
        anonymousId: anon,
        eventProperties: {},
        source: "api",
      },
    });

    const payload = lastPushPayload(`${RUN}.pushed`);
    expect(Object.hasOwn(payload, "contactId")).toBe(true);
    expect(typeof payload.contactId).toBe("string");
  });

  it("still evaluates exit conditions", async () => {
    const anon = uid("exit-anon");
    const journeyId = uid("exit-journey");
    const exitEvent = `${RUN}.exiter`;

    const exitRegistry = new JourneyRegistry();
    exitRegistry.register({
      id: journeyId,
      name: "Exits on demand",
      enabled: true,
      trigger: { event: `${RUN}.enroller` },
      entryLimit: "unlimited",
      suppress: {},
      exitOn: [{ event: exitEvent }],
    });

    const [state] = await db
      .insert(journeyStates)
      .values({
        userId: anon,
        userEmail: `${anon}@example.test`,
        journeyId,
        currentNodeId: "start",
        status: "active",
      })
      .returning({ id: journeyStates.id });
    if (!state) throw new Error("journeyStates insert returned no row");

    const result = await ingestEvent({
      db,
      registry: exitRegistry,
      hatchet,
      logger,
      allowCreate: false,
      event: {
        event: exitEvent,
        anonymousId: anon,
        eventProperties: {},
        source: "api",
      },
    });

    expect(result.exits).toEqual([
      { journeyId, stateId: state.id, exited: true },
    ]);
    const [after] = await db
      .select({ status: journeyStates.status })
      .from(journeyStates)
      .where(eq(journeyStates.id, state.id));
    expect(after?.status).toBe("exited");

    expect(await contactsForKey(anon)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Site 8 — the dangerous one. Bucket evaluation must STILL RUN (the
  // membership table is text-keyed, no contact FK), and the transition
  // re-ingest must INHERIT the refusal. The `contactId ?? undefined` degrade
  // would mint an `external_id = <anonId>` phantom — a ghost strictly WORSE
  // than the one being removed, because `collidesWithIdentified` then 403-locks
  // the visitor out of their own feed.
  // -------------------------------------------------------------------------
  it("trips an event bucket, stores bucket:entered, and STILL mints no contact", async () => {
    const anon = uid("bucket-anon");

    await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      allowCreate: false,
      event: {
        event: BUCKET_EVENT,
        anonymousId: anon,
        eventProperties: {},
        source: "api",
      },
    });

    // (a) The bucket actually evaluated and joined.
    const membership = await db.query.bucketMemberships.findFirst({
      where: and(
        eq(bucketMemberships.userId, anon),
        eq(bucketMemberships.bucketId, BUCKET_ID),
        eq(bucketMemberships.status, "active"),
      ),
    });
    expect(membership).toBeDefined();

    // (b) The transition event was re-ingested and STORED. Asserting only the
    // contact count would let a "skip buckets entirely" implementation pass.
    const events = await eventsForKey(anon);
    expect(events.map((e) => e.event)).toContain(`bucket:entered:${BUCKET_ID}`);

    // (c) …and the re-ingest minted nothing. A phantom would carry
    // `source: "bucket"` and `external_id = anon` — the #608 fingerprint.
    expect(await contactsForKey(anon)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Sites 5/6/7 — D9. `conversions.contact_id` is a `.notNull()` FK and
  // `packages/db` is out of boundary, so the block is skipped outright. The
  // no-warn assertion is what keeps this test honest: without the guard the
  // insert violates NOT NULL, the hook's own try/catch swallows it, and the
  // row count would be zero ANYWAY.
  // -------------------------------------------------------------------------
  it("records no conversion, and does not fail into the hook's catch (D9)", async () => {
    const anon = uid("conv-anon");
    const warnSpy = vi.spyOn(logger, "warn");

    await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      allowCreate: false,
      event: {
        event: CONVERSION_EVENT,
        anonymousId: anon,
        eventProperties: {},
        value: 4200,
        currency: "GBP",
        source: "api",
      },
    });

    const fired = await db
      .select({ id: conversions.id })
      .from(conversions)
      .where(eq(conversions.definitionId, CONVERSION_ID));
    expect(fired).toHaveLength(0);

    const conversionWarns = warnSpy.mock.calls.filter(
      (call) => String(call[0]) === "Conversion evaluation failed",
    );
    expect(conversionWarns).toHaveLength(0);
    warnSpy.mockRestore();

    expect(await contactsForKey(anon)).toHaveLength(0);
  });

  it("fires that same conversion when creation IS allowed (the control)", async () => {
    const anon = uid("conv-control");

    await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event: CONVERSION_EVENT,
        anonymousId: anon,
        eventProperties: {},
        value: 4200,
        currency: "GBP",
        source: "api",
      },
    });

    const fired = await db
      .select({ userKey: conversions.userKey })
      .from(conversions)
      .where(eq(conversions.definitionId, CONVERSION_ID));
    expect(fired).toHaveLength(1);
    expect(fired[0]?.userKey).toBe(anon);
  });

  it("keeps creating when allowCreate is omitted (default true)", async () => {
    const anon = uid("default-anon");

    await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event: `${RUN}.default`,
        anonymousId: anon,
        eventProperties: {},
        source: "api",
      },
    });

    expect(await contactsForKey(anon)).toHaveLength(1);
  });
});

// ===========================================================================
// `ingestTransformResult` — a PER-CALL pass-through, never a default flip:
// `routes/webhooks/sources.ts` shares this helper and webhook sources stay
// creating.
// ===========================================================================
describe("ingestTransformResult allowCreate pass-through", () => {
  it("forwards allowCreate: false to every element", async () => {
    const a = uid("xf-a");
    const b = uid("xf-b");

    const r = await ingestTransformResult({
      result: [
        { event: `${RUN}.xf`, anonymousId: a, eventProperties: {} },
        { event: `${RUN}.xf`, anonymousId: b, eventProperties: {} },
      ],
      db,
      registry,
      hatchet,
      logger,
      source: "api",
      allowCreate: false,
    });

    expect(r.ingested).toBe(2);
    expect(await eventsForKey(a)).toHaveLength(1);
    expect(await eventsForKey(b)).toHaveLength(1);
    expect(await contactsForKey(a)).toHaveLength(0);
    expect(await contactsForKey(b)).toHaveLength(0);
  });

  it("defaults to creating (webhook sources are unaffected)", async () => {
    const c = uid("xf-c");

    await ingestTransformResult({
      result: { event: `${RUN}.xf`, anonymousId: c, eventProperties: {} },
      db,
      registry,
      hatchet,
      logger,
      source: "api",
    });

    expect(await contactsForKey(c)).toHaveLength(1);
  });
});
