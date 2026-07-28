/**
 * D11 — the refusal is inherited by every re-ingest DERIVED from a refused
 * event.
 *
 * PRD 02 site 1 made a publishable browser event pure OBSERVATION: it stores
 * under the anon key and mints NO contact. Since then a journey's `userId` is
 * routinely a browser anon id owning no contact row — `ingestEvent` pushes
 * `userId: resolvedKey` and OMITS `contactId` on a refusal. Any downstream
 * re-ingest that re-resolves that key create-on-miss reads it as kind
 * "external" (`findByKey`) and writes `external_id = <anonId>`: a ghost
 * strictly WORSE than the one being removed, because `collidesWithIdentified`
 * returns true for it and `resolveFeedRecipient` then 403-locks the visitor out
 * of their own bell.
 *
 * Two journey-derived legs still did that after PRD 02:
 *   - `executeJourneyRun`'s holdout diversion (`journey.heldout`)
 *   - `ctx.trigger`
 *
 * Both are proven here end-to-end against the real Postgres: refuse a real
 * publishable event, drive the derived leg with EXACTLY the payload shape
 * `ingestEvent` pushes for a refusal, then assert zero contacts own the key and
 * the bell still reads 200. Each leg also carries controls proving the verdict
 * is DERIVED — an asserted email still creates, an existing contact still folds
 * — so a hardcoded `allowCreate: false` fails just as loudly as no guard.
 */

process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Both derived legs run on the engine's MODULE-LEVEL hatchet
// (`execute-journey-run.ts` imports it directly), so the singleton itself has
// to be mocked — a container `overrides.hatchet` never reaches them.
const { hatchetMock } = vi.hoisted(() => {
  const hatchetMock = () => ({
    hatchet: {
      durableTask: vi.fn(() => ({
        run: vi.fn(),
        runNoWait: vi.fn(),
        runAndWait: vi.fn(),
      })),
      task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn(async () => ({})) })),
      events: { push: vi.fn(async () => {}) },
      runs: { cancel: vi.fn(async () => {}), get: vi.fn() },
      worker: vi.fn(),
    },
  });
  return { hatchetMock };
});
vi.mock("../../../../packages/engine/src/lib/hatchet.ts", hatchetMock);
vi.mock("../../../../packages/engine/src/lib/hatchet.js", hatchetMock);

const { apiKeys, contacts, journeyStates, userEvents } = await import(
  "@hogsend/db"
);
const { eq, like, or } = await import("drizzle-orm");
const {
  createApp,
  createHogsendClient,
  createJourneyContext,
  executeJourneyRun,
  isHeldOut,
} = await import("@hogsend/engine");
type HogsendClient = ReturnType<typeof createHogsendClient>;
type JourneyMeta = import("@hogsend/core/types").JourneyMeta;

const mockHatchet = {
  durableTask: vi.fn(() => ({
    run: vi.fn(),
    runNoWait: vi.fn(),
    runAndWait: vi.fn(),
  })),
  task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
  events: { push: vi.fn() },
  runs: { cancel: vi.fn(), get: vi.fn() },
  worker: vi.fn(),
} as unknown as HogsendClient["hatchet"];

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const app = createApp(container);
const { db } = container;

