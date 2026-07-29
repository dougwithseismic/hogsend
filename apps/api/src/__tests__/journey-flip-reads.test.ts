/**
 * PRD 05 T4 — the journey runtime reads history by SUBJECT, not by string key.
 *
 * Five behaviours — one per arm of `bySubject`, the invariant the contact arm
 * depends on, and one DIVERGENT-KEY proof per remaining flipped read site:
 *
 *   (a) CONTACT arm — an enrollment the contact accumulated under its anon-era
 *       key must still count against `entryLimit: "once"` once that history has
 *       been adopted (`contact_id` stamped). Driven through the REAL
 *       `executeJourneyRun`, so the assertion is on the guard chain itself.
 *
 *   (b) userKey arm — a subject with NO contact at all (the engine refuses to
 *       mint one on observation) must still have its active journey EXITED by
 *       `ingestEvent`'s exit scan. This is the population a naive
 *       `eq(contact_id, …)` flip silently strands forever.
 *
 *   (c) The invariant behind (a): a contact minted ON a key that ALREADY has
 *       history must adopt it. `repointOwnHistory` early-returns when the key
 *       does not change, so nothing used to associate those rows with their new
 *       owner and a contact-scoped read could not see them.
 *
 *   (d) `checkExits`' flip, on DIVERGENT keys — (b) proves only that the
 *       contactless arm survives, and (c)'s stamp lands on the SAME key the
 *       event arrives under, so the string arm answers both identically. Here
 *       the enrollment sits under a STALE key the event never carries: only the
 *       contact arm reaches it, and an unreachable `exitOn` runs a journey on
 *       someone who has already converted/churned/unsubscribed.
 *
 *   (e) `checkEmailPreferences`' flip, on DIVERGENT keys — the unsubscribe
 *       safety guard. An opt-out recorded under the stale key must gate an
 *       entry triggered under the canonical one. The string arm misses it and
 *       enrolls, i.e. mails someone who unsubscribed — the single most
 *       expensive miss in this batch.
 *
 * Why (a)'s fixture stamps `contact_id` directly instead of calling
 * `resolveOrCreateContact`: adoption today does BOTH halves — it stamps
 * `contact_id` AND rewrites `user_id` onto the new canonical key — so a
 * resolve-driven fixture leaves the row reachable by the string key and the
 * flip becomes unobservable (a test that certifies rather than tests). The
 * UPDATE below is PRD 05 D4's adoption statement verbatim
 * (`SET contact_id = :id WHERE user_id = :fromKey AND contact_id IS NULL`) —
 * the shape T9 makes permanent once the string rewrite is deleted, and the
 * shape this batch's reads must already handle.
 *
 * Fixture law: every identity value is run-namespaced, no fixture is
 * "owned-but-NULL" (a row whose `user_id` resolves to a live contact while
 * `contact_id` is NULL — another file in this suite runs a global backfill
 * sweep that stamps exactly those mid-run), and no assertion counts rows
 * outside this run's namespace.
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

// A live Hatchet engine must never be reached from a unit suite; `ingestEvent`
// pushes every event and rethrows on a failed push, so the spy has to resolve.
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

const { contacts, emailPreferences, journeyStates } = await import(
  "@hogsend/db"
);
const { and, eq, inArray, isNull } = await import("drizzle-orm");
const {
  createHogsendClient,
  executeJourneyRun,
  hatchet,
  ingestEvent,
  JourneyRegistry,
  resolveOrCreateContact,
} = await import("@hogsend/engine");
type JourneyMeta = import("@hogsend/core/types").JourneyMeta;

const container = createHogsendClient();
const { db, logger } = container;

const RUN = `t4flip-${randomUUID()}`;
const uid = (label: string) => `${RUN}-${label}`;

// (a) — the anon-era key, the post-registration canonical key, the journey.
const A_ANON = uid("a-anon");
const A_USER = uid("a-user");
const A_JOURNEY = uid("a-journey");

// (b) — the contactless subject and its journey.
const B_ANON = uid("b-anon");
const B_JOURNEY = uid("b-journey");

// (c) — history written BEFORE its owner existed, under the same key.
const C_ANON = uid("c-anon");
const C_JOURNEY = uid("c-journey");

// (d) — the enrollment's stale key vs. the key the exit event arrives under.
const D_STALE = uid("d-stale");
const D_USER = uid("d-user");
const D_JOURNEY = uid("d-journey");

// (e) — the opt-out's stale key vs. the key the entry is triggered under.
const E_STALE = uid("e-stale");
const E_USER = uid("e-user");
const E_JOURNEY = uid("e-journey");
const E_EMAIL = `${uid("e")}@example.test`;

const createdContactIds: string[] = [];

afterAll(async () => {
  await db
    .delete(journeyStates)
    .where(
      inArray(journeyStates.journeyId, [
        A_JOURNEY,
        B_JOURNEY,
        C_JOURNEY,
        D_JOURNEY,
        E_JOURNEY,
      ]),
    );
  await db.delete(emailPreferences).where(eq(emailPreferences.userId, E_STALE));
  if (createdContactIds.length > 0) {
    await db.delete(contacts).where(inArray(contacts.id, createdContactIds));
  }
});

/** A `once` journey whose body is inert — the guard chain is the subject. */
function onceMeta(journeyId: string): JourneyMeta {
  return {
    id: journeyId,
    name: "Flip-reads entry limit",
    enabled: true,
    trigger: { event: `${RUN}.enroll` },
    entryLimit: "once",
    suppress: {},
  };
}

