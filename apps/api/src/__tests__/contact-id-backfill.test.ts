/**
 * PRD 04 T5 — the `contact_id` backfill: a chunked, resumable, periodically
 * re-runnable Hatchet task (NEVER a migration).
 *
 * The fixture IS the test (T5's own words). It covers every resolution outcome
 * the PRD locks:
 *   (a) canonical key = `external_id`, rows in ALL FIVE tables
 *   (b) canonical key = `anonymous_id`
 *   (c) canonical key = the contact's row uuid (email-only contact)
 *   (d) a key owning NO live contact — stays NULL FOREVER (D5)
 *   (e) a STALE key only `contact_aliases` knows — pass 2 (D4)
 *   (f) one value under BOTH permitted alias kinds pointing at DIFFERENT live
 *       contacts — skipped and logged, never guessed (D4)
 *
 * Plus the three properties that make the job safe to run on production:
 * nothing but `contact_id` is ever written, a re-run updates zero rows, and the
 * per-statement bound is honoured (rows-per-statement = 1 reaches the same end
 * state, so the loop terminates).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// DB-touching test. Point a worktree at its own stack with
// HOGSEND_TEST_DATABASE_URL — never by editing the default.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Config-preserving hatchet mock (the documented seam): `task()` returns its own
// config, so `.fn` IS the real task body and `.runNoWait` is a spy for the
// boot-enqueue assertions. Both the engine's absolute source path and the API's
// relative one resolve to ONE mock.
const { hatchetMock } = vi.hoisted(() => {
  const factory = () => ({
    hatchet: {
      durableTask: vi.fn((config: Record<string, unknown>) => ({
        ...config,
        run: vi.fn(() => Promise.resolve()),
        runNoWait: vi.fn(() => Promise.resolve()),
        runAndWait: vi.fn(() => Promise.resolve()),
      })),
      task: vi.fn((config: Record<string, unknown>) => ({
        ...config,
        run: vi.fn(() => Promise.resolve()),
        runNoWait: vi.fn(() => Promise.resolve()),
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
  emailSends,
  importJobs,
  journeyStates,
  userEvents,
} = await import("@hogsend/db");
const { eq, inArray, sql } = await import("drizzle-orm");
const {
  CONTACT_ID_BACKFILL_FORMAT,
  contactIdBackfillTask,
  contactIdResweepIntervalMs,
  createHogsendClient,
  enqueueContactIdBackfill,
} = await import("@hogsend/engine");

const container = createHogsendClient();
const { db, logger } = container;

const RUN = `cidb-${randomUUID().slice(0, 8)}`;
const uid = (label: string) => `${RUN}-${label}`;

// ---------------------------------------------------------------------------
// fixture plumbing
// ---------------------------------------------------------------------------

type TableKey =
  | "user_events"
  | "journey_states"
  | "bucket_memberships"
  | "email_sends"
  | "email_preferences";

const ALL_TABLES: TableKey[] = [
  "user_events",
  "journey_states",
  "bucket_memberships",
  "email_sends",
  "email_preferences",
];

type IdSet = Record<TableKey, string[]>;
type Rows = Array<Record<string, unknown>>;
type Snapshot = Record<TableKey, Rows>;

const emptyIds = (): IdSet => ({
  user_events: [],
  journey_states: [],
  bucket_memberships: [],
  email_sends: [],
  email_preferences: [],
});

function mergeIds(...sets: IdSet[]): IdSet {
  const out = emptyIds();
  for (const set of sets) {
    for (const table of ALL_TABLES) out[table].push(...set[table]);
  }
  return out;
}

const createdContactIds: string[] = [];
const seededIds = emptyIds();

async function seedContact(
  values: Partial<typeof contacts.$inferInsert>,
): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values(values)
    .returning({ id: contacts.id });
  if (!row) throw new Error("seedContact insert returned no row");
  createdContactIds.push(row.id);
  return row.id;
}

/**
 * One NULL-stamped history row per requested table, all keyed on `key`. Inserted
 * DIRECTLY (never through the engine) so no dual-write pre-fills `contact_id` —
 * this is the pre-column-era population the backfill exists for.
 */
