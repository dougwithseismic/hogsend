/**
 * D11 category (iii) — the fast-expiry bucket timer.
 *
 * PRD 01 threaded the inherited `allowCreate` refusal into
 * `emitBucketTransition`, which covers the two SYNCHRONOUS transition emits
 * (`handleJoin` / `handleLeave`). It did NOT thread it into `armExpiryTimer`,
 * the third producer: a `fastExpiry` bucket's join pushes a `bucket:arm-expiry`
 * Hatchet event, and the shared `bucketExpiryTask` wakes later, flips the row,
 * and emits `bucket:left:<id>` from a payload that carried no verdict at all.
 * With no `contactId` (correctly withheld — a public-forgeable payload cannot
 * carry unforgeable provenance) and no `allowCreate`, that emit re-resolves the
 * subject's canonical key create-on-miss, `findByKey` reads a bare `userId` as
 * kind "external", and the create arm mints `external_id = <anonId>` — the
 * ghost that then makes `collidesWithIdentified` true and 403-locks the visitor
 * out of their own bell.
 *
 * Reachable end to end: publishable anon-only event ⇒ `allowCreate: false` ⇒
 * `contactId` null ⇒ `checkBucketMembership` still runs (bucket eval needs no
 * contact row) ⇒ `handleJoin` ⇒ `armExpiryTimer` for a windowed fastExpiry
 * bucket. Both legs are proven here: the arm PAYLOAD carries the verdict, and
 * the woken task's leave emit mints nothing.
 *
 * The two sibling asynchronous producers need no equivalent test because they
 * are structurally unreachable for an anon-keyed member: every candidate query
 * in `bucket-reconcile.ts` and `bucket-backfill.ts` inner-joins `contacts` on
 * `contacts.external_id = bucket_memberships.user_id`, so an anon-keyed row is
 * never swept — and each of those producers carries a real pin anyway.
 */

