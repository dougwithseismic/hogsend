/**
 * PRD 04 T4b — `journey_states.contact_id` dual-write.
 *
 * Both insert sites are covered: the ENROLLMENT row and the HELD_OUT row. The
 * value comes from the pushed `input.contactId` when ingest already resolved
 * the subject, and otherwise from ONE D6-wrapped `lookupContactIdByKey` probe.
 * An unknown subject stamps NULL and the enrollment proceeds unchanged — the
 * whole point of D6.
 *
 * Harness: the engine hatchet singleton is mocked with the durable-task fns
 * captured BY NAME (the journey-version-stamping / blueprint-interpreter
 * pattern), so the REAL guard chain + enrollment insert run against real
 * Postgres and every assertion reads the row back.
 */
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

type CapturedFn = (input: unknown, ctx: unknown) => Promise<unknown>;
const { mockFns, hatchetMock } = vi.hoisted(() => {
  const mockFns: Record<string, CapturedFn> = {};
  const hatchetMock = () => ({
    hatchet: {
      durableTask: vi.fn((cfg: { name: string; fn: CapturedFn }) => {
        mockFns[cfg.name] = cfg.fn;
        return { run: vi.fn(), runNoWait: vi.fn(), runAndWait: vi.fn() };
      }),
      task: vi.fn((cfg: { name: string; fn: CapturedFn }) => {
        mockFns[cfg.name] = cfg.fn;
        return { run: vi.fn(), runNoWait: vi.fn(async () => ({})) };
      }),
      events: { push: vi.fn(async () => {}) },
      runs: { cancel: vi.fn(async () => {}), get: vi.fn() },
      worker: vi.fn(),
    },
  });
  return { mockFns, hatchetMock };
});
vi.mock("../../../../packages/engine/src/lib/hatchet.ts", hatchetMock);
vi.mock("../../../../packages/engine/src/lib/hatchet.js", hatchetMock);
vi.mock("../lib/hatchet.js", hatchetMock);

// PARTIAL mock of the engine's contacts module: everything is the REAL export
// except `lookupContactIdByKey`, which is the real implementation wrapped in a
// spy. That gives a fault-injection seam (D6) without changing behaviour for
// any other test in this file. Dual `.ts`/`.js` registration mirrors the
// hatchet idiom above — the engine's own relative imports are `.js`-suffixed.
const { lookupSpy, contactsMock } = vi.hoisted(() => {
  const lookupSpy = vi.fn();
  const contactsMock = async (
    importOriginal: () => Promise<Record<string, unknown>>,
  ) => {
    const actual = await importOriginal();
    lookupSpy.mockImplementation(
      actual.lookupContactIdByKey as (...a: unknown[]) => unknown,
    );
    return { ...actual, lookupContactIdByKey: lookupSpy };
  };
  return { lookupSpy, contactsMock };
});
vi.mock("../../../../packages/engine/src/lib/contacts.ts", contactsMock);
vi.mock("../../../../packages/engine/src/lib/contacts.js", contactsMock);

const { contactAliases, contacts, journeyStates, userEvents } = await import(
  "@hogsend/db"
);
const { and, eq, like, or } = await import("drizzle-orm");
const {
  createHogsendClient,
  defineJourney,
  holdoutBucket,
  insertEnrollment,
  resolveOrCreateContact,
} = await import("@hogsend/engine");

const RUN = `cijy-${randomUUID().slice(0, 8)}-${Date.now()}`;
const uid = (label: string) => `${RUN}-${label}`;

const ENROLL_ID = uid("enroll");
const HELD_ID = uid("held");

const enrollJourney = defineJourney({
  meta: {
    id: ENROLL_ID,
    name: "Enroll journey",
    enabled: true,
    trigger: { event: `${RUN}.enroll` },
    entryLimit: "unlimited",
    suppress: { hours: 0 },
  },
  run: async () => {},
});

// `isHeldOut` clamps percent to 50 (a holdout is never the majority), so the
// held_out insert is reached by PROBING the deterministic hash space for a
// diverted key — the journey-version-stamping idiom, no RNG, no clock.
const heldJourney = defineJourney({
  meta: {
    id: HELD_ID,
    name: "Held journey",
    enabled: true,
    trigger: { event: `${RUN}.held` },
    entryLimit: "unlimited",
    suppress: { hours: 0 },
    holdout: { percent: 50 },
  },
  run: async () => {},
});

const container = createHogsendClient({
  journeys: [enrollJourney, heldJourney],
});
const { db } = container;

/** A RUN-namespaced key that the 50% holdout deterministically DIVERTS. */
function findHeldUser(label: string): string {
  for (let i = 0; i < 5000; i++) {
    const candidate = uid(`${label}${i}`);
    if (holdoutBucket({ userId: candidate, journeyId: HELD_ID }) < 5000) {
      return candidate;
    }
  }
  throw new Error("no held-out candidate found");
}