async function seedRows(key: string, tables: TableKey[]): Promise<IdSet> {
  const ids = emptyIds();

  if (tables.includes("user_events")) {
    const [row] = await db
      .insert(userEvents)
      .values({ userId: key, event: `${RUN}.seed`, properties: {} })
      .returning({ id: userEvents.id });
    if (row) ids.user_events.push(row.id);
  }
  if (tables.includes("journey_states")) {
    const [row] = await db
      .insert(journeyStates)
      .values({
        userId: key,
        userEmail: `${key}@example.com`,
        journeyId: uid("journey"),
        currentNodeId: "start",
      })
      .returning({ id: journeyStates.id });
    if (row) ids.journey_states.push(row.id);
  }
  if (tables.includes("bucket_memberships")) {
    const [row] = await db
      .insert(bucketMemberships)
      .values({ userId: key, bucketId: uid("bucket") })
      .returning({ id: bucketMemberships.id });
    if (row) ids.bucket_memberships.push(row.id);
  }
  if (tables.includes("email_sends")) {
    const [row] = await db
      .insert(emailSends)
      .values({
        userId: key,
        fromEmail: "seed@example.com",
        toEmail: `${key}@example.com`,
        subject: `${RUN} seed`,
      })
      .returning({ id: emailSends.id });
    if (row) ids.email_sends.push(row.id);
  }
  if (tables.includes("email_preferences")) {
    const [row] = await db
      .insert(emailPreferences)
      .values({ userId: key, email: `${key}@example.com` })
      .returning({ id: emailPreferences.id });
    if (row) ids.email_preferences.push(row.id);
  }

  for (const table of ALL_TABLES) seededIds[table].push(...ids[table]);
  return ids;
}

/** `SELECT *` for the given rows — every column, so "nothing else changed" is
 * checkable rather than assumed. */
async function snapshot(ids: IdSet): Promise<Snapshot> {
  const pick = async <T>(
    rowIds: string[],
    read: () => Promise<T[]>,
  ): Promise<Rows> =>
    rowIds.length === 0 ? [] : ((await read()) as unknown as Rows);

  return {
    user_events: await pick(ids.user_events, () =>
      db
        .select()
        .from(userEvents)
        .where(inArray(userEvents.id, ids.user_events))
        .orderBy(userEvents.id),
    ),
    journey_states: await pick(ids.journey_states, () =>
      db
        .select()
        .from(journeyStates)
        .where(inArray(journeyStates.id, ids.journey_states))
        .orderBy(journeyStates.id),
    ),
    bucket_memberships: await pick(ids.bucket_memberships, () =>
      db
        .select()
        .from(bucketMemberships)
        .where(inArray(bucketMemberships.id, ids.bucket_memberships))
        .orderBy(bucketMemberships.id),
    ),
    email_sends: await pick(ids.email_sends, () =>
      db
        .select()
        .from(emailSends)
        .where(inArray(emailSends.id, ids.email_sends))
        .orderBy(emailSends.id),
    ),
    email_preferences: await pick(ids.email_preferences, () =>
      db
        .select()
        .from(emailPreferences)
        .where(inArray(emailPreferences.id, ids.email_preferences))
        .orderBy(emailPreferences.id),
    ),
  };
}

/** Every column EXCEPT `contact_id`, for the before/after deep-compare. */
function withoutContactId(snap: Snapshot): Record<TableKey, Rows> {
  const out = {} as Record<TableKey, Rows>;
  for (const table of ALL_TABLES) {
    out[table] = snap[table].map(({ contactId: _ignored, ...rest }) => rest);
  }
  return out;
}

/** rowId → contact_id, flattened across the five tables. */
function stampsById(snap: Snapshot): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const table of ALL_TABLES) {
    for (const row of snap[table]) {
      out.set(row.id as string, (row.contactId as string | null) ?? null);
    }
  }
  return out;
}

/** Physical row version. Unchanged xmin ⇒ the row was not rewritten — the
 * strongest available "this UPDATE really did nothing" evidence. */
async function xminOf(ids: IdSet): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const table of ALL_TABLES) {
    const rowIds = ids[table];
    if (rowIds.length === 0) continue;
    const rows = await db.execute<{ id: string; xmin: string }>(sql`
      SELECT id::text AS id, xmin::text AS xmin
        FROM ${sql.identifier(table)}
       WHERE id IN (${sql.join(
         rowIds.map((i) => sql`${i}::uuid`),
         sql`, `,
       )})
    `);
    for (const row of rows) out.set(row.id, row.xmin);
  }
  return out;
}

interface BackfillResult {
  status: string;
  contactsScanned: number;
  canonical: Record<TableKey, number>;
  alias: Record<TableKey, number>;
  updated: number;
  ambiguousAliases: number;
  statements: number;
}