// RUN-namespaced so the shared dev DB never collides across files and the
// afterAll cleanup is precise.
const RUN = `d11-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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

beforeAll(async () => {
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
  await db.delete(journeyStates).where(like(journeyStates.userId, `${RUN}-%`));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  // A regression stamps `external_id`; the creating controls stamp
  // `external_id` / `anonymous_id` / `email`. None may be left behind.
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.anonymousId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.email, `${RUN}-%`));

  for (const id of createdKeyIds) {
    await db.delete(apiKeys).where(eq(apiKeys.id, id));
  }
});

/** Every live contact row owning `key` as EITHER identity key. */
async function contactsForKey(key: string) {
  return db
    .select({
      id: contacts.id,
      externalId: contacts.externalId,
      anonymousId: contacts.anonymousId,
      email: contacts.email,
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

/** Read the bell exactly as an unidentified browser does: pk_ key + anon id. */
function readBell(anonymousId: string) {
  return app.request(
    `/v1/feed?anonymousId=${encodeURIComponent(anonymousId)}`,
    { method: "GET", headers: PK_HEADERS },
  );
}

/**
 * The premise, in PRODUCTION shape — never seeded by hand. A publishable event
 * for an unseen anon id is pure observation, so it stores and mints nothing.
 */
async function refuseAnonEvent(anon: string) {
  const res = await app.request("/v1/events", {
    method: "POST",
    headers: PK_HEADERS,
    body: JSON.stringify({ name: `${RUN}.entry`, anonymousId: anon }),
  });
  expect(res.status).toBe(202);
  expect(await contactsForKey(anon)).toHaveLength(0);
}

// ===========================================================================
// Leg 1 — `executeJourneyRun`'s holdout diversion emits `journey.heldout`.
// ===========================================================================
describe("D11 leg 1 — the journey.heldout re-ingest", () => {
  const JOURNEY_ID = `${RUN}-holdout`;
  const meta: JourneyMeta = {
    id: JOURNEY_ID,
    name: "D11 holdout probe",
    enabled: true,
    trigger: { event: `${RUN}.entry` },
    entryLimit: "unlimited",
    suppress: {},
    holdout: { percent: 50 },
  };

  /**
   * Holdout assignment is a deterministic hash of (userId, journeyId, salt) —
   * no RNG, by the replay law — so a RUN-namespaced key is only ~50% likely to
   * divert. Search the namespace for one that actually does, using the engine's
   * own predicate, so the test never flakes and never asserts on a key that
   * skipped the leg under test.
   */
  function divertedKey(label: string): string {
    for (let i = 0; i < 500; i += 1) {
      const candidate = `${uid(label)}-${i}`;
      if (
        isHeldOut({ userId: candidate, journeyId: JOURNEY_ID, percent: 50 })
      ) {
        return candidate;
      }
    }
    throw new Error("no held-out candidate in 500 tries");
  }

  const hatchetCtx = {
    workflowRunId: () => `${RUN}-holdout-${Math.random()}`,
    sleepFor: async () => ({}),
    waitFor: async () => ({}),
    now: async () => new Date(),
  };

  const neverRuns = async () => {
    throw new Error("a held-out enrollment must never execute run()");
  };

  it("inherits a refused entry event's refusal", async () => {
    const anon = divertedKey("heldout-anon");
    await refuseAnonEvent(anon);

    const result = await executeJourneyRun({
      meta,
      run: neverRuns,
      // EXACTLY what `ingestEvent` pushes for a REFUSED event: the resolved key
      // as `userId`, `""` for the email, and NO `contactId` key at all.
      input: { userId: anon, userEmail: "", properties: {} },
      hatchetCtx,
    });
    expect(result).toEqual({ status: "skipped", reason: "held_out" });

    // Observation is never lost (D2) — the counterfactual still hits the spine.
    const events = await eventsForKey(anon);
    expect(events.map((e) => e.event)).toContain("journey.heldout");

    // The load-bearing assertion. Before the thread this is one row with
    // `external_id = <anon>`.
    expect(await contactsForKey(anon)).toHaveLength(0);

    // …so the visitor can still read their own bell. Before the thread this
    // GET is a 403 ("anonymousId is not addressable").
    expect((await readBell(anon)).status).toBe(200);
  });

  it("pins to an anon-keyed contact instead of minting an external twin", async () => {
    // The provenance leg specifically: the enrollment's own timezone fetch
    // reads `contacts.external_id` ONLY, which misses a contact whose canonical
    // key is its `anonymous_id`. Resolving by EITHER identity column is what
    // lets this fold instead of minting `external_id = <anon>` beside it.
    const anon = divertedKey("heldout-anonrow");
    await db.insert(contacts).values({ anonymousId: anon });

    await executeJourneyRun({
      meta,
      run: neverRuns,
      input: { userId: anon, userEmail: "", properties: {} },
      hatchetCtx,
    });

    const rows = await contactsForKey(anon);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.externalId).toBeNull();
    expect(rows[0]?.anonymousId).toBe(anon);
  });

  it("an email-asserting held-out run STILL creates (the verdict is derived)", async () => {
    // The guard must not be a hardcoded refusal: an email is a durable identity
    // the caller is asserting (D1), so an identified held-out contact keeps
    // getting its row. Drop the `userEmail` arm and this goes red.
    const key = divertedKey("heldout-email");
    const email = `${key}@example.test`;

    await executeJourneyRun({
      meta,
      run: neverRuns,
      input: { userId: key, userEmail: email, properties: {} },
      hatchetCtx,
    });

    const rows = await contactsForKey(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.externalId).toBe(key);
    expect(rows[0]?.email).toBe(email);
  });
});

// ===========================================================================
// Leg 2 — `ctx.trigger` (the cross-journey re-ingest).
// ===========================================================================
describe("D11 leg 2 — the ctx.trigger re-ingest", () => {
  async function seedState(userId: string, userEmail = ""): Promise<string> {
    const [row] = await db
      .insert(journeyStates)
      .values({
        userId,
        userEmail,
        journeyId: `${RUN}-trigger-journey`,
        currentNodeId: "start",
        status: "active",
      })
      .returning({ id: journeyStates.id });
    return row?.id ?? "";
  }

  function makeCtx(opts: {
    stateId: string;
    userId: string;
    userEmail?: string;
    contactId?: string;
  }) {
    return createJourneyContext({
      db: db as Parameters<typeof createJourneyContext>[0]["db"],
      hatchet: container.hatchet,
      hatchetCtx: {
        sleepFor: vi.fn() as unknown as (d: unknown) => Promise<unknown>,
        waitFor: vi.fn() as unknown as (
          c: unknown,
        ) => Promise<Record<string, unknown>>,
      },
      registry: container.registry,
      // biome-ignore lint/suspicious/noExplicitAny: minimal logger stub
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      stateId: opts.stateId,
      userId: opts.userId,
      // `ingestEvent` pushes `userEmail ?? ""`, so an anonymous run's journey
      // context carries the empty string — not undefined.
      userEmail: opts.userEmail ?? "",
      journeyContext: {},
      resolvedTimezone: "UTC",
      journeyId: `${RUN}-trigger-journey`,
      ...(opts.contactId ? { contactId: opts.contactId } : {}),
    });
  }

  it("inherits a refused entry event's refusal", async () => {
    const anon = uid("trigger-anon");
    await refuseAnonEvent(anon);

    const ctx = makeCtx({ stateId: await seedState(anon), userId: anon });
    await ctx.trigger({ event: `${RUN}.derived`, userId: anon });

    // Observation is never lost (D2).
    const events = await eventsForKey(anon);
    expect(events.map((e) => e.event)).toContain(`${RUN}.derived`);

    // The load-bearing assertion. Before the thread this is one row with
    // `external_id = <anon>`.
    expect(await contactsForKey(anon)).toHaveLength(0);
    expect((await readBell(anon)).status).toBe(200);
  });

  it("pins to the run's own subject instead of minting an external twin", async () => {
    // An identified run: `executeJourneyRun` threads the subject row id into
    // the context, so the trigger folds there by row id rather than value-
    // probing its canonical key (which reads as kind "external" and mints).
    const anon = uid("trigger-known");
    const [row] = await db
      .insert(contacts)
      .values({ anonymousId: anon })
      .returning({ id: contacts.id });
    if (!row) throw new Error("failed to seed contact");

    const ctx = makeCtx({
      stateId: await seedState(anon),
      userId: anon,
      contactId: row.id,
    });
    await ctx.trigger({ event: `${RUN}.pinned`, userId: anon });

    const rows = await contactsForKey(anon);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(row.id);
    expect(rows[0]?.externalId).toBeNull();
  });

  it("an email-asserting trigger STILL creates (the verdict is derived)", async () => {
    // Same anti-hardcode guard as leg 1: the run asserts an email, so the
    // trigger keeps creating. Drop the email arm and this goes red.
    const key = uid("trigger-email");
    const email = `${key}@example.test`;

    const ctx = makeCtx({
      stateId: await seedState(key, email),
      userId: key,
      userEmail: email,
    });
    await ctx.trigger({ event: `${RUN}.emailed`, userId: key });

    const rows = await contactsForKey(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.externalId).toBe(key);
    expect(rows[0]?.email).toBe(email);
  });

  it("a cross-user trigger is NEVER pinned to the run's own subject", async () => {
    // The pin is provenance for THIS subject only. Applied to an
    // author-overridden `userId` it would misattribute the event to the run's
    // own subject — the event would key on the subject's canonical key and the
    // target would never get a row of its own.
    const subject = uid("trigger-subject");
    const [subjectRow] = await db
      .insert(contacts)
      .values({ externalId: subject })
      .returning({ id: contacts.id });
    if (!subjectRow) throw new Error("failed to seed subject");

    const target = uid("trigger-target");
    const targetEmail = `${target}@example.test`;

    const ctx = makeCtx({
      stateId: await seedState(subject),
      userId: subject,
      contactId: subjectRow.id,
    });
    await ctx.trigger({
      event: `${RUN}.crossuser`,
      userId: target,
      userEmail: targetEmail,
    });

    // The target owns the event and its own row…
    expect((await eventsForKey(target)).map((e) => e.event)).toContain(
      `${RUN}.crossuser`,
    );
    const targetRows = await contactsForKey(target);
    expect(targetRows).toHaveLength(1);
    expect(targetRows[0]?.id).not.toBe(subjectRow.id);

    // …and the run's subject was not credited with it.
    expect((await eventsForKey(subject)).map((e) => e.event)).not.toContain(
      `${RUN}.crossuser`,
    );
  });

  it("a cross-user trigger from an ANON run still creates the target", async () => {
    // D11 binds the refusal to the RUN's own subject — but only the SELF arm is
    // derived from that subject. On the cross-user arm the pin is `undefined` BY
    // CONSTRUCTION (previous test), so a verdict computed from it collapses to
    // the run's own `userEmail` — `""` for an anonymous run — and refuses to
    // mint a row for a person the author NAMED. That inverts D1: naming a
    // specific `userId` is the "server-side caller explicitly asks" case, and
    // the target is not the observed anonymous visitor at all. It also silently
    // strips the target of everything gated on a non-null `contact_id`:
    // conversions, attribution credits, funnel progress, deals.
    const subject = uid("xuser-anonrun-subject");
    await refuseAnonEvent(subject);

    const target = uid("xuser-anonrun-target");

    // No `contactId`, no `userEmail` — exactly what an anonymous run carries.
    const ctx = makeCtx({ stateId: await seedState(subject), userId: subject });
    await ctx.trigger({ event: `${RUN}.xuser`, userId: target });

    const targetRows = await contactsForKey(target);
    expect(targetRows).toHaveLength(1);
    expect(targetRows[0]?.externalId).toBe(target);

    // …and the fix must not degenerate into "always create": the run's own
    // anonymous subject is still pure observation and still owns no row.
    expect(await contactsForKey(subject)).toHaveLength(0);
  });
});