process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Config-PRESERVING hatchet mock (the buckets.test.ts pattern): the arm event is
// pushed through the engine's module-level hatchet, and `bucketExpiryTask` is
// BUILT at import time by `hatchet.durableTask(...)`. Spreading `...config`
// keeps `bucketExpiryTask.fn` — the real task body — invokable from the test,
// while `events.push` is the single spy every emit funnels into.
const { enginePushSpy, hatchetMock } = vi.hoisted(() => {
  // Typed args so `mock.calls` is a (name, payload) tuple the assertions can
  // index — an argument-less `vi.fn()` types its calls as `[]`.
  const push = vi.fn(
    async (_name: string, _payload: Record<string, unknown>) => {},
  );
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
vi.mock("../../../../packages/engine/src/lib/hatchet.js", () => hatchetMock());

const { apiKeys, bucketMemberships, contacts, userEvents } = await import(
  "@hogsend/db"
);
const { and, eq, like, or, sql } = await import("drizzle-orm");
const {
  JourneyRegistry,
  buildBucketRegistry,
  bucketExpiryTask,
  checkBucketMembership,
  createApp,
  createHogsendClient,
  defineBucket,
  minutes,
  resetBucketRegistry,
  setBucketRegistry,
} = await import("@hogsend/engine");

const container = createHogsendClient();
const app = createApp(container);
const { db, logger } = container;

// The direct-seam stub: `checkBucketMembership` takes the Hatchet client as a
// parameter, so the arm push is observable without a live engine. Recorded as
// (name, payload) pairs so the assertion is on the WIRE shape, not on a spy's
// argument positions.
const armPushes: Array<{ name: string; payload: Record<string, unknown> }> = [];
const stubHatchet = {
  events: {
    push: async (name: string, payload: Record<string, unknown>) => {
      armPushes.push({ name, payload });
    },
  },
};

/** `bucket:arm-expiry` payloads only, oldest first. */
const armPayloads = () =>
  armPushes.filter((p) => p.name === "bucket:arm-expiry").map((p) => p.payload);

// `bucketExpiryTask.fn` is the real task body (the config-preserving mock kept
// it). It self-bootstraps its db from process.env.DATABASE_URL and reads the
// bucket + journey registry singletons, both installed below.
const expiryTask = bucketExpiryTask as unknown as {
  fn: (
    input: Record<string, unknown>,
    ctx: { sleepFor: (d: string) => Promise<unknown> },
  ) => Promise<{ status: string; reason?: string; rowId?: string }>;
};

const RUN = `d11fx-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const uid = (label: string) => `${RUN}-${label}`;

const PK_KEY = `pk_test_${RUN}_publishable`;
const ORIGIN = "https://app.example.com";
const PK_HEADERS = {
  Authorization: `Bearer ${PK_KEY}`,
  "Content-Type": "application/json",
  Origin: ORIGIN,
};

const hashKey = (raw: string) => createHash("sha256").update(raw).digest("hex");
const createdKeyIds: string[] = [];

// A WINDOWED fastExpiry bucket — the window is what gives `computeExpiresAt` a
// deadline, and a deadline is the precondition for arming at all.
const PULSE_EVENT = `${RUN}.pulse`;
const FAST_BUCKET_ID = `${RUN}-recently-pulsed`;
const fastBucket = defineBucket({
  meta: {
    id: FAST_BUCKET_ID,
    name: "Recently pulsed (fast expiry)",
    enabled: true,
    fastExpiry: true,
    criteria: (b) => b.event(PULSE_EVENT).within(minutes(5)).exists(),
  },
});

beforeAll(async () => {
  setBucketRegistry(buildBucketRegistry([fastBucket], "*"));
  const [pkRow] = await db
    .insert(apiKeys)
    .values({
      name: `${RUN} publishable`,
      keyPrefix: PK_KEY.slice(0, 8),
      keyHash: hashKey(PK_KEY),
      scopes: ["ingest-public"],
      allowedOrigins: [ORIGIN],
    })
    .returning({ id: apiKeys.id });
  if (pkRow) createdKeyIds.push(pkRow.id);
});

afterAll(async () => {
  resetBucketRegistry();
  await db
    .delete(bucketMemberships)
    .where(like(bucketMemberships.userId, `${RUN}-%`));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  // A regression stamps `external_id`; the creating control stamps `email`.
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.anonymousId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.email, `${RUN}-%`));
  for (const id of createdKeyIds) {
    await db.delete(apiKeys).where(eq(apiKeys.id, id));
  }
});

/** Every live contact row owning `key` as EITHER canonical identity key. */
async function contactsForKey(key: string) {
  return db
    .select({
      id: contacts.id,
      externalId: contacts.externalId,
      anonymousId: contacts.anonymousId,
    })
    .from(contacts)
    .where(or(eq(contacts.externalId, key), eq(contacts.anonymousId, key)));
}

/** Store the criteria-satisfying event directly (no ingest, no resolve). */
/**
 * PRD 05 T5 evaluates bucket criteria BY SUBJECT, so an event seeded for a
 * subject that HAS a contact must carry the owner exactly as `ingestEvent`'s
 * dual-write does. A NULL `contact_id` here describes a pre-PRD-04 row; the
 * anon fixtures below own no contact, so they stamp NULL correctly.
 */
async function seedPulse(userId: string): Promise<void> {
  const [owner] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      sql`coalesce(${contacts.externalId}, ${contacts.anonymousId}, ${contacts.id}::text) = ${userId}`,
    )
    .limit(1);
  await db.insert(userEvents).values({
    userId,
    event: PULSE_EVENT,
    properties: {},
    source: "test",
    contactId: owner?.id ?? null,
    occurredAt: new Date(),
  });
}

// ===========================================================================
// Leg 1 — the arm PAYLOAD carries the inherited verdict.
// ===========================================================================
describe("D11 (iii) — the bucket:arm-expiry payload", () => {
  it("carries allowCreate: false when the originating ingest refused", async () => {
    const anon = uid("armed-refused");
    await seedPulse(anon);
    armPushes.length = 0;

    await checkBucketMembership({
      db,
      registry: new JourneyRegistry(),
      // biome-ignore lint/suspicious/noExplicitAny: stubbed hatchet client
      hatchet: stubHatchet as any,
      logger,
      userId: anon,
      // EXACTLY what `ingestEvent` threads for a refused event: no `contactId`
      // key at all, and the refusal in its place.
      allowCreate: false,
      userEmail: null,
      event: PULSE_EVENT,
      eventProperties: {},
    });

    const [payload] = armPayloads();
    expect(payload).toBeDefined();
    expect(payload?.bucketId).toBe(FAST_BUCKET_ID);
    expect(payload?.allowCreate).toBe(false);
  });

  it("omits allowCreate entirely when the caller created", async () => {
    const named = uid("armed-created");
    const [row] = await db
      .insert(contacts)
      .values({
        externalId: named,
        email: `${named}@example.com`,
        properties: {},
      })
      .returning({ id: contacts.id });
    await seedPulse(named);
    armPushes.length = 0;

    await checkBucketMembership({
      db,
      registry: new JourneyRegistry(),
      // biome-ignore lint/suspicious/noExplicitAny: stubbed hatchet client
      hatchet: stubHatchet as any,
      logger,
      userId: named,
      // A resolved row → the pin, and NO verdict. The control against a
      // hardcoded `allowCreate: false`: an omitted key keeps today's
      // create-by-default semantics and keeps a JSON null off the wire.
      contactId: row?.id,
      userEmail: `${named}@example.com`,
      event: PULSE_EVENT,
      eventProperties: {},
    });

    const [payload] = armPayloads();
    expect(payload).toBeDefined();
    expect(payload && "allowCreate" in payload).toBe(false);
  });
});

// ===========================================================================
// Leg 2 — the woken timer's leave emit mints nothing.
// ===========================================================================
describe("D11 (iii) — the woken bucketExpiryTask", () => {
  it("mints no external_id ghost for a refused anonymous visitor", async () => {
    const anon = uid("expiry-anon");

    // The premise in PRODUCTION shape: a real publishable event for an unseen
    // anon id is pure observation, so it stores, joins the bucket, and mints
    // nothing.
    enginePushSpy.mockClear();
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: PK_HEADERS,
      body: JSON.stringify({ name: PULSE_EVENT, anonymousId: anon }),
    });
    expect(res.status).toBe(202);
    expect(await contactsForKey(anon)).toHaveLength(0);

    const membership = await db.query.bucketMemberships.findFirst({
      where: and(
        eq(bucketMemberships.userId, anon),
        eq(bucketMemberships.bucketId, FAST_BUCKET_ID),
        eq(bucketMemberships.status, "active"),
      ),
    });
    expect(membership).toBeDefined();

    // The arm the ingest actually pushed — carried verbatim into the task, so
    // the test drives the REAL wire payload rather than a hand-built one.
    const armed = enginePushSpy.mock.calls.find(
      (call) => call[0] === "bucket:arm-expiry",
    )?.[1] as Record<string, unknown> | undefined;
    expect(armed).toBeDefined();

    // Age the pulse past the 5-minute window so the task's on-wake criteria
    // re-confirm says "leave" — the deterministic stand-in for real elapsed
    // time (the durable sleep itself is stubbed).
    await db
      .update(userEvents)
      .set({ occurredAt: sql`now() - interval '10 minutes'` })
      .where(eq(userEvents.userId, anon));

    const result = await expiryTask.fn(armed as Record<string, unknown>, {
      sleepFor: async () => ({}),
    });
    expect(result.status).toBe("left");

    // The leave transition is stored and routed (D2 — observation is never
    // lost) but creates nothing. A missing verdict on the arm payload mints
    // `external_id = <anonId>` right here.
    const leaveEvents = await db
      .select({ event: userEvents.event })
      .from(userEvents)
      .where(
        and(
          eq(userEvents.userId, anon),
          eq(userEvents.event, `bucket:left:${FAST_BUCKET_ID}`),
        ),
      );
    expect(leaveEvents).toHaveLength(1);
    expect(await contactsForKey(anon)).toHaveLength(0);
  });
});
