import { afterAll, describe, expect, it, vi } from "vitest";

// DB-touching test against the real docker TimescaleDB. Point a worktree at
// its own stack by exporting HOGSEND_TEST_DATABASE_URL — never by editing the
// default.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Mock Hatchet so building the task at import does not construct a live gRPC
// engine. The mock PRESERVES the config passed to `task()` so the exported
// `runIdentityAliasBackfill` (the task body) can be driven directly, and
// `runNoWait` is a spy for the enqueue/route tests — the same seam
// bucket-backfill.test.ts documents.
const { hatchetMock } = vi.hoisted(() => {
  // run/runNoWait must return promises: callers chain `.catch` on them (the
  // bulk.ts fire-and-forget contract this router mirrors).
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

const { contactAliases, contacts, importJobs } = await import("@hogsend/db");
const { and, eq, inArray, like, or } = await import("drizzle-orm");
const {
  createApp,
  createHogsendClient,
  enqueueIdentityAliasBackfill,
  IDENTITY_ALIAS_BACKFILL_FORMAT,
  identityAliasBackfillTask,
  runIdentityAliasBackfill,
} = await import("@hogsend/engine");

const container = createHogsendClient();
const app = createApp(container);
const { db, logger } = container;

const RUN = `iab-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const uid = (label: string) => `${RUN}-${label}`;
const ADMIN_HEADERS = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};

const createdContactIds: string[] = [];

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

async function aliasesFor(contactId: string) {
  return db
    .select()
    .from(contactAliases)
    .where(eq(contactAliases.contactId, contactId));
}

/** Run the real task body against THIS test's db/logger. */
function runBackfill(opts: { jobId?: string; dryRun?: boolean } = {}) {
  return runIdentityAliasBackfill({ db, logger, ...opts });
}

afterAll(async () => {
  await db
    .delete(contactAliases)
    .where(like(contactAliases.aliasValue, `${RUN}-%`));
  if (createdContactIds.length > 0) {
    await db
      .delete(contactAliases)
      .where(inArray(contactAliases.contactId, createdContactIds));
  }
  await db
    .delete(contacts)
    .where(
      or(
        like(contacts.externalId, `${RUN}-%`),
        like(contacts.anonymousId, `${RUN}-%`),
        like(contacts.email, `${RUN}-%`),
        like(contacts.discordId, `${RUN}-%`),
      ),
    );
  await db
    .delete(importJobs)
    .where(eq(importJobs.format, IDENTITY_ALIAS_BACKFILL_FORMAT));
});

describe("identityAliasBackfillTask", () => {
  it("backfills one normalized alias per live column value; soft-deleted rows excluded; re-run inserts zero; conflicts never steal; dry-run writes nothing", async () => {
    // -- fixture ----------------------------------------------------------
    // Live contacts covering all four kinds. Seeded DIRECTLY (no resolver) so
    // no dual-write has pre-aliased them — the pre-alias-era population.
    const full = await seedContact({
      externalId: uid("full-ext"),
      email: `${RUN}-full@example.com`,
      anonymousId: uid("full-anon"),
      discordId: uid("full-disc"),
    });
    const mixedEmail = `${RUN}-MiXeD@Example.COM  `;
    const mixed = await seedContact({ email: mixedEmail });
    const anonOnly = await seedContact({ anonymousId: uid("anon-only") });
    const keyless = await seedContact({});
    // Soft-deleted with keys: must contribute NOTHING.
    const dead = await seedContact({
      externalId: uid("dead-ext"),
      email: `${RUN}-dead@example.com`,
      deletedAt: new Date(),
    });
    // A live value already aliased to a DIFFERENT contact: never repointed.
    const victim = await seedContact({ externalId: uid("victim-ext") });
    const squatter = await seedContact({ anonymousId: uid("squat-anon") });
    await db.insert(contactAliases).values({
      contactId: squatter,
      aliasKind: "external",
      aliasValue: uid("victim-ext"),
      fromContactId: null,
      reason: "promote",
    });

    // -- dry run FIRST: writes nothing, projects the fixture's pairs --------
    // (Global counters are compared with >= only: the suite runs files in
    // parallel against a shared DB, so other suites' contacts drift them.)
    const dry = await runBackfill({ dryRun: true });
    expect(dry.status).toBe("completed");
    // full(4) + mixed(1) + anonOnly(1) at minimum; the squatted pair is a
    // conflict, not an insert.
    expect(dry.inserted).toBeGreaterThanOrEqual(6);
    expect(dry.conflicting).toBeGreaterThanOrEqual(1);
    expect(await aliasesFor(full)).toHaveLength(0);
    expect(await aliasesFor(mixed)).toHaveLength(0);

    // -- real run ----------------------------------------------------------
    const first = await runBackfill();
    expect(first.status).toBe("completed");
    expect(first.inserted).toBeGreaterThanOrEqual(6);
    expect(first.conflicting).toBeGreaterThanOrEqual(1);

    // Full contact: one row per column value.
    const fullRows = await aliasesFor(full);
    const byKind = new Map(fullRows.map((r) => [r.aliasKind, r]));
    expect(fullRows).toHaveLength(4);
    expect(byKind.get("external")?.aliasValue).toBe(uid("full-ext"));
    expect(byKind.get("email")?.aliasValue).toBe(`${RUN}-full@example.com`);
    expect(byKind.get("anonymous")?.aliasValue).toBe(uid("full-anon"));
    expect(byKind.get("discord")?.aliasValue).toBe(uid("full-disc"));
    for (const row of fullRows) {
      expect(row.reason).toBe("backfill");
      expect(row.fromContactId).toBeNull();
    }

    // Email normalized on the way in (lower + trim).
    const mixedRows = await aliasesFor(mixed);
    expect(mixedRows).toHaveLength(1);
    expect(mixedRows[0]?.aliasValue).toBe(mixedEmail.trim().toLowerCase());

    // Anon-only gets its one row; a keyless contact gets none (the row-uuid
    // pseudo-key is deliberately NOT backfilled).
    expect(await aliasesFor(anonOnly)).toHaveLength(1);
    expect(await aliasesFor(keyless)).toHaveLength(0);

    // Soft-deleted contributes nothing.
    expect(await aliasesFor(dead)).toHaveLength(0);

    // The squatted value still points at the squatter — never stolen.
    const squatted = await db
      .select()
      .from(contactAliases)
      .where(
        and(
          eq(contactAliases.aliasKind, "external"),
          eq(contactAliases.aliasValue, uid("victim-ext")),
        ),
      );
    expect(squatted).toHaveLength(1);
    expect(squatted[0]?.contactId).toBe(squatter);
    expect(squatted[0]?.reason).toBe("promote");
    expect(await aliasesFor(victim)).toHaveLength(0);

    // -- idempotent re-run -------------------------------------------------
    // Anchored on the FIXTURE rows, not global counters (parallel suites
    // create contacts mid-run): the second pass completes (a broken ON
    // CONFLICT arbiter would 23505 → status "failed"), inserts nothing for
    // these contacts, and touches no existing row (ids + updated_at stable).
    const fullBefore = new Map(
      (await aliasesFor(full)).map((r) => [r.id, r.updatedAt.toISOString()]),
    );
    const second = await runBackfill();
    expect(second.status).toBe("completed");
    const fullAfter = await aliasesFor(full);
    expect(fullAfter).toHaveLength(fullBefore.size);
    for (const row of fullAfter) {
      expect(fullBefore.get(row.id)).toBe(row.updatedAt.toISOString());
    }
    expect(await aliasesFor(mixed)).toHaveLength(1);
    expect(await aliasesFor(dead)).toHaveLength(0);
  });

  it("sweeps backfill-authored rows whose contact was erased mid-run", async () => {
    // The deterministic form of the erasure race: a contact erased WHILE the
    // job runs can have its keys re-inserted from a batch's stale snapshot.
    // The job's final sweep must remove any backfill-authored row pointing at
    // a soft-deleted contact — and must NOT touch merge-trail rows (different
    // reason) or backfill rows pointing at live contacts.
    const erased = await seedContact({ deletedAt: new Date() });
    await db.insert(contactAliases).values({
      contactId: erased,
      aliasKind: "external",
      aliasValue: uid("sweep-erased"),
      fromContactId: null,
      reason: "backfill",
    });
    // Control: a merge-reason row on the same dead contact survives (it is
    // recordMergeAliases' business, not this job's — and in real data such
    // rows point at live survivors anyway).
    await db.insert(contactAliases).values({
      contactId: erased,
      aliasKind: "email",
      aliasValue: `${RUN}-sweep-merge@example.com`,
      fromContactId: crypto.randomUUID(),
      reason: "merge",
    });

    const result = await runBackfill();
    expect(result.status).toBe("completed");

    const rows = await aliasesFor(erased);
    expect(rows.some((r) => r.reason === "backfill")).toBe(false);
    expect(rows.some((r) => r.reason === "merge")).toBe(true);
  });

  it("records progress on the import_jobs row", async () => {
    const [job] = await db
      .insert(importJobs)
      .values({
        fileName: IDENTITY_ALIAS_BACKFILL_FORMAT,
        format: IDENTITY_ALIAS_BACKFILL_FORMAT,
        status: "pending",
      })
      .returning({ id: importJobs.id });
    if (!job) throw new Error("job insert failed");

    const result = await runBackfill({ jobId: job.id });
    expect(result.status).toBe("completed");

    const [row] = await db
      .select()
      .from(importJobs)
      .where(eq(importJobs.id, job.id));
    expect(row?.status).toBe("completed");
    expect(row?.processedRows).toBe(result.scanned);
    expect(row?.failedRows).toBe(result.conflicting);
    // totalRows is a START-of-run snapshot; parallel suites keep creating
    // contacts, so scanned may legitimately exceed it. Assert presence only.
    expect(row?.totalRows).toBeGreaterThan(0);
  });
});

describe("enqueueIdentityAliasBackfill (worker boot)", () => {
  it("enqueues once, then skips while a non-failed job record exists", async () => {
    // The suite's afterAll wipes this format's rows; make the pre-state
    // explicit here too so this test is order-independent.
    await db
      .delete(importJobs)
      .where(eq(importJobs.format, IDENTITY_ALIAS_BACKFILL_FORMAT));

    const runNoWait = (
      identityAliasBackfillTask as unknown as {
        runNoWait: ReturnType<typeof vi.fn>;
      }
    ).runNoWait;
    runNoWait.mockClear();

    await enqueueIdentityAliasBackfill({ db, logger });
    expect(runNoWait).toHaveBeenCalledTimes(1);
    const jobs = await db
      .select()
      .from(importJobs)
      .where(eq(importJobs.format, IDENTITY_ALIAS_BACKFILL_FORMAT));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe("pending");

    // Second boot: the pending record blocks a duplicate.
    await enqueueIdentityAliasBackfill({ db, logger });
    expect(runNoWait).toHaveBeenCalledTimes(1);

    // A FAILED record re-enqueues on the next boot.
    await db
      .update(importJobs)
      .set({ status: "failed" })
      .where(eq(importJobs.format, IDENTITY_ALIAS_BACKFILL_FORMAT));
    await enqueueIdentityAliasBackfill({ db, logger });
    expect(runNoWait).toHaveBeenCalledTimes(2);
  });
});

describe("admin identity routes", () => {
  it("POST /v1/admin/identity/alias-backfill returns 202 with a pollable job", async () => {
    const res = await app.request("/v1/admin/identity/alias-backfill", {
      method: "POST",
      headers: ADMIN_HEADERS,
      body: JSON.stringify({ dryRun: true }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.jobId).toBeDefined();
    expect(body.status).toBe("pending");

    const poll = await app.request(
      `/v1/admin/identity/alias-backfill/${body.jobId}`,
      { headers: ADMIN_HEADERS },
    );
    expect(poll.status).toBe(200);
    const job = await poll.json();
    expect(job.id).toBe(body.jobId);
  });

  it("status route 404s an unknown job id", async () => {
    const res = await app.request(
      `/v1/admin/identity/alias-backfill/${crypto.randomUUID()}`,
      { headers: ADMIN_HEADERS },
    );
    expect(res.status).toBe(404);
  });

  it("routes require admin auth", async () => {
    const res = await app.request("/v1/admin/identity/alias-parity");
    expect(res.status).toBe(401);
  });

  it("GET /v1/admin/identity/alias-parity classifies diverged / dead / alias-only", async () => {
    // Manufacture one row of each class under a kind unlikely to collide with
    // concurrent suites, then assert on the DELTA (the endpoint is a global
    // count over a shared table).
    const before = await app.request("/v1/admin/identity/alias-parity", {
      headers: ADMIN_HEADERS,
    });
    expect(before.status).toBe(200);
    const beforeKinds = (await before.json()).kinds as Array<{
      kind: string;
      diverged: number;
      aliasDead: number;
      aliasOnly: number;
    }>;
    const beforeDiscord = beforeKinds.find((k) => k.kind === "discord") ?? {
      diverged: 0,
      aliasDead: 0,
      aliasOnly: 0,
    };

    // diverged: alias → live A, column → live B, same (kind, value).
    const a = await seedContact({ email: `${RUN}-parity-a@example.com` });
    await db.insert(contactAliases).values({
      contactId: a,
      aliasKind: "discord",
      aliasValue: uid("parity-diverged"),
      fromContactId: null,
      reason: "resolve",
    });
    await seedContact({ discordId: uid("parity-diverged") });
    // dead: alias → soft-deleted target, live column owner elsewhere.
    const deadTarget = await seedContact({ deletedAt: new Date() });
    await db.insert(contactAliases).values({
      contactId: deadTarget,
      aliasKind: "discord",
      aliasValue: uid("parity-dead"),
      fromContactId: null,
      reason: "resolve",
    });
    await seedContact({ discordId: uid("parity-dead") });
    // alias-only: alias with no column owner anywhere.
    await db.insert(contactAliases).values({
      contactId: a,
      aliasKind: "discord",
      aliasValue: uid("parity-only"),
      fromContactId: null,
      reason: "promote",
    });

    const after = await app.request("/v1/admin/identity/alias-parity", {
      headers: ADMIN_HEADERS,
    });
    expect(after.status).toBe(200);
    const afterKinds = (await after.json()).kinds as typeof beforeKinds;
    const afterDiscord = afterKinds.find((k) => k.kind === "discord");
    expect(afterDiscord).toBeDefined();
    if (!afterDiscord) throw new Error("unreachable");
    expect(afterDiscord.diverged - beforeDiscord.diverged).toBe(1);
    expect(afterDiscord.aliasDead - beforeDiscord.aliasDead).toBe(1);
    expect(afterDiscord.aliasOnly - beforeDiscord.aliasOnly).toBe(1);
  });
});