const journeyFn = (id: string): CapturedFn => {
  const fn = mockFns[`journey-${id}`];
  if (!fn) throw new Error(`journey fn for ${id} was not captured`);
  return fn;
};

/** The Hatchet event payload shape a journey durable task receives. */
const payload = (userId: string, extra?: Record<string, unknown>) => ({
  userId,
  userEmail: "",
  properties: {},
  ...extra,
});
const ctx = (runId: string) => ({
  workflowRunId: () => runId,
  sleepFor: async () => ({}),
  waitFor: async () => ({}),
  now: async () => new Date(),
});

const stateRows = (journeyId: string, userId: string) =>
  db
    .select()
    .from(journeyStates)
    .where(
      and(
        eq(journeyStates.journeyId, journeyId),
        eq(journeyStates.userId, userId),
      ),
    );

afterAll(async () => {
  await db
    .delete(journeyStates)
    .where(like(journeyStates.journeyId, `${RUN}-%`));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  await db
    .delete(contactAliases)
    .where(like(contactAliases.aliasValue, `${RUN}-%`));
  // The house triple — the email leg matters: this file mints email-only
  // contacts (the pin tests), whose external_id/anonymous_id are BOTH null.
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

describe("T4b — journey_states.contact_id at the enrollment insert", () => {
  it("stamps the owning contacts.id for a contact-owning user", async () => {
    const userId = uid("owner");
    const contact = await resolveOrCreateContact({ db, userId });

    const result = await journeyFn(ENROLL_ID)(
      payload(userId),
      ctx(`${RUN}-r-owner`),
    );
    expect(result).toMatchObject({ status: "completed" });

    const rows = await stateRows(ENROLL_ID, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBe(contact.id);
  });

  it("resolves an ANONYMOUS-keyed contact too (the probe reads both columns)", async () => {
    // A journey `userId` is routinely a browser anon id: the canonical key is
    // `anonymous_id`, not `external_id`. A probe that read external_id only
    // would NULL this row forever.
    const anonKey = uid("anon-owner");
    const contact = await resolveOrCreateContact({ db, anonymousId: anonKey });
    expect(contact.resolvedKey).toBe(anonKey);

    await journeyFn(ENROLL_ID)(payload(anonKey), ctx(`${RUN}-r-anon`));

    const rows = await stateRows(ENROLL_ID, anonKey);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBe(contact.id);
  });

  it("an UNKNOWN user stamps NULL and the enrollment still succeeds", async () => {
    const userId = uid("ghost");

    const result = await journeyFn(ENROLL_ID)(
      payload(userId),
      ctx(`${RUN}-r-ghost`),
    );
    expect(result).toMatchObject({ status: "completed" });

    const rows = await stateRows(ENROLL_ID, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBeNull();
    // The row is a real, complete enrollment — bookkeeping did not degrade it.
    expect(rows[0]?.status).toBe("completed");
  });

  it("prefers the pushed input.contactId over a probe", async () => {
    // `ingestEvent` pins the subject row it resolved; the enrollment must
    // stamp THAT id rather than re-deriving one (zero extra queries).
    const userId = uid("pinned");
    const pinned = await resolveOrCreateContact({
      db,
      email: `${userId}@x.io`,
    });

    await journeyFn(ENROLL_ID)(
      payload(userId, { contactId: pinned.id }),
      ctx(`${RUN}-r-pinned`),
    );

    const rows = await stateRows(ENROLL_ID, userId);
    expect(rows).toHaveLength(1);
    // The key `userId` owns NO contact row, so a probe would have produced
    // NULL — only the pin can produce this id.
    expect(rows[0]?.contactId).toBe(pinned.id);
  });
});

describe("T4b — journey_states.contact_id at the held_out insert", () => {
  it("stamps the held_out row for a contact-owning user", async () => {
    const userId = findHeldUser("held-owner");
    const contact = await resolveOrCreateContact({ db, userId });

    const result = await journeyFn(HELD_ID)(
      payload(userId),
      ctx(`${RUN}-r-held`),
    );
    expect(result).toMatchObject({ status: "skipped", reason: "held_out" });

    const rows = await stateRows(HELD_ID, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("held_out");
    expect(rows[0]?.contactId).toBe(contact.id);
  });

  it("an unknown held-out subject stamps NULL, diversion still recorded", async () => {
    const userId = findHeldUser("held-ghost");

    const result = await journeyFn(HELD_ID)(
      payload(userId),
      ctx(`${RUN}-r-held-ghost`),
    );
    expect(result).toMatchObject({ status: "skipped", reason: "held_out" });

    const rows = await stateRows(HELD_ID, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("held_out");
    expect(rows[0]?.contactId).toBeNull();
  });
});

describe("T4b — a STALE pushed pin is never stamped", () => {
  it("a pin merged away between ingest and execution resolves the survivor", async () => {
    // The pin is computed at INGEST time and then crosses an unbounded Hatchet
    // queue delay. A merge inside that window soft-deletes the pinned loser and
    // re-aliases its key onto the survivor. Stamping the tombstone would be
    // PERMANENT (the backfill only fills NULLs), so the pin must be validated.
    const anonKey = uid("stale-key");
    const loser = await resolveOrCreateContact({ db, anonymousId: anonKey });
    const survivor = await resolveOrCreateContact({
      db,
      userId: uid("stale-survivor"),
    });

    // Simulate the merge window: the loser is soft-deleted and its key now
    // resolves, via the alias table, to the survivor.
    await db
      .update(contacts)
      .set({ deletedAt: new Date() })
      .where(eq(contacts.id, loser.id));
    // The resolver's own dual-write already wrote an `anonymous` alias for this
    // key pointing at the loser, so the merge REPOINTS it (an upsert on the
    // (kind, value) unique index) exactly as `mergeContacts` does.
    await db
      .insert(contactAliases)
      .values({
        contactId: survivor.id,
        aliasKind: "anonymous",
        aliasValue: anonKey,
        fromContactId: loser.id,
        reason: "merge",
      })
      .onConflictDoUpdate({
        target: [contactAliases.aliasKind, contactAliases.aliasValue],
        set: {
          contactId: survivor.id,
          fromContactId: loser.id,
          reason: "merge",
        },
      });

    const result = await journeyFn(ENROLL_ID)(
      payload(anonKey, { contactId: loser.id }),
      ctx(`${RUN}-r-stale`),
    );
    expect(result).toMatchObject({ status: "completed" });

    const rows = await stateRows(ENROLL_ID, anonKey);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBe(survivor.id);
    expect(rows[0]?.contactId).not.toBe(loser.id);
  });

  it("a stale pin whose key resolves to nothing stamps NULL, not the tombstone", async () => {
    const anonKey = uid("stale-orphan-key");
    const loser = await resolveOrCreateContact({ db, anonymousId: anonKey });
    await db
      .update(contacts)
      .set({ deletedAt: new Date() })
      .where(eq(contacts.id, loser.id));

    await journeyFn(ENROLL_ID)(
      payload(anonKey, { contactId: loser.id }),
      ctx(`${RUN}-r-stale-orphan`),
    );

    const rows = await stateRows(ENROLL_ID, anonKey);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBeNull();
  });
});

describe("D6 — a throwing resolve never fails the enrollment", () => {
  it("the enrollment completes with contact_id NULL when the probe rejects", async () => {
    // A user who DOES own a contact, so without the fault this row would be
    // stamped — the NULL below can only come from the swallowed rejection.
    const userId = uid("d6-journey");
    await resolveOrCreateContact({ db, userId });

    lookupSpy.mockRejectedValueOnce(new Error("injected: probe unavailable"));

    const result = await journeyFn(ENROLL_ID)(
      payload(userId),
      ctx(`${RUN}-r-d6`),
    );
    // Kills the rethrow mutation: without the try/catch the durable task fn
    // would reject and this line never runs.
    expect(result).toMatchObject({ status: "completed" });

    const rows = await stateRows(ENROLL_ID, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBeNull();
  });

  it("the partial mock is LIVE (guards the test above from being vacuous)", async () => {
    // If `vi.mock` had not intercepted the engine's own `./contacts.js`
    // specifier, the spy would never be reached and the rejection above would
    // have been injected into nothing.
    expect(lookupSpy).toHaveBeenCalled();
  });
});

describe("T4b — insertEnrollment public API", () => {
  it("defaults contact_id to NULL when the new opt is omitted", async () => {
    // The back-compat shape, called EXACTLY as journey-version-stamping.test.ts
    // calls it (no `contactId`): must not throw and must not require the opt.
    const bare = await insertEnrollment({
      db,
      userId: `${RUN}-direct-bare`,
      userEmail: `${RUN}-direct-bare@example.com`,
      journeyId: `${RUN}-direct`,
      context: {},
    });
    expect(bare?.contactId).toBeNull();
  });

  it("stamps an explicitly passed contactId", async () => {
    const owner = await resolveOrCreateContact({
      db,
      userId: `${RUN}-direct-owner`,
    });
    const stamped = await insertEnrollment({
      db,
      userId: `${RUN}-direct-stamped`,
      userEmail: `${RUN}-direct-stamped@example.com`,
      journeyId: `${RUN}-direct`,
      context: {},
      contactId: owner.id,
    });
    expect(stamped?.contactId).toBe(owner.id);
  });

  it("an explicit null is honored (never coerced into a lookup)", async () => {
    const stamped = await insertEnrollment({
      db,
      userId: `${RUN}-direct-null`,
      userEmail: `${RUN}-direct-null@example.com`,
      journeyId: `${RUN}-direct`,
      context: {},
      contactId: null,
    });
    expect(stamped?.contactId).toBeNull();
  });
});
