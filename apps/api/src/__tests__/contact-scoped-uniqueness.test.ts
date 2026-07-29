/**
 * PRD 05 T3 — contact-scoped uniqueness on the three "one live row per person"
 * tables (`journey_states`, `bucket_memberships`, `email_preferences`).
 *
 * ## The defect being fenced
 *
 * Adoption stamps `contact_id` WITHOUT rewriting `user_id`, so a row keyed by an
 * anon id and a row keyed by an external id can both become contact X and both
 * be live. The retained string-keyed indexes permit that; a `contact_id` read
 * then sees a double enrollment / double membership / two preference rows for
 * one address. Migration 0071 adds a contact-scoped PARTIAL unique index per
 * table to forbid it.
 *
 * ## THE TRAP THIS FILE EXISTS FOR (test group 1 in each section)
 *
 * Postgres unique indexes are NULLS DISTINCT by default, and every contactless
 * row — every anonymous visitor, a permanent supported state, since the engine
 * refuses to mint contacts on observation — carries `contact_id IS NULL`. So the
 * new indexes must leave that population alone, and the writers must keep their
 * STRING arbiters. Two ways to get it wrong, one test each:
 *
 *   (a) moving a writer's `ON CONFLICT` arbiter onto a bare
 *       `(contact_id, …)` target: it would never fire for NULL, so an anonymous
 *       re-trigger inserts a second row and dies on the retained string index;
 *   (b) declaring the new index NULLS NOT DISTINCT: it would collapse EVERY
 *       anonymous visitor into one row per journey/bucket/address.
 *
 * Both defects leave the IDENTIFIED tests (group 2) passing. That is exactly how
 * they would have shipped.
 *
 * ## Sweep law (contact-id-backfill.test.ts)
 *
 * No fixture here is ever "owned-but-NULL": contactless fixtures use `user_id`s
 * that own NO contact, and identified fixtures pass their `contactId` in
 * explicitly. Nothing in this file is a target for the global backfill sweep.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// DB-touching test. Point a worktree at its own stack with
// HOGSEND_TEST_DATABASE_URL — never by editing the default.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

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
        runNoWait: vi.fn(),
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

const {
  bucketMemberships,
  contactAliases,
  contacts,
  emailPreferences,
  journeyStates,
} = await import("@hogsend/db");
const { eq, like, or, sql } = await import("drizzle-orm");
const {
  buildBucketRegistry,
  checkBucketMembership,
  createApp,
  createHogsendClient,
  defineBucket,
  insertEnrollment,
  resetBucketRegistry,
  resolveOrCreateContact,
  setBucketRegistry,
} = await import("@hogsend/engine");

// `upsertEmailPreference` is engine-INTERNAL (not re-exported from
// @hogsend/engine), so it is loaded at runtime through Vite with a variable
// specifier — the contact-id-dualwrite-preferences idiom. A literal
// cross-package import would pull engine files into this package's TS program
// and trip rootDir (TS6059) under `tsc --noEmit`.
const preferencesModulePath = new URL(
  "../../../../packages/engine/src/lib/preferences.ts",
  import.meta.url,
).pathname;
const { upsertEmailPreference } = (await import(
  /* @vite-ignore */ preferencesModulePath
)) as {
  upsertEmailPreference: (opts: {
    db: unknown;
    externalId: string;
    email: string;
    update: Record<string, unknown>;
    contactId?: string | null;
    emitOutbound?: boolean;
  }) => Promise<void>;
};

// The precision gate for every catch-and-convert below. Engine-internal, so
// loaded through the same variable-specifier idiom.
const uniqueViolationModulePath = new URL(
  "../../../../packages/engine/src/lib/unique-violation.ts",
  import.meta.url,
).pathname;
const {
  isUniqueViolationOn,
  UQ_CONTACT_EMAIL_PREFERENCES,
  UQ_CONTACT_JOURNEY_ACTIVE,
} = (await import(/* @vite-ignore */ uniqueViolationModulePath)) as {
  isUniqueViolationOn: (err: unknown, index: string) => boolean;
  UQ_CONTACT_EMAIL_PREFERENCES: string;
  UQ_CONTACT_JOURNEY_ACTIVE: string;
};

const RUN = `csu-${randomUUID().slice(0, 8)}-${Date.now()}`;
const uid = (label: string) => `${RUN}-${label}`;
const mail = (label: string) => `${RUN}-${label}@example.com`;

