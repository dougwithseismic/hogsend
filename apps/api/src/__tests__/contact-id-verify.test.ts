/**
 * PRD 04 T6 — the invariant probe: the thing this PRD ships INSTEAD of a
 * foreign key, and the gate the next release's read flip has to pass.
 *
 * An FK would prove the uuid EXISTS. This proves it is the RIGHT uuid, which is
 * the only control that can catch a dual-write stamping the wrong contact — the
 * backfill cannot, because it only fills NULLs.
 *
 * Every count case runs against a `userIds`-SCOPED probe. The unscoped probe is
 * the gate, but it is a whole-database count and this suite shares one Postgres
 * with files running in parallel; scoping is what makes "mismatched: 1" an
 * absolute assertion instead of a delta race. The ROUTE (necessarily unscoped)
 * is asserted only on properties that hold no matter what the rest of the
 * database looks like.
 *
 * Cases, in order:
 *   healthy      — stamped rows across all five tables + seeded orphans ⇒ all
 *                  zeros except `orphaned`, and `flipReady: true`
 *   mismatched   — one row per table repointed at a wrong-but-real live contact
 *   missing      — one properly-owned row per table NULLed
 *   orphaned     — a refused-ingest-shaped anonymous row is orphaned, NOT missing
 *   ALIAS-AWARE  — the three cases the PRD locks (a second-device anon id that
 *                  lives ONLY in `contact_aliases`, stamped / NULLed, plus an
 *                  `email`-kind alias which is NOT canonical ownership)
 *   alert        — D6's revised posture: a broken invariant AFTER a completed
 *                  sweep logs at `error` level; a healthy one does not
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// DB-touching test. Point a worktree at its own stack with
// HOGSEND_TEST_DATABASE_URL — never by editing the default.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Config-preserving hatchet mock (the documented seam), so importing the
// workflow module never reaches a real engine.
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
 * uses) delegates to the real probe.
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
const { inArray, sql } = await import("drizzle-orm");
const {
  CONTACT_ID_BACKFILL_FORMAT,
  createApp,
  createHogsendClient,
  verifyContactIdBackfill,
} = await import("@hogsend/engine");

const container = createHogsendClient();
const app = createApp(container);
const { db, logger } = container;

const ADMIN_HEADERS = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

const RUN = `cidv-${randomUUID().slice(0, 8)}`;
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

const emptyIds = (): IdSet => ({
  user_events: [],
  journey_states: [],
  bucket_memberships: [],
  email_sends: [],
  email_preferences: [],
});

const createdContactIds: string[] = [];
const seededIds = emptyIds();
const createdJobIds: string[] = [];

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
 * One history row per requested table, all keyed on `key` and stamped with
 * `contactId` (NULL for the pre-column / refused-ingest shapes). Inserted
 * DIRECTLY so the fixture states exactly what it means to state, rather than
 * whatever a dual-write happens to derive.
 */