/** Durable ctx stub: no wait in the run body, so nothing durable is issued. */
function makeCtx(workflowRunId: string) {
  return {
    workflowRunId: () => workflowRunId,
    sleepFor: async () => ({}),
    waitFor: async () => ({}),
    now: async () => new Date(),
  };
}

describe("T4 — entry limit follows the CONTACT across the identity transition", () => {
  it("refuses a second entry to a `once` journey whose prior enrollment sits under the adopted anon key", async () => {
    const meta = onceMeta(A_JOURNEY);
    const run = async () => {};

    // (1) The anonymous era: no contact exists for A (the engine refuses to
    // mint one on observation), so the enrollment is contactless.
    const first = await executeJourneyRun({
      meta,
      run,
      input: {
        userId: A_ANON,
        userEmail: "",
        properties: {},
      },
      hatchetCtx: makeCtx(`${RUN}-wfr-1`),
    });
    expect(first).toMatchObject({ status: "completed" });

    const [anonRow] = await db
      .select({ id: journeyStates.id, contactId: journeyStates.contactId })
      .from(journeyStates)
      .where(
        and(
          eq(journeyStates.userId, A_ANON),
          eq(journeyStates.journeyId, A_JOURNEY),
        ),
      );
    expect(anonRow?.contactId).toBeNull();

    // (2) Registration mints the contact...
    const contact = await resolveOrCreateContact({ db, userId: A_USER });
    createdContactIds.push(contact.id);

    // ...and adoption stamps the anon-era history onto it (D4's statement).
    await db
      .update(journeyStates)
      .set({ contactId: contact.id })
      .where(
        and(
          eq(journeyStates.userId, A_ANON),
          isNull(journeyStates.contactId),
          eq(journeyStates.journeyId, A_JOURNEY),
        ),
      );

    // (3) The journey triggers again — now under the canonical key, with the
    // resolved subject pinned exactly as `ingestEvent` pushes it. The entry
    // limit is `once` and this person has already been through it, so the
    // guard must REFUSE. Reading `user_id = A_USER` finds nothing and
    // re-enrolls; reading `contact_id` finds the adopted row.
    const second = await executeJourneyRun({
      meta,
      run,
      input: {
        userId: A_USER,
        userEmail: "",
        properties: {},
        contactId: contact.id,
      },
      hatchetCtx: makeCtx(`${RUN}-wfr-2`),
    });
    expect(second).toEqual({
      status: "skipped",
      reason: "already_entered_once",
    });

    // …and no second enrollment row was minted for this journey.
    const rows = await db
      .select({ id: journeyStates.id, userId: journeyStates.userId })
      .from(journeyStates)
      .where(eq(journeyStates.journeyId, A_JOURNEY));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(A_ANON);
  });
});

