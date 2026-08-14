/**
 * PRD 04 T5 + T6 — the `contact_id` backfill (a chunked, resumable, periodically
 * re-runnable Hatchet task, NEVER a migration) AND the invariant probe that
 * judges its result.
 *
 * ## THIS FILE OWNS THE GLOBAL SWEEP. READ BEFORE SPLITTING IT.
 *
 * `backfillTask.fn()` is a WHOLE-DATABASE job: it stamps every row whose
 * `user_id` is owned by a live contact, anywhere in the database, including rows
 * another test file seeded. So a test that holds an owned-but-NULL `contact_id`
 * fixture — which is exactly what T6's `missing` cases are — is a fixture the
 * sweep exists to destroy.
 *
 * Vitest sequences tests WITHIN a file and runs files CONCURRENTLY. That makes
 * the rule absolute:
 *
 *   **Any test holding an owned-but-NULL `contact_id` fixture MUST live in this
 *   file, sequenced clear of the sweep-invoking tests. It must NEVER live in a
 *   separate file** — a separate file races the sweep under suite concurrency,
 *   and the fixture gets stamped mid-window. (This is not hypothetical: T6
 *   started life in its own `contact-id-verify.test.ts` and the full suite
 *   caught the sweep filling its alias-owned NULL row, turning `missing: 1` into
 *   `missing: 0`.)
 *
 * Layout follows from that. The sweep-invoking describes come FIRST and run to
 * completion; the T6 probe describes come LAST, seed their own `RUN_V`-namespaced
 * fixture in their own `beforeAll` (so it does not even exist while the sweep
 * runs), and nothing re-runs the sweep after them.
 *
 * ## T5 — the backfill
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
 *
 * ## T6 — the invariant probe (the last describes)
 *
 * The thing this PRD ships INSTEAD of a foreign key: an FK proves the uuid
 * EXISTS, this proves it is the RIGHT uuid — the only control that can catch a
 * dual-write stamping the wrong contact, which the backfill cannot, because it
 * only fills NULLs. Every count case runs against a `userIds`-SCOPED probe: the
 * unscoped probe is the gate, but it is a whole-database count and this suite
 * shares one Postgres with files running in parallel, so scoping is what makes
 * "mismatched: 1" an absolute assertion instead of a delta race. The ROUTE
 * (necessarily unscoped) is asserted only on properties this fixture forces.
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

/**
 * The probe seam for ONE assertion: "flipReady true ⇒ the route does NOT alert".
 * The route runs the probe over the WHOLE database, and a single unstamped row
 * left by any concurrently-running suite is enough to make that false — so the
 * healthy branch is unreachable by seeding and is driven by handing the route a
 * synthetic verdict instead. `null` (the default, and what every other test here
 * uses) delegates to the real probe. Everything else in the module — the task,
 * the enqueue, the real probe — is re-exported untouched.
 */
const { verifyOverride } = vi.hoisted(() => ({
  verifyOverride: { value: null as unknown },
}));
vi.mock(
  "../../../../packages/engine/src/workflows/backfill-contact-id.ts",
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const real = actual.verifyContactIdBackfill as (
      opts: unknown,
    ) => Promise<unknown>;
    return {
      ...actual,
      verifyContactIdBackfill: (opts: unknown) =>
        verifyOverride.value
          ? Promise.resolve(verifyOverride.value)
          : real(opts),
    };
  },
);

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
  createApp,
  createHogsendClient,
  enqueueContactIdBackfill,
  verifyContactIdBackfill,
} = await import("@hogsend/engine");

const container = createHogsendClient();
const app = createApp(container);
const { db, logger } = container;

const ADMIN_HEADERS = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

const RUN = `cidb-${randomUUID().slice(0, 8)}`;
const uid = (label: string) => `${RUN}-${label}`;
// T6's fixture family gets its OWN namespace so the two stay disjoint: the
// backfill's rows are all deliberately unstamped, the probe's are deliberately
// a mix, and neither cleanup may reach the other's rows.
const RUN_V = `cidv-${randomUUID().slice(0, 8)}`;
const uidV = (label: string) => `${RUN_V}-${label}`;

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
 * One history row per requested table, all keyed on `key`. Inserted DIRECTLY
 * (never through the engine) so no dual-write pre-fills `contact_id`.
 *
 * `contactId` defaults to NULL — the pre-column-era population the backfill
 * exists for. T6's fixtures pass an explicit stamp (or an explicit NULL) so the
 * probe is handed exactly the state it is meant to judge.
 */