/** `.fn` survives the config-preserving hatchet mock — the documented seam. */
const backfillTask = contactIdBackfillTask as unknown as {
  fn: (input: {
    jobId?: string;
    contactsPerChunk?: number;
    rowsPerStatement?: number;
    pauseMs?: number;
  }) => Promise<BackfillResult>;
};

const runNoWaitSpy = (
  contactIdBackfillTask as unknown as {
    runNoWait: ReturnType<typeof vi.fn>;
  }
).runNoWait;

// ---------------------------------------------------------------------------
// the fixture (a)–(f)
// ---------------------------------------------------------------------------

// (a) canonical key = external_id; rows in ALL FIVE tables.
const keyA = uid("a-ext");
// (b) canonical key = anonymous_id.
const keyB = uid("b-anon");
// (d) owns no contact at all.
const keyD = uid("d-orphan");
// (e) a stale key that ONLY contact_aliases knows.
const keyE = uid("e-stale");
// (f) one value under BOTH permitted kinds, pointing at two DIFFERENT contacts.
const keyF = uid("f-ambiguous");

let contactA = "";
let contactB = "";
let contactC = "";
let idsA: IdSet;
let idsB: IdSet;
let idsC: IdSet;
let idsD: IdSet;
let idsE: IdSet;
let idsF: IdSet;
let allIds: IdSet;

// vitest runs a file's `it`s in declaration order, and these cases share one
// database-wide fixture on purpose: the "re-run updates zero rows" assertion is
// only meaningful if NOTHING new was seeded between the two runs.
beforeAll(async () => {
  contactA = await seedContact({
    externalId: keyA,
    email: `${uid("a")}@example.com`,
  });
  contactB = await seedContact({ anonymousId: keyB });
  // Email-only ⇒ coalesce falls through to the row uuid (contactKey's 3rd leg).
  contactC = await seedContact({ email: `${uid("c")}@example.com` });

  const contactF1 = await seedContact({ externalId: uid("f1-ext") });
  const contactF2 = await seedContact({ externalId: uid("f2-ext") });

  idsA = await seedRows(keyA, ALL_TABLES);
  idsB = await seedRows(keyB, ["user_events", "journey_states"]);
  idsC = await seedRows(contactC, ["email_sends", "email_preferences"]);
  idsD = await seedRows(keyD, ["user_events", "bucket_memberships"]);
  idsE = await seedRows(keyE, ["user_events", "email_sends"]);
  idsF = await seedRows(keyF, ["user_events"]);

  await db.insert(contactAliases).values([
    // (e) — a merge-era stale key resolving to contact (a).
    {
      contactId: contactA,
      aliasKind: "external",
      aliasValue: keyE,
      reason: "merge",
    },
    // (f) — the SAME value under both permitted kinds, disagreeing on owner.
    // `uniqueIndex(alias_kind, alias_value)` is per-KIND, so this is legal data.
    {
      contactId: contactF1,
      aliasKind: "external",
      aliasValue: keyF,
      reason: "merge",
    },
    {
      contactId: contactF2,
      aliasKind: "anonymous",
      aliasValue: keyF,
      reason: "merge",
    },
  ]);

  allIds = mergeIds(idsA, idsB, idsC, idsD, idsE, idsF);
});

afterAll(async () => {
  await db
    .delete(userEvents)
    .where(inArray(userEvents.id, seededIds.user_events));
  await db
    .delete(journeyStates)
    .where(inArray(journeyStates.id, seededIds.journey_states));
  await db
    .delete(bucketMemberships)
    .where(inArray(bucketMemberships.id, seededIds.bucket_memberships));
  await db
    .delete(emailSends)
    .where(inArray(emailSends.id, seededIds.email_sends));
  await db
    .delete(emailPreferences)
    .where(inArray(emailPreferences.id, seededIds.email_preferences));
  if (createdContactIds.length > 0) {
    // contact_aliases.contact_id cascades on delete.
    await db.delete(contacts).where(inArray(contacts.id, createdContactIds));
  }
  await db
    .delete(importJobs)
    .where(eq(importJobs.format, CONTACT_ID_BACKFILL_FORMAT));
  await container.dbClient.end({ timeout: 5 }).catch(() => {});
});

// ---------------------------------------------------------------------------