const container = createHogsendClient();
const app = createApp(container);
const AUTH_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};
const { db, logger, registry } = container;
// biome-ignore lint/suspicious/noExplicitAny: mocked hatchet client
const hatchet = { events: { push: vi.fn() } } as any;

const JOURNEY_ID = uid("journey");
const BUCKET_ID = uid("bucket");
const BUCKET_EVENT = `${RUN}.upgraded`;

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

/**
 * The unique_violation payload, or null. drizzle wraps the driver error in a
 * `DrizzleQueryError`, so the code/constraint live on `cause` — walk it.
 */
function uniqueViolation(err: unknown): { constraint: string } | null {
  for (let e = err, depth = 0; e && depth < 6; depth++) {
    const c = e as {
      code?: string;
      constraint_name?: string;
      constraint?: string;
      cause?: unknown;
    };
    if (c.code === "23505") {
      return { constraint: c.constraint_name ?? c.constraint ?? "" };
    }
    e = c.cause;
  }
  return null;
}

/** Enrollment values with no `ON CONFLICT` at all — the raw constraint probe. */
const rawEnrollment = (userId: string, contactId: string | null) => ({
  userId,
  userEmail: `${userId}@example.com`,
  journeyId: JOURNEY_ID,
  currentNodeId: "start",
  status: "active" as const,
  contactId,
});

/**
 * The membership INSERT statement shape, copied VERBATIM from the three bucket
 * writers (`buckets/check-membership.ts`, `workflows/bucket-reconcile.ts`,
 * `workflows/bucket-backfill.ts`) — values + an ARBITER-LESS
 * `.onConflictDoNothing()`. KEEP IN SYNC with them: the arbiter-less form is the
 * thing under test (it is what absorbs BOTH partial unique indexes), and the
 * real writers read membership by `user_id` first, so a second same-`user_id`
 * attempt is only reachable through a race or a re-run of a batch writer.
 */
const insertMembership = (userId: string, contactId: string | null) =>
  db
    .insert(bucketMemberships)
    .values({
      userId,
      userEmail: `${userId}@example.com`,
      bucketId: BUCKET_ID,
      status: "active" as const,
      source: "event",
      entryCount: 1,
      lastEvaluatedAt: new Date(),
      contactId,
    })
    .onConflictDoNothing()
    .returning({ id: bucketMemberships.id });

const joinViaRealPath = (userId: string, contactId?: string) =>
  checkBucketMembership({
    db,
    registry,
    hatchet,
    logger,
    userId,
    userEmail: `${userId}@example.com`,
    contactId,
    event: BUCKET_EVENT,
    eventProperties: {},
    contactProperties: { plan: "pro" },
  });

const statesFor = (journeyId: string) =>
  db.select().from(journeyStates).where(eq(journeyStates.journeyId, journeyId));
const membershipsFor = (bucketId: string) =>
  db
    .select()
    .from(bucketMemberships)
    .where(eq(bucketMemberships.bucketId, bucketId));
const prefsFor = (email: string) =>
  db.select().from(emailPreferences).where(eq(emailPreferences.email, email));

beforeAll(() => {
  setBucketRegistry(buildBucketRegistry([proBucket], "*"));
});