async function seedRows(
  key: string,
  tables: TableKey[],
  contactId: string | null = null,
): Promise<IdSet> {
  const ids = emptyIds();

  if (tables.includes("user_events")) {
    const [row] = await db
      .insert(userEvents)
      .values({ userId: key, event: `${RUN}.seed`, properties: {}, contactId })
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
        contactId,
      })
      .returning({ id: journeyStates.id });
    if (row) ids.journey_states.push(row.id);
  }
  if (tables.includes("bucket_memberships")) {
    const [row] = await db
      .insert(bucketMemberships)
      .values({ userId: key, bucketId: uid("bucket"), contactId })
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
        contactId,
      })
      .returning({ id: emailSends.id });
    if (row) ids.email_sends.push(row.id);
  }
  if (tables.includes("email_preferences")) {
    const [row] = await db
      .insert(emailPreferences)
      .values({ userId: key, email: `${key}@example.com`, contactId })
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

/**
 * The sweep's cost is the WHOLE DATABASE, so its time budget cannot be the
 * suite default.
 *
 * `backfillTask.fn()` walks every LIVE CONTACT and issues one bounded UPDATE
 * per (contact, table) — six statements per contact even when it writes
 * nothing — then walks every stale alias key the same way. That is O(rows the
 * whole suite has ever left in the shared 5434 Postgres), not O(this fixture),
 * and this file's own `RUN`-namespacing cannot shrink it: the rows it pays for
 * belong to other files. Measured 2026-08-14 against the repo's container
 * (17,469 live contacts, 530 stale alias keys): ~108,000 statements, ~20s per
 * sweep — and that number only ever grows, because the suite seeds contacts it
 * never deletes.
 *
 * Against that, the config's 30s `testTimeout` is not a budget, it is a coin
 * flip. And losing it is not a local failure: vitest fails the test but does
 * NOT stop the sweep, so the abandoned run keeps stamping rows while the file
 * moves on, and every LATER test inherits a corrupted fixture. One timeout at
 * the first sweep is what turned this file's full-suite run into five failures
 * (`import_jobs` stuck at "processing", `xmin`s bumped under the
 * "physically untouched" assertion, and an `updated` count short by exactly the
 * rows the zombie sweep had already claimed).
 *
 * Hence the two rules below: every sweep-driving test states its budget, and no
 * single test drives the sweep twice. Raise this constant if the dev database
 * grows again — never the assertions. Nothing here is softened; the claims are
 * only given room to finish.
 */
const SWEEP_BUDGET_MS = 90_000;

describe("contactIdBackfillTask", { timeout: SWEEP_BUDGET_MS }, () => {
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
    // alone contributes five live contacts. NO equality between the two: this
    // file shares one Postgres with the whole concurrently-running suite, and
    // `totalRows` is a whole-table snapshot taken at run start while the walk
    // sees contacts other files insert mid-run — asserting them equal is the
    // shared-database race this suite keeps re-learning. The run's own two
    // counters (DB row vs result) must still agree exactly.
    expect(row?.totalRows ?? 0).toBeGreaterThanOrEqual(5);
    expect(row?.processedRows ?? 0).toBeGreaterThanOrEqual(5);
    expect(row?.processedRows).toBe(firstRun.contactsScanned);
    // failedRows carries the ambiguous-alias divergence metric, NOT errors.
    expect(row?.failedRows).toBe(firstRun.ambiguousAliases);
    expect(row?.errors).toBeNull();
  });

  it("re-runs for free: zero rows updated, no row rewritten", async () => {
    const xminBefore = await xminOf(allIds);

    const second = await backfillTask.fn({ pauseMs: 0 });

    // The sweep is GLOBAL, so on the suite's shared database `second.updated`
    // may legitimately count rows OTHER concurrently-running files seeded —
    // asserting it 0 is a whole-database claim this file cannot make. The
    // PRD's named mutation proof (`remove the contact_id IS NULL guard and the
    // re-run goes red`) is carried by the two FIXTURE-scoped assertions below
    // instead, and both kill the mutant: without the guard the re-run
    // re-stamps this fixture's rows (new tuple versions ⇒ the xmin equality
    // fails) and the per-key loop never drains (the runaway guard throws ⇒
    // status is "failed").
    expect(second.status).toBe("completed");
    // Physically untouched: same tuple versions, so nothing was rewritten.
    expect(await xminOf(allIds)).toEqual(xminBefore);
    expect(withoutContactId(await snapshot(allIds))).toEqual(
      withoutContactId(before),
    );
  });
});