describe("contactIdBackfillTask", () => {
  let firstRun: BackfillResult;
  let jobId = "";
  let before: Snapshot;
  let after: Snapshot;

  it("stamps every canonical + alias key, leaves the orphan and the ambiguous alias NULL, and touches no other column", async () => {
    before = await snapshot(allIds);
    // Pre-condition: the whole fixture starts NULL, so every non-NULL below is
    // the job's doing.
    for (const value of stampsById(before).values()) expect(value).toBeNull();

    const [job] = await db
      .insert(importJobs)
      .values({
        fileName: CONTACT_ID_BACKFILL_FORMAT,
        format: CONTACT_ID_BACKFILL_FORMAT,
        status: "pending",
      })
      .returning({ id: importJobs.id });
    if (!job) throw new Error("failed to create import job");
    jobId = job.id;

    // Defaults for the chunk/statement bounds; only the pace is zeroed so the
    // suite does not idle 25ms per written statement.
    firstRun = await backfillTask.fn({ jobId, pauseMs: 0 });
    expect(firstRun.status).toBe("completed");

    after = await snapshot(allIds);
    const stamps = stampsById(after);

    // (a) canonical key = external_id — all FIVE tables.
    for (const table of ALL_TABLES) {
      for (const id of idsA[table]) expect(stamps.get(id)).toBe(contactA);
    }
    // (b) canonical key = anonymous_id.
    for (const id of [...idsB.user_events, ...idsB.journey_states]) {
      expect(stamps.get(id)).toBe(contactB);
    }
    // (c) canonical key = the row uuid (email-only contact).
    for (const id of [...idsC.email_sends, ...idsC.email_preferences]) {
      expect(stamps.get(id)).toBe(contactC);
    }
    // (d) no live contact owns the key ⇒ NULL. Forever. That is correct (D5).
    for (const id of [...idsD.user_events, ...idsD.bucket_memberships]) {
      expect(stamps.get(id)).toBeNull();
    }
    // (e) stale key only contact_aliases knows ⇒ pass 2 resolves it to (a).
    for (const id of [...idsE.user_events, ...idsE.email_sends]) {
      expect(stamps.get(id)).toBe(contactA);
    }
    // (f) one value, two permitted kinds, two owners ⇒ skipped, never guessed.
    for (const id of idsF.user_events) expect(stamps.get(id)).toBeNull();
    expect(firstRun.ambiguousAliases).toBeGreaterThanOrEqual(1);

    // NOTHING ELSE CHANGED — every column but `contact_id`, byte for byte.
    expect(withoutContactId(after)).toEqual(withoutContactId(before));

    // The job reported what it touched, per table and in total.
    expect(firstRun.canonical.user_events).toBeGreaterThanOrEqual(2); // a + b
    expect(firstRun.canonical.email_preferences).toBeGreaterThanOrEqual(2);
    expect(firstRun.alias.user_events).toBeGreaterThanOrEqual(1); // (e)
    expect(firstRun.alias.email_sends).toBeGreaterThanOrEqual(1);
    // 5 (a) + 2 (b) + 2 (c) + 2 (e); (d) and (f) are legitimately unstamped.
    expect(firstRun.updated).toBeGreaterThanOrEqual(11);
  });

  it("records progress on the import_jobs row and ends completed with sane totals", async () => {
    const [row] = await db
      .select()
      .from(importJobs)
      .where(eq(importJobs.id, jobId))
      .limit(1);
    expect(row?.status).toBe("completed");
    // totalRows = live contacts; processedRows = contacts walked. The fixture
    // alone contributes five live contacts.
    expect(row?.totalRows ?? 0).toBeGreaterThanOrEqual(5);
    expect(row?.processedRows).toBe(row?.totalRows);
    expect(row?.processedRows).toBe(firstRun.contactsScanned);
    // failedRows carries the ambiguous-alias divergence metric, NOT errors.
    expect(row?.failedRows).toBe(firstRun.ambiguousAliases);
    expect(row?.errors).toBeNull();
  });

  it("re-runs for free: zero rows updated, no row rewritten", async () => {
    const xminBefore = await xminOf(allIds);

    const second = await backfillTask.fn({ pauseMs: 0 });
    expect(second.status).toBe("completed");

    // The `contact_id IS NULL` guard is the whole point — remove it and this
    // goes red (the PRD's named mutation proof).
    expect(second.updated).toBe(0);
    for (const table of ALL_TABLES) {
      expect(second.canonical[table]).toBe(0);
      expect(second.alias[table]).toBe(0);
    }
    // …and physically: same tuple versions, so nothing was rewritten.
    expect(await xminOf(allIds)).toEqual(xminBefore);
    expect(withoutContactId(await snapshot(allIds))).toEqual(
      withoutContactId(before),
    );
  });
});