async function seedRows(
  key: string,
  tables: TableKey[],
  contactId: string | null,
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
        journeyId: `${RUN}-j-${key}`,
        currentNodeId: "start",
        contactId,
      })
      .returning({ id: journeyStates.id });
    if (row) ids.journey_states.push(row.id);
  }
  if (tables.includes("bucket_memberships")) {
    const [row] = await db
      .insert(bucketMemberships)
      .values({ userId: key, bucketId: `${RUN}-b-${key}`, contactId })
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

/** Every table reports all three counts as 0. */
function expectAllZero(result: {
  tables: Record<TableKey, { missing: number; mismatched: number }>;
}) {
  for (const table of ALL_TABLES) {
    expect([table, result.tables[table].missing]).toEqual([table, 0]);
    expect([table, result.tables[table].mismatched]).toEqual([table, 0]);
  }
}

// ---------------------------------------------------------------------------
// the fixture
// ---------------------------------------------------------------------------

/** Healthy: canonical key = external_id, rows in ALL FIVE tables, all stamped. */
const keyHealthy = uid("healthy");
/** The wrong-but-real live contact a corruption repoints at. */
const keyWrong = uid("wrong");
/** A refused anonymous ingest: owns no contact, stamps nothing (D5). */
const keyOrphan = uid("orphan");
/** A second-device anon id that exists ONLY in `contact_aliases`. */
const keyAliasStamped = uid("alias-stamped");
/** Same shape, left NULL — a live contact owns it BY ALIAS, so it is missing. */
const keyAliasNull = uid("alias-null");
/** An alias of kind `email`: NOT canonical ownership, so a stamp is a mismatch. */
const keyEmailAlias = uid("email-alias");

let contactHealthy = "";
let contactWrong = "";
let contactAliasOwner = "";
let contactEmailAliasOwner = "";

let idsHealthy: IdSet;
let idsAliasStamped: IdSet;
let idsAliasNull: IdSet;
let idsEmailAlias: IdSet;

beforeAll(async () => {
  contactHealthy = await seedContact({
    externalId: keyHealthy,
    email: `${uid("healthy")}@example.com`,
  });
  contactWrong = await seedContact({ externalId: keyWrong });
  contactAliasOwner = await seedContact({ externalId: uid("alias-canon") });
  contactEmailAliasOwner = await seedContact({
    externalId: uid("email-alias-canon"),
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
  if (createdJobIds.length > 0) {
    // BY ID only. `contact-id-backfill.test.ts` owns the rows of this format
    // and deletes them wholesale; a format-wide delete here would race it.
    await db.delete(importJobs).where(inArray(importJobs.id, createdJobIds));
  }
  await container.dbClient.end({ timeout: 5 }).catch(() => {});
});

// ---------------------------------------------------------------------------

describe("verifyContactIdBackfill — a healthy world", () => {
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
    const result = await verifyContactIdBackfill({ db, userIds: [keyOrphan] });
    expect(result.tables.user_events).toEqual({
      missing: 0,
      mismatched: 0,
      orphaned: 1,
    });
    expect(result.tables.bucket_memberships).toEqual({
      missing: 0,
      mismatched: 0,
      orphaned: 1,
    });
    // Nothing owns the key, so nothing is owed a stamp — the gate stays open.
    expect(result.flipReady).toBe(true);
  });

  it("scopes to nothing on an empty key list (not to everything)", async () => {
    const result = await verifyContactIdBackfill({ db, userIds: [] });
    expect(result.totals).toEqual({ missing: 0, mismatched: 0, orphaned: 0 });
  });
});

describe("verifyContactIdBackfill — corruption", () => {
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

describe("verifyContactIdBackfill — ownership is ALIAS-AWARE (locked)", () => {
  it("accepts a row keyed on an alias-only anon id, stamped with that alias's contact", async () => {
    // The regression this pins: a bare canonical-coalesce probe would call this
    // correctly-stamped second-device row corruption, and `mismatched > 0`
    // would block the read flip forever on any deployment with two devices.
    const result = await verifyContactIdBackfill({
      db,
      userIds: [keyAliasStamped],
    });
    expect(result.tables.user_events).toEqual({
      missing: 0,
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
    // A live contact owns the key BY ALIAS, so this is a hole the dual-write or
    // the sweep owes — not an orphan.
    expect(result.tables.user_events).toEqual({
      missing: 1,
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
      mismatched: 1,
      orphaned: 0,
    });
    expect(result.flipReady).toBe(false);
    expect(idsEmailAlias.user_events).toHaveLength(1);
  });
});

describe("verifyContactIdBackfill — a keyless email_sends row (D7)", () => {
  it("does not count a resend-shaped row (user_id NULL, contact_id set)", async () => {
    // `routes/admin/bulk.ts`'s resend copies `contact_id` off the source row
    // and does NOT copy `user_id` — so `user_id IS NULL AND contact_id IS NOT
    // NULL` is reachable TODAY, on a committed path, carrying a CORRECT
    // contact_id. Counting it as corruption would shut the gate forever on any
    // deployment that has ever resent a bounced email.
    //
    // The row has no key, so no `userIds` scope can see it: this is asserted as
    // a delta on the whole-database `email_sends` count, read back to back.
    // Nothing in the engine writes a mismatched row (that is the invariant), so
    // the only thing that moves this number between the two readings is the
    // fixture below.
    const before = await verifyContactIdBackfill({ db });

    const [row] = await db
      .insert(emailSends)
      .values({
        userId: null,
        fromEmail: "seed@example.com",
        toEmail: `${uid("resend")}@example.com`,
        subject: `${RUN} resend`,
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

describe("GET /v1/admin/maintenance/contact-id-verify", () => {
  let corruptedRowId = "";

  beforeAll(async () => {
    // The route is a WHOLE-database probe, so the only readings it can be held
    // to are ones this fixture forces. One corrupt row forces `flipReady:
    // false` no matter what else lives in the database.
    const rowId = idsHealthy.user_events[0];
    if (!rowId) throw new Error("fixture missing a user_events row");
    corruptedRowId = rowId;
    await setStamp("user_events", corruptedRowId, contactWrong);

    // A COMPLETED sweep must be on record for the alert's second conjunct.
    // Backdated deliberately: `contact-id-backfill.test.ts` runs in parallel
    // and asserts on `enqueueContactIdBackfill`'s guard, which skips only on a
    // FRESH completed row — a stale one is invisible to it.
    const [job] = await db
      .insert(importJobs)
      .values({
        fileName: CONTACT_ID_BACKFILL_FORMAT,
        format: CONTACT_ID_BACKFILL_FORMAT,
        status: "completed",
        updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      })
      .returning({ id: importJobs.id });
    if (!job) throw new Error("failed to seed a completed sweep row");
    createdJobIds.push(job.id);
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
      const res = await app.request("/v1/admin/maintenance/contact-id-verify", {
        headers: ADMIN_HEADERS,
      });
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
    // row from any parallel suite shuts the whole-database gate), so the probe
    // is handed a synthetic clean verdict. The completed-sweep row from the
    // previous case is still on record, which is the point: the alert must be
    // gated on the INVARIANT, not merely on a sweep having run.
    verifyOverride.value = {
      tables: Object.fromEntries(
        ALL_TABLES.map((t) => [t, { missing: 0, mismatched: 0, orphaned: 7 }]),
      ),
      totals: { missing: 0, mismatched: 0, orphaned: 35 },
      flipReady: true,
    };

    const errorSpy = vi.spyOn(logger, "error");
    try {
      const res = await app.request("/v1/admin/maintenance/contact-id-verify", {
        headers: ADMIN_HEADERS,
      });
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
    // `missing` is a pending backfill, not a hole — alerting on it would train
    // operators to ignore the alert. Deleting our own completed row is enough
    // to reach that world when this file runs alone (the gate command); under a
    // full parallel suite another file may hold a completed row of this format,
    // and deleting THAT is not ours to do — so the assertion is made only when
    // the route confirms the world it needs.
    await db.delete(importJobs).where(inArray(importJobs.id, createdJobIds));
    createdJobIds.length = 0;

    const errorSpy = vi.spyOn(logger, "error");
    try {
      const res = await app.request("/v1/admin/maintenance/contact-id-verify", {
        headers: ADMIN_HEADERS,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.flipReady).toBe(false); // the corrupt row is still in place

      if (body.lastSweepAt === null) {
        expect(alertCalls(errorSpy)).toHaveLength(0);
      }
    } finally {
      errorSpy.mockRestore();
    }
  });
});