describe("the per-statement bound", { timeout: SWEEP_BUDGET_MS }, () => {
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

    // 4 rows under the canonical key + 2 under the stale alias — but `updated`
    // is the GLOBAL counter and other suite files seed concurrently, so the
    // exact claim lives on the fixture (`stamps` above); the counter only
    // bounds it from below. One row per statement plus a terminating zero-row
    // statement per (key, table): the loop necessarily issued MORE statements
    // than it wrote rows, and that inequality is concurrency-proof.
    expect(result.updated).toBeGreaterThanOrEqual(6);
    expect(result.statements).toBeGreaterThan(result.updated);
  });
});

// ---------------------------------------------------------------------------
// PRD 05 T3 — the sweep is a FOURTH writer to the three contact-scoped
// uniqueness indexes migration 0071 adds. Stamping a stale-keyed NULL row whose
// contact already owns a stamped twin moves that row INTO the partial index's
// predicate; unguarded, that is a 23505 the blanket catch turns into a FAILED
// job that aborts the whole sweep — and the boot / 24h re-enqueue deterministically
// re-hits the same row, so `missing` never drains and `flipReady` can never pass.
// ---------------------------------------------------------------------------

describe("the sweep vs the contact-scoped uniqueness indexes (PRD 05 T3)", {
  timeout: SWEEP_BUDGET_MS,
}, () => {
  it("skips colliding stamps, folds the preference opt-out, and never aborts", async () => {
    const canon = uid("t3-canon");
    const stale = uid("t3-stale");
    const journeyId = uid("t3-journey");
    const bucketId = uid("t3-bucket");
    const email = `${uid("t3")}@example.com`;

    const contact = await seedContact({ externalId: canon });
    await db.insert(contactAliases).values({
      contactId: contact,
      aliasKind: "anonymous",
      aliasValue: stale,
      reason: "promote",
    });

    // The STAMPED twins, filed under the canonical key — already inside each
    // partial index.
    const [jTwin] = await db
      .insert(journeyStates)
      .values({
        userId: canon,
        userEmail: email,
        journeyId,
        currentNodeId: "start",
        status: "active",
        contactId: contact,
      })
      .returning({ id: journeyStates.id });
    const [bTwin] = await db
      .insert(bucketMemberships)
      .values({ userId: canon, bucketId, status: "active", contactId: contact })
      .returning({ id: bucketMemberships.id });
    const [pTwin] = await db
      .insert(emailPreferences)
      .values({
        userId: canon,
        email,
        contactId: contact,
        unsubscribedAll: false,
        categories: { product: true, news: true },
      })
      .returning({ id: emailPreferences.id });

    // ...and the pre-column-era rows under the STALE alias key, which pass 2 is
    // about to try to stamp with the very same contact.
    const [jStale] = await db
      .insert(journeyStates)
      .values({
        userId: stale,
        userEmail: email,
        journeyId,
        currentNodeId: "start",
        status: "active",
        contactId: null,
      })
      .returning({ id: journeyStates.id });
    const [bStale] = await db
      .insert(bucketMemberships)
      .values({ userId: stale, bucketId, status: "active", contactId: null })
      .returning({ id: bucketMemberships.id });
    const [pStale] = await db
      .insert(emailPreferences)
      .values({
        userId: stale,
        email,
        contactId: null,
        // The opt-out that must survive the fold — and a grant the twin never
        // heard of, which must ALSO survive (the merge-path category rule).
        unsubscribedAll: true,
        categories: { product: false, sms: true },
      })
      .returning({ id: emailPreferences.id });

    if (!jTwin || !bTwin || !pTwin || !jStale || !bStale || !pStale) {
      throw new Error("fixture insert returned no row");
    }
    seededIds.journey_states.push(jTwin.id, jStale.id);
    seededIds.bucket_memberships.push(bTwin.id, bStale.id);
    seededIds.email_preferences.push(pTwin.id, pStale.id);

    const run = await backfillTask.fn({ pauseMs: 0 });
    // INVARIANT 1: one colliding row never aborts the sweep.
    expect(run.status).toBe("completed");

    // journey_states / bucket_memberships — SKIPPED, never auto-cancelled: a
    // sweep does not get to end someone's live enrollment or membership.
    const [journeyRow] = await db
      .select()
      .from(journeyStates)
      .where(eq(journeyStates.id, jStale.id));
    expect(journeyRow?.contactId).toBeNull();
    expect(journeyRow?.status).toBe("active");
    const [bucketRow] = await db
      .select()
      .from(bucketMemberships)
      .where(eq(bucketMemberships.id, bStale.id));
    expect(bucketRow?.contactId).toBeNull();
    expect(bucketRow?.status).toBe("active");

    // INVARIANT 2: the preference opt-out is FOLDED into the stamped twin and
    // the stale row is dropped — a row left NULL here would be invisible to the
    // flipped (contact-scoped) read, i.e. a silently resurrected subscriber.
    const [prefTwin] = await db
      .select()
      .from(emailPreferences)
      .where(eq(emailPreferences.id, pTwin.id));
    expect(prefTwin?.unsubscribedAll).toBe(true);
    expect(prefTwin?.categories).toMatchObject({
      product: false,
      news: true,
      sms: true,
    });
    expect(
      await db
        .select()
        .from(emailPreferences)
        .where(eq(emailPreferences.id, pStale.id)),
    ).toHaveLength(0);

    // INVARIANT 3: the probe calls the skipped rows `duplicates`, NOT `missing`
    // — so the operator sees the triage population and the gate can still open.
    const verdict = await verifyContactIdBackfill({
      db,
      userIds: [canon, stale],
    });
    expect(verdict.tables.journey_states).toEqual({
      missing: 0,
      duplicates: 1,
      mismatched: 0,
      orphaned: 0,
    });
    expect(verdict.tables.bucket_memberships).toEqual({
      missing: 0,
      duplicates: 1,
      mismatched: 0,
      orphaned: 0,
    });
    expect(verdict.tables.email_preferences).toEqual({
      missing: 0,
      duplicates: 0,
      mismatched: 0,
      orphaned: 0,
    });
    expect(verdict.flipReady).toBe(true);
  });

  // INVARIANT 4: the NEXT sweep is not wedged on the same skipped row — the
  // failure mode this whole describe exists for is a job that re-hits one
  // colliding row forever, so "it completed once" is only half the claim.
  //
  // Its own test rather than a second `await` inside the one above: a sweep is
  // a whole-database walk (see SWEEP_BUDGET_MS), and a test that drives two of
  // them asks for twice the budget while reporting one verdict. Sequencing is
  // the file's existing idiom — vitest runs a file's `it`s in declaration
  // order, so this runs against the exact post-skip state the case above left.
  it("...and the next sweep is not wedged on the same skipped row", async () => {
    const second = await backfillTask.fn({ pauseMs: 0 });
    expect(second.status).toBe("completed");
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

// ===========================================================================
// T6 — the invariant probe.
//
// Everything below runs AFTER the sweep-invoking describes above have finished,
// and seeds its fixture in its own `beforeAll` so the owned-but-NULL rows do not
// even exist while a global sweep is in flight. See the file header: this
// ordering is the whole reason T6 lives in this file.
// ===========================================================================

/** Hand-set one row's stamp. Raw SQL so one helper covers all five tables
 * without a union-typed `db.update()` dance — and because "hand-corrupt" is
 * exactly what this is. */
async function setStamp(
  table: TableKey,
  id: string,
  contactId: string | null,
): Promise<void> {
  await db.execute(sql`
    UPDATE ${sql.identifier(table)}
       SET contact_id = ${contactId}::uuid
     WHERE id = ${id}::uuid
  `);
}

/** Every table reports `missing` and `mismatched` as 0. */
function expectAllZero(result: {
  tables: Record<TableKey, { missing: number; mismatched: number }>;
}) {
  for (const table of ALL_TABLES) {
    expect([table, result.tables[table].missing]).toEqual([table, 0]);
    expect([table, result.tables[table].mismatched]).toEqual([table, 0]);
  }
}

const ALERT_MESSAGE = "contact_id invariant broken after a completed sweep";

/** winston's `error` is heavily overloaded, so its recorded calls type as
 * `[infoObject: object]`. Read them back as (message, meta) pairs — the shape
 * the route actually logs. */
function alertCalls(spy: {
  mock: { calls: unknown[] };
}): Array<[string, Record<string, unknown>]> {
  const calls = spy.mock.calls as Array<[string, Record<string, unknown>]>;
  return calls.filter(([message]) => message === ALERT_MESSAGE);
}

/** Healthy: canonical key = external_id, rows in ALL FIVE tables, all stamped. */
const keyHealthy = uidV("healthy");
/** The wrong-but-real live contact a corruption repoints at. */
const keyWrong = uidV("wrong");
/** A refused anonymous ingest: owns no contact, stamps nothing (D5). */
const keyOrphan = uidV("orphan");
/** A second-device anon id that exists ONLY in `contact_aliases`. */
const keyAliasStamped = uidV("alias-stamped");
/** Same shape, left NULL — a live contact owns it BY ALIAS, so it is missing. */
const keyAliasNull = uidV("alias-null");
/** An alias of kind `email`: NOT canonical ownership, so a stamp is a mismatch. */
const keyEmailAlias = uidV("email-alias");

let contactHealthy = "";
let contactWrong = "";
let contactAliasOwner = "";
let contactEmailAliasOwner = "";

let idsHealthy: IdSet;
let idsAliasStamped: IdSet;
let idsAliasNull: IdSet;
let idsEmailAlias: IdSet;

describe("verifyContactIdBackfill (PRD 04 T6)", () => {
  // Seeded HERE, not at file scope: `keyAliasNull`'s row is owned by a live
  // contact and deliberately unstamped, which is precisely what the sweep above
  // fills. Creating it only once every sweep has run is what keeps it NULL.
  beforeAll(async () => {
    contactHealthy = await seedContact({
      externalId: keyHealthy,
      email: `${uidV("healthy")}@example.com`,
    });
    contactWrong = await seedContact({ externalId: keyWrong });
    contactAliasOwner = await seedContact({ externalId: uidV("alias-canon") });
    contactEmailAliasOwner = await seedContact({
      externalId: uidV("email-alias-canon"),
    });

    idsHealthy = await seedRows(keyHealthy, ALL_TABLES, contactHealthy);
    await seedRows(keyOrphan, ["user_events", "bucket_memberships"], null);
    idsAliasStamped = await seedRows(
      keyAliasStamped,
      ["user_events"],
      contactAliasOwner,
    );
    idsAliasNull = await seedRows(keyAliasNull, ["user_events"], null);
    idsEmailAlias = await seedRows(
      keyEmailAlias,
      ["user_events"],
      contactEmailAliasOwner,
    );

    await db.insert(contactAliases).values([
      // The two second-device anon ids — live ONLY here, never on a column.
      {
        contactId: contactAliasOwner,
        aliasKind: "anonymous",
        aliasValue: keyAliasStamped,
        reason: "promote",
      },
      {
        contactId: contactAliasOwner,
        aliasKind: "anonymous",
        aliasValue: keyAliasNull,
        reason: "promote",
      },
      // An `email` alias. Permitted data, but NOT a canonical key (D4), so it
      // must not confer ownership.
      {
        contactId: contactEmailAliasOwner,
        aliasKind: "email",
        aliasValue: keyEmailAlias,
        reason: "merge",
      },
    ]);
  });

  describe("a healthy world", () => {
    it("reports all zeros, counts the seeded orphans, and opens the gate", async () => {
      const result = await verifyContactIdBackfill({
        db,
        userIds: [keyHealthy, keyOrphan, keyAliasStamped],
      });

      expectAllZero(result);
      // D5: `orphaned` is information, never a failure — and it is NOT part of
      // the gate, which is exactly why the gate is open here.
      expect(result.tables.user_events.orphaned).toBe(1);
      expect(result.tables.bucket_memberships.orphaned).toBe(1);
      expect(result.tables.journey_states.orphaned).toBe(0);
      expect(result.totals.orphaned).toBe(2);
      expect(result.flipReady).toBe(true);
    });

    it("puts a refused-ingest anonymous row in `orphaned`, never in `missing`", async () => {
      const result = await verifyContactIdBackfill({
        db,
        userIds: [keyOrphan],
      });
      expect(result.tables.user_events).toEqual({
        missing: 0,
        duplicates: 0,
        mismatched: 0,
        orphaned: 1,
      });
      expect(result.tables.bucket_memberships).toEqual({
        missing: 0,
        duplicates: 0,
        mismatched: 0,
        orphaned: 1,
      });
      // Nothing owns the key, so nothing is owed a stamp — the gate stays open.
      expect(result.flipReady).toBe(true);
    });

    it("scopes to nothing on an empty key list (not to everything)", async () => {
      const result = await verifyContactIdBackfill({ db, userIds: [] });
      expect(result.totals).toEqual({
        missing: 0,
        duplicates: 0,
        mismatched: 0,
        orphaned: 0,
      });
    });
  });

  describe("corruption", () => {
    it("catches a wrong-but-real stamp, one table at a time", async () => {
      for (const table of ALL_TABLES) {
        const rowId = idsHealthy[table][0];
        if (!rowId) throw new Error(`fixture missing a ${table} row`);

        // The stamp points at a LIVE contact that exists — an FK would be
        // perfectly happy. Only ownership tells the two apart.
        await setStamp(table, rowId, contactWrong);
        const broken = await verifyContactIdBackfill({
          db,
          userIds: [keyHealthy],
        });

        for (const other of ALL_TABLES) {
          expect([other, broken.tables[other].mismatched]).toEqual([
            other,
            other === table ? 1 : 0,
          ]);
          expect([other, broken.tables[other].missing]).toEqual([other, 0]);
        }
        expect(broken.flipReady).toBe(false);

        await setStamp(table, rowId, contactHealthy);
        const repaired = await verifyContactIdBackfill({
          db,
          userIds: [keyHealthy],
        });
        expectAllZero(repaired);
        expect(repaired.flipReady).toBe(true);
      }
    });

    it("catches a dropped stamp on an owned row, one table at a time", async () => {
      for (const table of ALL_TABLES) {
        const rowId = idsHealthy[table][0];
        if (!rowId) throw new Error(`fixture missing a ${table} row`);

        await setStamp(table, rowId, null);
        const broken = await verifyContactIdBackfill({
          db,
          userIds: [keyHealthy],
        });

        for (const other of ALL_TABLES) {
          expect([other, broken.tables[other].missing]).toEqual([
            other,
            other === table ? 1 : 0,
          ]);
          expect([other, broken.tables[other].mismatched]).toEqual([other, 0]);
          // `missing` and `orphaned` PARTITION the NULL-stamped rows: a live
          // contact owns this key, so the NULLed row is a hole, not an orphan.
          expect([other, broken.tables[other].orphaned]).toEqual([other, 0]);
        }
        expect(broken.flipReady).toBe(false);

        await setStamp(table, rowId, contactHealthy);
        expect(
          (await verifyContactIdBackfill({ db, userIds: [keyHealthy] }))
            .flipReady,
        ).toBe(true);
      }
    });
  });

  describe("ownership is ALIAS-AWARE (locked)", () => {
    it("accepts a row keyed on an alias-only anon id, stamped with that alias's contact", async () => {
      // The regression this pins: a bare canonical-coalesce probe would call
      // this correctly-stamped second-device row corruption, and
      // `mismatched > 0` would block the read flip forever on any deployment
      // with two devices.
      const result = await verifyContactIdBackfill({
        db,
        userIds: [keyAliasStamped],
      });
      expect(result.tables.user_events).toEqual({
        missing: 0,
        duplicates: 0,
        mismatched: 0,
        orphaned: 0,
      });
      expect(result.flipReady).toBe(true);
      expect(idsAliasStamped.user_events).toHaveLength(1);
    });

    it("reports an alias-owned row that was never stamped as `missing`", async () => {
      const result = await verifyContactIdBackfill({
        db,
        userIds: [keyAliasNull],
      });
      // A live contact owns the key BY ALIAS, so this is a hole the dual-write
      // or the sweep owes — not an orphan. (And the sweep genuinely would fill
      // it, which is why this fixture is seeded only after the sweeps above.)
      expect(result.tables.user_events).toEqual({
        missing: 1,
        duplicates: 0,
        mismatched: 0,
        orphaned: 0,
      });
      expect(result.flipReady).toBe(false);
      expect(idsAliasNull.user_events).toHaveLength(1);
    });

    it("refuses an `email`-kind alias as ownership", async () => {
      // Only `external`/`anonymous` can ever be a canonical key (D4). Folding
      // `email` in would resolve history that resolves to nothing today.
      const result = await verifyContactIdBackfill({
        db,
        userIds: [keyEmailAlias],
      });
      expect(result.tables.user_events).toEqual({
        missing: 0,
        duplicates: 0,
        mismatched: 1,
        orphaned: 0,
      });
      expect(result.flipReady).toBe(false);
      expect(idsEmailAlias.user_events).toHaveLength(1);
    });
  });

  describe("a keyless email_sends row (D7)", () => {
    it("does not count a resend-shaped row (user_id NULL, contact_id set)", async () => {
      // `routes/admin/bulk.ts`'s resend copies `contact_id` off the source row
      // and does NOT copy `user_id` — so `user_id IS NULL AND contact_id IS NOT
      // NULL` is reachable TODAY, on a committed path, carrying a CORRECT
      // contact_id. Counting it as corruption would shut the gate forever on
      // any deployment that has ever resent a bounced email.
      //
      // The row has no key, so no `userIds` scope can see it: this is asserted
      // as a delta on the whole-database `email_sends` count, read back to
      // back. Nothing in the engine writes a mismatched row (that is the
      // invariant), so the only thing that moves this number between the two
      // readings is the fixture below.
      const before = await verifyContactIdBackfill({ db });

      const [row] = await db
        .insert(emailSends)
        .values({
          userId: null,
          fromEmail: "seed@example.com",
          toEmail: `${uidV("resend")}@example.com`,
          subject: `${RUN_V} resend`,
          contactId: contactHealthy,
        })
        .returning({ id: emailSends.id });
      if (!row) throw new Error("failed to seed the resend-shaped row");
      seededIds.email_sends.push(row.id);

      const after = await verifyContactIdBackfill({ db });
      expect(after.tables.email_sends.mismatched).toBe(
        before.tables.email_sends.mismatched,
      );
    });
  });

  describe("GET /v1/admin/maintenance/contact-id-verify", () => {
    let corruptedRowId = "";

    beforeAll(async () => {
      // The route is a WHOLE-database probe, so the only readings it can be
      // held to are ones this fixture forces. One corrupt row forces
      // `flipReady: false` no matter what else lives in the database.
      const rowId = idsHealthy.user_events[0];
      if (!rowId) throw new Error("fixture missing a user_events row");
      corruptedRowId = rowId;
      await setStamp("user_events", corruptedRowId, contactWrong);

      // A COMPLETED sweep must be on record for the alert's second conjunct.
      // Rows of this format belong to THIS file (nothing else in the suite
      // writes them), and every describe that reads them has already run, so
      // clearing them first makes `lastSweepAt` exactly the row seeded here.
      await db
        .delete(importJobs)
        .where(eq(importJobs.format, CONTACT_ID_BACKFILL_FORMAT));
      await db.insert(importJobs).values({
        fileName: CONTACT_ID_BACKFILL_FORMAT,
        format: CONTACT_ID_BACKFILL_FORMAT,
        status: "completed",
      });
    });

    afterAll(async () => {
      verifyOverride.value = null;
      if (corruptedRowId) {
        await setStamp("user_events", corruptedRowId, contactHealthy);
      }
    });

    it("requires admin auth", async () => {
      const res = await app.request("/v1/admin/maintenance/contact-id-verify");
      expect(res.status).toBe(401);
    });

    it("reports every table and ALERTS when the invariant is broken after a sweep", async () => {
      const errorSpy = vi.spyOn(logger, "error");
      try {
        const res = await app.request(
          "/v1/admin/maintenance/contact-id-verify",
          { headers: ADMIN_HEADERS },
        );
        expect(res.status).toBe(200);
        const body = await res.json();

        expect(Object.keys(body.tables).sort()).toEqual([...ALL_TABLES].sort());
        // Our corrupt row is in there, so the gate is shut — whatever else the
        // shared database holds.
        expect(body.flipReady).toBe(false);
        expect(body.totals.mismatched).toBeGreaterThanOrEqual(1);
        expect(body.tables.user_events.mismatched).toBeGreaterThanOrEqual(1);
        expect(body.lastSweepAt).not.toBeNull();

        // D6 (revised): reporting is not a control. The 200 is the answer; the
        // structured error line is what alerting hooks.
        const alerts = alertCalls(errorSpy);
        expect(alerts).toHaveLength(1);
        const meta = alerts[0]?.[1] as {
          flipReady: boolean;
          totals: { mismatched: number };
          tables: Record<string, unknown>;
          lastSweepAt: string;
        };
        expect(meta.flipReady).toBe(false);
        expect(meta.totals.mismatched).toBeGreaterThanOrEqual(1);
        expect(Object.keys(meta.tables).sort()).toEqual([...ALL_TABLES].sort());
        expect(meta.lastSweepAt).toBe(body.lastSweepAt);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it("does NOT alert when the gate is open", async () => {
      // The healthy branch cannot be seeded on a shared database (one unstamped
      // row from any parallel suite shuts the whole-database gate), so the
      // probe is handed a synthetic clean verdict. The completed-sweep row is
      // still on record, which is the point: the alert must be gated on the
      // INVARIANT, not merely on a sweep having run.
      verifyOverride.value = {
        tables: Object.fromEntries(
          ALL_TABLES.map((t) => [
            t,
            { missing: 0, duplicates: 0, mismatched: 0, orphaned: 7 },
          ]),
        ),
        totals: { missing: 0, duplicates: 0, mismatched: 0, orphaned: 35 },
        flipReady: true,
      };

      const errorSpy = vi.spyOn(logger, "error");
      try {
        const res = await app.request(
          "/v1/admin/maintenance/contact-id-verify",
          { headers: ADMIN_HEADERS },
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.flipReady).toBe(true);
        // Orphans are reported, never alerted on (D5).
        expect(body.totals.orphaned).toBe(35);
        expect(body.lastSweepAt).not.toBeNull();
        expect(alertCalls(errorSpy)).toHaveLength(0);
      } finally {
        errorSpy.mockRestore();
        verifyOverride.value = null;
      }
    });

    it("does NOT alert on a broken invariant with no sweep on record", async () => {
      // The second half of D6's revised posture: before a sweep completes,
      // `missing` is a pending backfill, not a hole — alerting on it would
      // train operators to ignore the alert. Deterministic now that this file
      // owns every `import_jobs` row of this format.
      await db
        .delete(importJobs)
        .where(eq(importJobs.format, CONTACT_ID_BACKFILL_FORMAT));

      const errorSpy = vi.spyOn(logger, "error");
      try {
        const res = await app.request(
          "/v1/admin/maintenance/contact-id-verify",
          { headers: ADMIN_HEADERS },
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.lastSweepAt).toBeNull();
        expect(body.flipReady).toBe(false); // the corrupt row is still in place
        expect(alertCalls(errorSpy)).toHaveLength(0);
      } finally {
        errorSpy.mockRestore();
      }
    });
  });
});