describe("the per-statement bound", () => {
  it("reaches the same end state with rows-per-statement = 1", async () => {
    // A FRESH fixture (the earlier one is fully stamped), fat enough that a
    // cap of 1 forces many iterations of the same loop.
    const key = uid("bound-ext");
    const stale = uid("bound-stale");
    const contact = await seedContact({ externalId: key });

    const ids = mergeIds(
      await seedRows(key, ["user_events", "email_sends"]),
      await seedRows(key, ["user_events"]),
      await seedRows(key, ["user_events"]),
      await seedRows(stale, ["user_events"]),
      await seedRows(stale, ["user_events"]),
    );
    await db.insert(contactAliases).values({
      contactId: contact,
      aliasKind: "anonymous",
      aliasValue: stale,
      reason: "promote",
    });

    const result = await backfillTask.fn({ rowsPerStatement: 1, pauseMs: 0 });
    expect(result.status).toBe("completed");

    const stamps = stampsById(await snapshot(ids));
    expect(stamps.size).toBe(6);
    for (const value of stamps.values()) expect(value).toBe(contact);

    // 4 rows under the canonical key + 2 under the stale alias, one row per
    // statement, plus a terminating zero-row statement per (key, table): the
    // loop necessarily issued MORE statements than it wrote rows.
    expect(result.updated).toBe(6);
    expect(result.statements).toBeGreaterThan(result.updated);
  });
});

describe("enqueueContactIdBackfill (worker boot, D6 re-sweep)", () => {
  it("enqueues when no completed sweep exists, skips a fresh one, re-fires a stale one", async () => {
    await db
      .delete(importJobs)
      .where(eq(importJobs.format, CONTACT_ID_BACKFILL_FORMAT));
    runNoWaitSpy.mockClear();

    // No job record at all ⇒ first sweep.
    await enqueueContactIdBackfill({ db, logger });
    expect(runNoWaitSpy).toHaveBeenCalledTimes(1);

    // A pending (in-flight) record always wins — two sweeps must never stack.
    await enqueueContactIdBackfill({ db, logger });
    expect(runNoWaitSpy).toHaveBeenCalledTimes(1);

    // A FRESH completed sweep ⇒ still skipped.
    await db
      .update(importJobs)
      .set({ status: "completed", updatedAt: new Date() })
      .where(eq(importJobs.format, CONTACT_ID_BACKFILL_FORMAT));
    await enqueueContactIdBackfill({ db, logger });
    expect(runNoWaitSpy).toHaveBeenCalledTimes(1);

    // Backdated past the 24h re-sweep interval ⇒ it fires again. This is the
    // difference from the alias backfill's once-per-deployment gate: the
    // dual-write is best-effort, so a miss is only self-healing while a LATER
    // sweep still exists (D6).
    await db
      .update(importJobs)
      .set({ updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(importJobs.format, CONTACT_ID_BACKFILL_FORMAT));
    await enqueueContactIdBackfill({ db, logger });
    expect(runNoWaitSpy).toHaveBeenCalledTimes(2);
  });

  it("validates the re-sweep interval override", () => {
    const original = process.env.CONTACT_ID_BACKFILL_RESWEEP_HOURS;
    try {
      delete process.env.CONTACT_ID_BACKFILL_RESWEEP_HOURS;
      expect(contactIdResweepIntervalMs()).toBe(24 * 60 * 60 * 1000);

      process.env.CONTACT_ID_BACKFILL_RESWEEP_HOURS = "6";
      expect(contactIdResweepIntervalMs()).toBe(6 * 60 * 60 * 1000);

      // Nonsense falls back rather than disabling the sweep or hammering it.
      for (const bad of ["", "not-a-number", "0", "-3"]) {
        process.env.CONTACT_ID_BACKFILL_RESWEEP_HOURS = bad;
        expect(contactIdResweepIntervalMs(logger)).toBe(24 * 60 * 60 * 1000);
      }
    } finally {
      if (original === undefined) {
        delete process.env.CONTACT_ID_BACKFILL_RESWEEP_HOURS;
      } else {
        process.env.CONTACT_ID_BACKFILL_RESWEEP_HOURS = original;
      }
    }
  });
});