afterAll(async () => {
  resetBucketRegistry();
  await db
    .delete(journeyStates)
    .where(like(journeyStates.journeyId, `${RUN}-%`));
  await db
    .delete(bucketMemberships)
    .where(eq(bucketMemberships.bucketId, BUCKET_ID));
  await db
    .delete(emailPreferences)
    .where(
      or(
        like(emailPreferences.userId, `${RUN}-%`),
        like(emailPreferences.email, `${RUN}-%`),
      ),
    );
  await db
    .delete(contactAliases)
    .where(like(contactAliases.aliasValue, `${RUN}-%`));
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

// ---------------------------------------------------------------------------
// journey_states → uq_contact_journey_active
// ---------------------------------------------------------------------------

describe("journey_states — the CONTACTLESS arbiter (the trap)", () => {
  it("a contactless subject re-triggering a LIVE journey is absorbed, not 23505", async () => {
    // THE regression. `insertEnrollment` is the real production upsert (the
    // function `executeJourneyRun` calls). Under a naive bare
    // `(contact_id, journey_id)` arbiter this insert would not conflict at all
    // (NULL != NULL), would proceed, and would die on the RETAINED
    // `uq_user_journey_active` with an unhandled 23505 — a FAILED Hatchet run
    // for every anonymous visitor whose journey is still active.
    const userId = uid("anon-solo");

    const first = await insertEnrollment({
      db,
      userId,
      userEmail: `${userId}@example.com`,
      journeyId: JOURNEY_ID,
      context: {},
      contactId: null,
    });
    expect(first?.id).toBeTruthy();

    const second = await insertEnrollment({
      db,
      userId,
      userEmail: `${userId}@example.com`,
      journeyId: JOURNEY_ID,
      context: {},
      contactId: null,
    });
    // Zero rows — the `already_active` skip the caller maps it to. No throw.
    expect(second).toBeUndefined();

    const rows = await statesFor(JOURNEY_ID);
    expect(rows.filter((r) => r.userId === userId)).toHaveLength(1);
  });

  it("TWO DIFFERENT contactless subjects can both be live in one journey", async () => {
    // The NULLS NOT DISTINCT face: a `NULLS NOT DISTINCT` index would collapse
    // every anonymous visitor into ONE row per journey, silently refusing the
    // second visitor's enrollment.
    const a = uid("anon-a");
    const b = uid("anon-b");

    for (const userId of [a, b]) {
      const row = await insertEnrollment({
        db,
        userId,
        userEmail: `${userId}@example.com`,
        journeyId: JOURNEY_ID,
        context: {},
        contactId: null,
      });
      expect(row?.id).toBeTruthy();
    }

    const rows = await statesFor(JOURNEY_ID);
    expect(rows.filter((r) => r.userId === a)).toHaveLength(1);
    expect(rows.filter((r) => r.userId === b)).toHaveLength(1);
  });
});

describe("journey_states — the IDENTIFIED arbiter", () => {
  it("one contact under TWO string keys enrolls ONCE", async () => {
    // The anon-then-identified shape adoption produces: the first row was
    // written under the browser anon id, the second arrives under the external
    // id, and both resolve to contact X. `uq_user_journey_active` cannot see
    // this collision — the string keys differ.
    const anonKey = uid("dual-anon");
    const externalKey = uid("dual-ext");
    const contact = await resolveOrCreateContact({ db, userId: externalKey });

    const first = await insertEnrollment({
      db,
      userId: anonKey,
      userEmail: `${anonKey}@example.com`,
      journeyId: JOURNEY_ID,
      context: {},
      contactId: contact.id,
    });
    expect(first?.id).toBeTruthy();

    const second = await insertEnrollment({
      db,
      userId: externalKey,
      userEmail: `${externalKey}@example.com`,
      journeyId: JOURNEY_ID,
      context: {},
      contactId: contact.id,
    });
    expect(second).toBeUndefined();

    const rows = await statesFor(JOURNEY_ID);
    expect(rows.filter((r) => r.contactId === contact.id)).toHaveLength(1);
  });
});

describe("journey_states — the constraint bites", () => {
  it("a raw double INSERT for one (contact, journey) throws 23505", async () => {
    const contactId = randomUUID();
    await db
      .insert(journeyStates)
      .values(rawEnrollment(uid("bite-a"), contactId));

    let caught: unknown;
    try {
      await db
        .insert(journeyStates)
        .values(rawEnrollment(uid("bite-b"), contactId));
    } catch (err) {
      caught = err;
    }
    expect(uniqueViolation(caught)?.constraint).toBe(
      "uq_contact_journey_active",
    );
  });

  it("does NOT bite a TERMINAL row (the predicate scopes to live statuses)", async () => {
    // `unlimited` journeys reach terminal states repeatedly; the contact index
    // must be as narrow as the string one it twins.
    const contactId = randomUUID();
    await db.insert(journeyStates).values({
      ...rawEnrollment(uid("term-a"), contactId),
      status: "completed",
    });
    await db.insert(journeyStates).values({
      ...rawEnrollment(uid("term-b"), contactId),
      status: "completed",
    });

    const rows = await statesFor(JOURNEY_ID);
    expect(rows.filter((r) => r.contactId === contactId)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// bucket_memberships → uq_contact_bucket_active
// ---------------------------------------------------------------------------

describe("bucket_memberships — the CONTACTLESS arbiter (the trap)", () => {
  it("a repeated contactless join is absorbed, not 23505", async () => {
    const userId = uid("bkt-anon-solo");

    const first = await insertMembership(userId, null);
    expect(first).toHaveLength(1);

    const second = await insertMembership(userId, null);
    expect(second).toHaveLength(0);

    const rows = await membershipsFor(BUCKET_ID);
    expect(rows.filter((r) => r.userId === userId)).toHaveLength(1);
  });

  it("TWO DIFFERENT contactless visitors can both be active in one bucket", async () => {
    // Through the REAL join path (`checkBucketMembership`), pin-less shape.
    const a = uid("bkt-anon-a");
    const b = uid("bkt-anon-b");

    for (const userId of [a, b]) {
      const transitions = await joinViaRealPath(userId);
      expect(
        transitions.filter(
          (t) => t.bucketId === BUCKET_ID && t.transition === "entered",
        ),
      ).toHaveLength(1);
    }

    const rows = await membershipsFor(BUCKET_ID);
    expect(rows.filter((r) => r.userId === a)).toHaveLength(1);
    expect(rows.filter((r) => r.userId === b)).toHaveLength(1);
  });
});

describe("bucket_memberships — the IDENTIFIED arbiter", () => {
  it("one contact under TWO string keys joins ONCE (real join path)", async () => {
    const anonKey = uid("bkt-dual-anon");
    const externalKey = uid("bkt-dual-ext");
    const contact = await resolveOrCreateContact({ db, userId: externalKey });

    const firstTransitions = await joinViaRealPath(anonKey, contact.id);
    expect(
      firstTransitions.filter(
        (t) => t.bucketId === BUCKET_ID && t.transition === "entered",
      ),
    ).toHaveLength(1);

    // Second key, same contact. The writer's membership read is text-keyed, so
    // it does not see the first row and DOES attempt the insert — which the
    // contact index rejects and the arbiter-less DO NOTHING absorbs into "lost
    // the race": zero rows, no transition, no throw.
    const secondTransitions = await joinViaRealPath(externalKey, contact.id);
    expect(
      secondTransitions.filter(
        (t) => t.bucketId === BUCKET_ID && t.transition === "entered",
      ),
    ).toHaveLength(0);

    const rows = await membershipsFor(BUCKET_ID);
    expect(rows.filter((r) => r.contactId === contact.id)).toHaveLength(1);
  });
});

describe("bucket_memberships — the constraint bites", () => {
  it("a raw double INSERT for one (contact, bucket) throws 23505", async () => {
    const contactId = randomUUID();
    const values = (userId: string) => ({
      userId,
      userEmail: `${userId}@example.com`,
      bucketId: BUCKET_ID,
      status: "active" as const,
      entryCount: 1,
      contactId,
    });
    await db.insert(bucketMemberships).values(values(uid("bkt-bite-a")));

    let caught: unknown;
    try {
      await db.insert(bucketMemberships).values(values(uid("bkt-bite-b")));
    } catch (err) {
      caught = err;
    }
    expect(uniqueViolation(caught)?.constraint).toBe(
      "uq_contact_bucket_active",
    );
  });

  it("does NOT bite a LEFT row (buckets are re-entrant)", async () => {
    const contactId = randomUUID();
    const values = (userId: string, status: "active" | "left") => ({
      userId,
      userEmail: `${userId}@example.com`,
      bucketId: BUCKET_ID,
      status,
      entryCount: 1,
      contactId,
    });
    await db
      .insert(bucketMemberships)
      .values(values(uid("bkt-left-a"), "left"));
    await db
      .insert(bucketMemberships)
      .values(values(uid("bkt-left-b"), "left"));
    await db
      .insert(bucketMemberships)
      .values(values(uid("bkt-left-c"), "active"));

    const rows = await membershipsFor(BUCKET_ID);
    expect(rows.filter((r) => r.contactId === contactId)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// email_preferences → email_preferences_contact_email_idx
// ---------------------------------------------------------------------------

describe("email_preferences — the CONTACTLESS arbiter (the trap)", () => {
  it("a repeated token-derived write with NO contact UPDATES its row", async () => {
    // The unsubscribe-token flow whose contact resolve came back empty (D6
    // degrades to NULL). Getting this arm wrong is the worst failure on this
    // table: the write is dropped or misrouted and the person keeps getting mail.
    const userId = uid("pref-anon-solo");
    const email = mail("pref-anon-solo");

    await upsertEmailPreference({
      db,
      externalId: userId,
      email,
      contactId: null,
      emitOutbound: false,
      update: { categoryKey: "product", categoryValue: true },
    });
    await upsertEmailPreference({
      db,
      externalId: userId,
      email,
      contactId: null,
      emitOutbound: false,
      update: { unsubscribedAll: true },
    });

    const rows = await prefsFor(email);
    expect(rows).toHaveLength(1);
    // The SECOND write landed on the FIRST row — not a silent no-op.
    expect(rows[0]?.unsubscribedAll).toBe(true);
    expect(rows[0]?.categories).toMatchObject({ product: true });
    expect(rows[0]?.contactId).toBeNull();
  });

  it("TWO DIFFERENT contactless subjects can hold the SAME address", async () => {
    const email = mail("pref-shared");
    const a = uid("pref-anon-a");
    const b = uid("pref-anon-b");

    for (const externalId of [a, b]) {
      await upsertEmailPreference({
        db,
        externalId,
        email,
        contactId: null,
        emitOutbound: false,
        update: { unsubscribedAll: false },
      });
    }

    const rows = await prefsFor(email);
    expect(rows).toHaveLength(2);
  });
});

describe("email_preferences — the IDENTIFIED arbiter", () => {
  it("one contact under TWO string keys keeps ONE row, and the unsubscribe lands on it", async () => {
    const anonKey = uid("pref-dual-anon");
    const externalKey = uid("pref-dual-ext");
    const email = mail("pref-dual");
    const contact = await resolveOrCreateContact({ db, userId: externalKey });

    // Written under the pre-adoption anon key.
    await upsertEmailPreference({
      db,
      externalId: anonKey,
      email,
      contactId: contact.id,
      emitOutbound: false,
      update: { categoryKey: "product", categoryValue: true },
    });

    // The same person unsubscribes, now keyed by their external id. The string
    // arbiter cannot match; without the 23505 conversion this write would throw
    // (and, before the index, would have created a SECOND row — the read could
    // then pick the still-subscribed one and mail them anyway).
    await upsertEmailPreference({
      db,
      externalId: externalKey,
      email,
      contactId: contact.id,
      emitOutbound: false,
      update: { unsubscribedAll: true },
    });

    const rows = await prefsFor(email);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(anonKey);
    expect(rows[0]?.unsubscribedAll).toBe(true);
    // The converted UPDATE ran the SAME set clause: the jsonb category flip
    // from the first write survives and `contact_id` is untouched.
    expect(rows[0]?.categories).toMatchObject({ product: true });
    expect(rows[0]?.contactId).toBe(contact.id);
  });

  it("the converted UPDATE still applies a category flip", async () => {
    const anonKey = uid("pref-cat-anon");
    const externalKey = uid("pref-cat-ext");
    const email = mail("pref-cat");
    const contact = await resolveOrCreateContact({ db, userId: externalKey });

    await upsertEmailPreference({
      db,
      externalId: anonKey,
      email,
      contactId: contact.id,
      emitOutbound: false,
      update: { categoryKey: "product", categoryValue: true },
    });
    await upsertEmailPreference({
      db,
      externalId: externalKey,
      email,
      contactId: contact.id,
      emitOutbound: false,
      update: { categoryKey: "product", categoryValue: false },
    });

    const rows = await prefsFor(email);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.categories).toMatchObject({ product: false });
  });
});

describe("email_preferences — the constraint bites", () => {
  it("a raw double INSERT for one (contact, email) throws 23505", async () => {
    const contactId = randomUUID();
    const email = mail("pref-bite");
    await db
      .insert(emailPreferences)
      .values({ userId: uid("pref-bite-a"), email, contactId });

    let caught: unknown;
    try {
      await db
        .insert(emailPreferences)
        .values({ userId: uid("pref-bite-b"), email, contactId });
    } catch (err) {
      caught = err;
    }
    expect(uniqueViolation(caught)?.constraint).toBe(
      "email_preferences_contact_email_idx",
    );
  });
});

// ---------------------------------------------------------------------------
// The catch is PRECISE — it converts only the three new indexes, never a
// blanket 23505 (which would mask real bugs behind a silent update).
// ---------------------------------------------------------------------------

describe("isUniqueViolationOn — the precision gate on every convert path", () => {
  const pgError = (constraintName: string, code = "23505") => ({
    code,
    constraint_name: constraintName,
  });

  it("matches its OWN index, including through a wrapped cause chain", () => {
    // drizzle wraps the driver error, so the payload is on `cause`.
    const wrapped = {
      message: "query failed",
      cause: pgError("uq_contact_journey_active"),
    };
    expect(isUniqueViolationOn(wrapped, UQ_CONTACT_JOURNEY_ACTIVE)).toBe(true);
    expect(
      isUniqueViolationOn(
        pgError("email_preferences_contact_email_idx"),
        UQ_CONTACT_EMAIL_PREFERENCES,
      ),
    ).toBe(true);
  });

  it("does NOT match a violation of the RETAINED string index", () => {
    // The whole point. `uq_user_journey_active` firing means a genuine
    // same-key race (or a real bug) — it must reach the caller, not be
    // silently converted into an already-exists.
    expect(
      isUniqueViolationOn(
        pgError("uq_user_journey_active"),
        UQ_CONTACT_JOURNEY_ACTIVE,
      ),
    ).toBe(false);
    expect(
      isUniqueViolationOn(
        pgError("email_preferences_user_email_idx"),
        UQ_CONTACT_EMAIL_PREFERENCES,
      ),
    ).toBe(false);
  });

  it("does NOT match an unrelated constraint, or a non-23505 error", () => {
    expect(
      isUniqueViolationOn(
        pgError("contacts_phone_unique_idx"),
        UQ_CONTACT_JOURNEY_ACTIVE,
      ),
    ).toBe(false);
    // 23503 = foreign_key_violation. Same constraint name, wrong class.
    expect(
      isUniqueViolationOn(
        pgError("uq_contact_journey_active", "23503"),
        UQ_CONTACT_JOURNEY_ACTIVE,
      ),
    ).toBe(false);
    expect(
      isUniqueViolationOn(new Error("boom"), UQ_CONTACT_JOURNEY_ACTIVE),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The convert path is INDISTINGUISHABLE from the arbiter path
// ---------------------------------------------------------------------------

describe("email_preferences — convert path ≡ arbiter path", () => {
  it("both arms leave byte-identical row state", async () => {
    // Twin fixtures differing ONLY in which arm resolves the second write.
    // ARM A: same string key twice → the (user_id, email) ON CONFLICT arbiter.
    // ARM B: two string keys, one contact → the 23505 catch-and-convert.
    const extA = uid("equiv-a-ext");
    const emailA = mail("equiv-a");
    const contactA = await resolveOrCreateContact({ db, userId: extA });

    const anonB = uid("equiv-b-anon");
    const extB = uid("equiv-b-ext");
    const emailB = mail("equiv-b");
    const contactB = await resolveOrCreateContact({ db, userId: extB });

    const seed = { categoryKey: "product", categoryValue: true };
    const followUp = { unsubscribedAll: true, recordBounce: true };

    await upsertEmailPreference({
      db,
      externalId: extA,
      email: emailA,
      contactId: contactA.id,
      emitOutbound: false,
      update: seed,
    });
    await upsertEmailPreference({
      db,
      externalId: extA, // SAME key → arbiter arm
      email: emailA,
      contactId: contactA.id,
      emitOutbound: false,
      update: followUp,
    });

    await upsertEmailPreference({
      db,
      externalId: anonB,
      email: emailB,
      contactId: contactB.id,
      emitOutbound: false,
      update: seed,
    });
    await upsertEmailPreference({
      db,
      externalId: extB, // DIFFERENT key, same contact → convert arm
      email: emailB,
      contactId: contactB.id,
      emitOutbound: false,
      update: followUp,
    });

    const [rowA] = await prefsFor(emailA);
    const [rowB] = await prefsFor(emailB);
    expect(rowA).toBeDefined();
    expect(rowB).toBeDefined();

    // Every column the update is responsible for must agree. (Identity columns
    // — id/userId/email/contactId — and timestamps differ by construction.)
    const settled = (r: typeof rowA) => ({
      unsubscribedAll: r?.unsubscribedAll,
      suppressed: r?.suppressed,
      bounceCount: r?.bounceCount,
      categories: r?.categories,
      suppressedAt: r?.suppressedAt,
      hasContact: r?.contactId !== null,
    });
    expect(settled(rowB)).toEqual(settled(rowA));
    // ...and it is the state the follow-up asked for, not a stale seed row.
    expect(rowB?.unsubscribedAll).toBe(true);
    expect(rowB?.bounceCount).toBe(1);
    expect(rowB?.categories).toMatchObject({ product: true });
  });
});

describe("admin preferences route — the caller sees a normal 200", () => {
  it("converts the collision instead of 500ing on an adopted contact", async () => {
    // The route keys its insert off `external_id ?? id`, but an adopted row may
    // still carry the pre-adoption anon string. Without the conversion this
    // request is a raw 23505 escaping the handler — an admin editing
    // preferences for exactly the contacts adoption has touched gets a 500.
    const anonKey = uid("admin-anon");
    const externalKey = uid("admin-ext");
    const email = mail("admin-conv");
    const contact = await resolveOrCreateContact({
      db,
      userId: externalKey,
      email,
    });

    await upsertEmailPreference({
      db,
      externalId: anonKey,
      email,
      contactId: contact.id,
      emitOutbound: false,
      update: { categoryKey: "product", categoryValue: true },
    });

    const res = await app.request(
      `/v1/admin/contacts/${contact.id}/preferences`,
      {
        method: "PUT",
        headers: AUTH_HEADER,
        body: JSON.stringify({ unsubscribedAll: true }),
      },
    );

    // The status AND the body the caller sees are the ordinary success shape —
    // the fallback UPDATE `.returning()`s the row exactly as the arbiter arm did.
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      preferences: { unsubscribedAll: boolean; email: string };
    };
    expect(body.preferences.unsubscribedAll).toBe(true);
    expect(body.preferences.email).toBe(email);

    const rows = await prefsFor(email);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(anonKey);
    expect(rows[0]?.contactId).toBe(contact.id);
    expect(rows[0]?.categories).toMatchObject({ product: true });
  });
});

// ---------------------------------------------------------------------------
// MERGE vs the new indexes. The folds in `lib/contacts.ts` dedupe against rows
// whose `user_id` is the SURVIVOR's key — which cannot see a survivor row that
// adoption already stamped under a STALE key. Re-pointing a loser row past such
// a row mints a second row inside a new index, and the 23505 lands inside
// `resolveContact`'s transaction with no handler: identity resolution for that
// person is then permanently wedged (every retry fails identically).
// ---------------------------------------------------------------------------

describe("merge — a survivor row stamped under a STALE key", () => {
  it("folds the loser's preference INTO it (opt-out kept, one row, no 23505)", async () => {
    const externalKey = uid("merge-pref-ext");
    const staleKey = uid("merge-pref-stale");
    const anonKey = uid("merge-pref-anon");
    const email = mail("merge-pref");

    const survivor = await resolveOrCreateContact({ db, userId: externalKey });
    const loser = await resolveOrCreateContact({ db, anonymousId: anonKey });

    // The ADOPTION population: the survivor's pref row, filed under a stale
    // string key, already carrying the survivor's uuid.
    await db.insert(emailPreferences).values({
      userId: staleKey,
      email,
      contactId: survivor.id,
      categories: { product: true },
    });
    // The loser holds the OPT-OUT for the same address.
    await db.insert(emailPreferences).values({
      userId: anonKey,
      email,
      contactId: loser.id,
      unsubscribedAll: true,
    });

    // One call naming both identities drives the collide-MERGE.
    const merged = await resolveOrCreateContact({
      db,
      userId: externalKey,
      anonymousId: anonKey,
    });
    expect(merged.merged).toBe(true);
    expect(merged.id).toBe(survivor.id);

    const rows = await prefsFor(email);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBe(survivor.id);
    // Risk 6, restated for the contact-scoped world: an opt-out must NEVER be
    // lost by a fold that could not see its target.
    expect(rows[0]?.unsubscribedAll).toBe(true);
    expect(rows[0]?.categories).toMatchObject({ product: true });
  });

  it("exits the loser's live enrollment against it (one live row per contact)", async () => {
    const externalKey = uid("merge-js-ext");
    const staleKey = uid("merge-js-stale");
    const anonKey = uid("merge-js-anon");
    const journeyId = uid("merge-js-journey");

    const survivor = await resolveOrCreateContact({ db, userId: externalKey });
    const loser = await resolveOrCreateContact({ db, anonymousId: anonKey });

    await db.insert(journeyStates).values({
      ...rawEnrollment(staleKey, survivor.id),
      journeyId,
    });
    // `waiting`, not `active`: the index predicate treats the two live statuses
    // as ONE slot, so a per-(journey|status) occupancy check misses this pair.
    await db.insert(journeyStates).values({
      ...rawEnrollment(anonKey, loser.id),
      journeyId,
      status: "waiting" as const,
    });

    const merged = await resolveOrCreateContact({
      db,
      userId: externalKey,
      anonymousId: anonKey,
    });
    expect(merged.merged).toBe(true);

    const rows = await statesFor(journeyId);
    expect(
      rows.filter(
        (r) =>
          r.contactId === merged.id &&
          (r.status === "active" || r.status === "waiting"),
      ),
    ).toHaveLength(1);
    // Nothing was dropped — the loser's row is still there, exited.
    expect(rows.filter((r) => r.userId === staleKey)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The convert path's own race: between the failed INSERT and the convert UPDATE
// a concurrent merge can DELETE the conflicting row (foldEmailPreferences hard-
// deletes it), leaving the UPDATE matching zero rows. Silently accepting that
// drops the write while still emitting `contact.unsubscribed`.
// ---------------------------------------------------------------------------

describe("email_preferences — the convert UPDATE loses the row mid-race", () => {
  it("retries the arbiter INSERT so the unsubscribe still lands", async () => {
    const anonKey = uid("race-anon");
    const externalKey = uid("race-ext");
    const email = mail("race");
    const contact = await resolveOrCreateContact({ db, userId: externalKey });

    await upsertEmailPreference({
      db,
      externalId: anonKey,
      email,
      contactId: contact.id,
      emitOutbound: false,
      update: { categoryKey: "product", categoryValue: true },
    });
    const [conflicting] = await prefsFor(email);
    if (!conflicting) throw new Error("fixture missing the conflicting row");

    // A `db` whose FIRST `.update()` loses the race: it deletes the conflicting
    // row (exactly what a concurrent merge's `foldEmailPreferences` does) and
    // reports zero rows updated. Everything else delegates to the real client.
    let armed = true;
    const racingDb = new Proxy(db as object, {
      get(target, prop, receiver) {
        if (prop === "update" && armed) {
          armed = false;
          const stub = {
            set: () => stub,
            where: () => stub,
            returning: async () => {
              await db
                .delete(emailPreferences)
                .where(eq(emailPreferences.id, conflicting.id));
              return [] as unknown[];
            },
          };
          return () => stub;
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await upsertEmailPreference({
      db: racingDb,
      externalId: externalKey,
      email,
      contactId: contact.id,
      update: { unsubscribedAll: true },
    });

    // The write LANDED. Without the retry the row simply would not exist —
    // and `contact.unsubscribed` would have been emitted for a dropped opt-out.
    const rows = await prefsFor(email);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.unsubscribedAll).toBe(true);
    expect(rows[0]?.contactId).toBe(contact.id);
  });
});

// ---------------------------------------------------------------------------
// The preflight the operator runs against production before migrating
// ---------------------------------------------------------------------------

describe("packages/db/scripts/preflight-contact-uniqueness.sql", () => {
  it("reports zero violations for this file's fixtures", async () => {
    // Same three queries, same predicates, scoped to RUN-namespaced rows. If a
    // writer above ever DID create a duplicate, this is what an operator would
    // see on production before the index build failed on them.
    const journeys = await db.execute(sql`
      select contact_id, journey_id, count(*) as live_rows
        from journey_states
       where contact_id is not null
         and status in ('active', 'waiting')
         and journey_id = ${JOURNEY_ID}
       group by 1, 2
      having count(*) > 1`);
    const buckets = await db.execute(sql`
      select contact_id, bucket_id, count(*) as live_rows
        from bucket_memberships
       where contact_id is not null
         and status = 'active'
         and deleted_at is null
         and bucket_id = ${BUCKET_ID}
       group by 1, 2
      having count(*) > 1`);
    const prefs = await db.execute(sql`
      select contact_id, email, count(*) as live_rows
        from email_preferences
       where contact_id is not null
         and email like ${`${RUN}-%`}
       group by 1, 2
      having count(*) > 1`);

    expect(Array.from(journeys)).toHaveLength(0);
    expect(Array.from(buckets)).toHaveLength(0);
    expect(Array.from(prefs)).toHaveLength(0);
  });
});