describe("T4 — the contactless arm still exits", () => {
  it("exits an anon-only subject's active journey when the exitOn event arrives under the same anon key", async () => {
    const exitEvent = `${RUN}.exiter`;
    const registry = new JourneyRegistry();
    registry.register({
      id: B_JOURNEY,
      name: "Exits on demand",
      enabled: true,
      trigger: { event: `${RUN}.enroller` },
      entryLimit: "unlimited",
      suppress: {},
      exitOn: [{ event: exitEvent }],
    });

    // Contactless by construction: B_ANON owns no contact row, so this fixture
    // can never be "owned-but-NULL".
    const [state] = await db
      .insert(journeyStates)
      .values({
        userId: B_ANON,
        userEmail: "",
        journeyId: B_JOURNEY,
        currentNodeId: "start",
        status: "active",
      })
      .returning({ id: journeyStates.id });
    if (!state) throw new Error("journeyStates insert returned no row");

    const result = await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      allowCreate: false,
      event: {
        event: exitEvent,
        anonymousId: B_ANON,
        eventProperties: {},
        source: "api",
      },
    });

    expect(result.exits).toEqual([
      { journeyId: B_JOURNEY, stateId: state.id, exited: true },
    ]);
    const [after] = await db
      .select({ status: journeyStates.status })
      .from(journeyStates)
      .where(eq(journeyStates.id, state.id));
    expect(after?.status).toBe("exited");
  });
});

describe("T4 — history written before its owner existed, under the same key", () => {
  it("still exits after a contact is minted on the anon key the enrollment is keyed on", async () => {
    const exitEvent = `${RUN}.c-exiter`;
    const registry = new JourneyRegistry();
    registry.register({
      id: C_JOURNEY,
      name: "Exits on demand",
      enabled: true,
      trigger: { event: `${RUN}.c-enroller` },
      entryLimit: "unlimited",
      suppress: {},
      exitOn: [{ event: exitEvent }],
    });

    // (1) The anonymous era: an enrollment with no contact in existence.
    const [state] = await db
      .insert(journeyStates)
      .values({
        userId: C_ANON,
        userEmail: "",
        journeyId: C_JOURNEY,
        currentNodeId: "start",
        status: "active",
      })
      .returning({ id: journeyStates.id });
    if (!state) throw new Error("journeyStates insert returned no row");

    // (2) A contact is minted ON THAT VERY KEY — the shape an event carrying a
    // `value` (or any server-side resolve) produces. No key changes, so the
    // repoint is a no-op and only the own-key adoption stamp associates the
    // enrollment above with its brand-new owner.
    const contact = await resolveOrCreateContact({ db, anonymousId: C_ANON });
    createdContactIds.push(contact.id);
    const [stamped] = await db
      .select({ contactId: journeyStates.contactId })
      .from(journeyStates)
      .where(eq(journeyStates.id, state.id));
    expect(stamped?.contactId).toBe(contact.id);

    // (3) The exit event now resolves that contact, so the scan reads by
    // `contact_id`. Without the stamp above it would find nothing and the
    // journey would run on forever.
    const result = await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event: exitEvent,
        anonymousId: C_ANON,
        eventProperties: {},
        source: "api",
      },
    });
    expect(result.exits).toEqual([
      { journeyId: C_JOURNEY, stateId: state.id, exited: true },
    ]);
  });
});

describe("T4 — the exit scan follows the CONTACT across a key divergence", () => {
  it("exits an enrollment keyed on the adopted stale key when the exitOn event arrives under the canonical key", async () => {
    const exitEvent = `${RUN}.d-exiter`;
    const registry = new JourneyRegistry();
    registry.register({
      id: D_JOURNEY,
      name: "Exits on demand",
      enabled: true,
      trigger: { event: `${RUN}.d-enroller` },
      entryLimit: "unlimited",
      suppress: {},
      exitOn: [{ event: exitEvent }],
    });

    // (1) The stale-key era: an enrollment under D_STALE, a key no contact
    // owns (so the suite-wide backfill sweep can never stamp it out from
    // under this fixture).
    const [state] = await db
      .insert(journeyStates)
      .values({
        userId: D_STALE,
        userEmail: "",
        journeyId: D_JOURNEY,
        currentNodeId: "start",
        status: "active",
      })
      .returning({ id: journeyStates.id });
    if (!state) throw new Error("journeyStates insert returned no row");

    // (2) The contact exists under a DIFFERENT canonical key, and adoption
    // stamps the stale-keyed enrollment onto it — D4's statement verbatim,
    // which does NOT rewrite `user_id`. This is the divergence: the row is
    // reachable ONLY by `contact_id` from here on.
    const contact = await resolveOrCreateContact({ db, userId: D_USER });
    createdContactIds.push(contact.id);
    await db
      .update(journeyStates)
      .set({ contactId: contact.id })
      .where(
        and(
          eq(journeyStates.userId, D_STALE),
          isNull(journeyStates.contactId),
          eq(journeyStates.journeyId, D_JOURNEY),
        ),
      );

    // (3) The exit event arrives under the canonical key. `ingestEvent`
    // resolves the contact and hands it to the exit scan, which must reach the
    // stale-keyed enrollment. A `user_id = D_USER` scan sees nothing and the
    // journey keeps running on someone who has already exited.
    const result = await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event: exitEvent,
        userId: D_USER,
        eventProperties: {},
        source: "api",
      },
    });

    expect(result.exits).toEqual([
      { journeyId: D_JOURNEY, stateId: state.id, exited: true },
    ]);
    const [after] = await db
      .select({ status: journeyStates.status })
      .from(journeyStates)
      .where(eq(journeyStates.id, state.id));
    expect(after?.status).toBe("exited");
  });
});

describe("T4 — the unsubscribe guard follows the CONTACT across a key divergence", () => {
  it("refuses entry when the opt-out row sits under the adopted stale key", async () => {
    // (1) The opt-out is recorded under E_STALE — a key no contact owns, so
    // nothing in this suite can stamp it out from under the fixture.
    await db.insert(emailPreferences).values({
      userId: E_STALE,
      email: E_EMAIL,
      unsubscribedAll: true,
    });

    // (2) The contact exists under a DIFFERENT canonical key, and adoption
    // stamps the opt-out onto it without rewriting `user_id` (D4's statement).
    const contact = await resolveOrCreateContact({ db, userId: E_USER });
    createdContactIds.push(contact.id);
    await db
      .update(emailPreferences)
      .set({ contactId: contact.id })
      .where(
        and(
          eq(emailPreferences.userId, E_STALE),
          isNull(emailPreferences.contactId),
        ),
      );

    // (3) Entry is triggered under the canonical key, with the subject pinned
    // exactly as `ingestEvent` pushes it. `entryLimit` is `unlimited`, so the
    // preference guard is the ONLY thing that can refuse — and it must, since
    // this person unsubscribed. Reading `user_id = E_USER` finds no row,
    // reports subscribed, and mails an unsubscriber.
    const result = await executeJourneyRun({
      meta: {
        id: E_JOURNEY,
        name: "Flip-reads unsubscribe guard",
        enabled: true,
        trigger: { event: `${RUN}.e-enroll` },
        entryLimit: "unlimited",
        suppress: {},
      },
      run: async () => {},
      input: {
        userId: E_USER,
        userEmail: "",
        properties: {},
        contactId: contact.id,
      },
      hatchetCtx: makeCtx(`${RUN}-wfr-e`),
    });
    expect(result).toEqual({ status: "skipped", reason: "user_unsubscribed" });

    // …and no enrollment row was minted for this journey.
    const rows = await db
      .select({ id: journeyStates.id })
      .from(journeyStates)
      .where(eq(journeyStates.journeyId, E_JOURNEY));
    expect(rows).toHaveLength(0);
  });
});
