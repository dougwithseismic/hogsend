import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// DB-touching test. The DEFAULT below is the repo-wide one every file in this
// directory shares, and it is what CI's service container listens on. Point a
// worktree at its own stack by exporting HOGSEND_TEST_DATABASE_URL — never by
// editing the default.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// The routes AWAIT `ingestEvent`, whose Hatchet push failure triggers the
// compensating delete of the just-claimed `user_events` row — so the CONTAINER's
// hatchet has to be mocked, not just apps/api's module-level one.
vi.mock("../lib/hatchet.js", () => ({
  hatchet: {
    durableTask: vi.fn(() => ({
      run: vi.fn(),
      runNoWait: vi.fn(),
      runAndWait: vi.fn(),
    })),
    task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
    events: { push: vi.fn() },
    runs: { cancel: vi.fn(), get: vi.fn() },
    worker: vi.fn(),
  },
}));

const { apiKeys, contactAliases, contacts, userEvents } = await import(
  "@hogsend/db"
);
const { and, eq, inArray, like, or } = await import("drizzle-orm");
const {
  createApp,
  createHogsendClient,
  deleteIdentityAliasesForContact,
  resolveContactNoCreate,
  resolveOrCreateContact,
} = await import("@hogsend/engine");
type HogsendClient = ReturnType<typeof createHogsendClient>;

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

const RUN = `ial-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const uid = (label: string) => `${RUN}-${label}`;
const mail = (label: string) => `${RUN}-${label}@example.com`;

const SECRET_KEY = `hsk_test_${RUN}_secret`;
const ADMIN_HEADERS = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};
const SECRET_HEADERS = {
  Authorization: `Bearer ${SECRET_KEY}`,
  "Content-Type": "application/json",
};

const hashKey = (raw: string) => createHash("sha256").update(raw).digest("hex");
const createdKeyIds: string[] = [];
const createdContactIds: string[] = [];

/** Every alias row belonging to a contact id. */
async function aliasesFor(contactId: string) {
  return db
    .select()
    .from(contactAliases)
    .where(eq(contactAliases.contactId, contactId));
}

/**
 * Assert a contact's alias rows are gone, tolerating the documented erasure ×
 * backfill race: the identity-alias-backfill suite runs GLOBAL sweeps in
 * parallel with this file, and a batch whose snapshot predates the soft-delete
 * can transiently re-insert rows until that job's end-of-run sweep removes
 * them. The production contract is "erased by job end", so poll briefly before
 * failing — a genuine erasure bug stays permanently non-empty and still fails.
 */
async function expectAliasesGone(contactId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const rows = await aliasesFor(contactId);
    if (rows.length === 0) return;
    if (Date.now() > deadline) {
      expect(rows).toHaveLength(0);
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Alias rows matching a (kind, value). */
async function aliasRows(kind: string, value: string) {
  return db
    .select()
    .from(contactAliases)
    .where(
      and(
        eq(contactAliases.aliasKind, kind),
        eq(contactAliases.aliasValue, value),
      ),
    );
}

/** Directly seed a contacts row, bypassing the resolver (and its dual-write). */
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

beforeAll(async () => {
  const [secretRow] = await db
    .insert(apiKeys)
    .values({
      name: `${RUN} secret ingest`,
      keyPrefix: SECRET_KEY.slice(0, 8),
      keyHash: hashKey(SECRET_KEY),
      scopes: ["ingest"],
    })
    .returning({ id: apiKeys.id });
  if (secretRow) createdKeyIds.push(secretRow.id);
});

afterAll(async () => {
  // Aliases first (no FK pressure either way, but keeps the sweep readable).
  await db
    .delete(contactAliases)
    .where(like(contactAliases.aliasValue, `${RUN}-%`));
  if (createdContactIds.length > 0) {
    await db
      .delete(contactAliases)
      .where(inArray(contactAliases.contactId, createdContactIds));
  }
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  await db
    .delete(contacts)
    .where(
      or(
        like(contacts.externalId, `${RUN}-%`),
        like(contacts.anonymousId, `${RUN}-%`),
        like(contacts.email, `${RUN}-%`),
      ),
    );
  for (const id of createdKeyIds) {
    await db.delete(apiKeys).where(eq(apiKeys.id, id));
  }
});

// ---------------------------------------------------------------------------
// T1 — erasure removes EVERY alias row for the erased contact
// ---------------------------------------------------------------------------

describe("T1 — erasure deletes every contact_aliases row for the contact", () => {
  it("public DELETE /v1/contacts removes resolve, promote AND absorbed rows", async () => {
    const extId = uid("t1-pub");
    const ownEmail = mail("t1-pub-own");
    const absorbedEmail = mail("t1-pub-absorbed");
    const contactId = await seedContact({ externalId: extId, email: ownEmail });

    // All three row shapes. The absorbed row (fromContactId set) carries a
    // DISTINCT email — it is the row two earlier revisions of the erasure rule
    // would have kept behind.
    await db.insert(contactAliases).values([
      {
        contactId,
        aliasKind: "external",
        aliasValue: extId,
        fromContactId: null,
        reason: "resolve",
      },
      {
        contactId,
        aliasKind: "email",
        aliasValue: ownEmail,
        fromContactId: null,
        reason: "promote",
      },
      {
        contactId,
        aliasKind: "email",
        aliasValue: absorbedEmail,
        fromContactId: crypto.randomUUID(),
        reason: "merge",
      },
    ]);

    const res = await app.request("/v1/contacts", {
      method: "DELETE",
      headers: SECRET_HEADERS,
      body: JSON.stringify({ userId: extId }),
    });
    expect(res.status).toBe(200);

    await expectAliasesGone(contactId);
    // The absorbed email specifically must be gone (non-negotiable #1). It is
    // no contact's COLUMN value, so no backfill race can re-insert it.
    expect(await aliasRows("email", absorbedEmail)).toHaveLength(0);
  });

  it("admin DELETE /v1/admin/contacts/:id removes all three shapes too", async () => {
    const extId = uid("t1-adm");
    const absorbedEmail = mail("t1-adm-absorbed");
    const contactId = await seedContact({ externalId: extId });

    await db.insert(contactAliases).values([
      {
        contactId,
        aliasKind: "external",
        aliasValue: extId,
        fromContactId: null,
        reason: "resolve",
      },
      {
        contactId,
        aliasKind: "email",
        aliasValue: absorbedEmail,
        fromContactId: crypto.randomUUID(),
        reason: "merge",
      },
    ]);

    const res = await app.request(`/v1/admin/contacts/${contactId}`, {
      method: "DELETE",
      headers: ADMIN_HEADERS,
    });
    expect(res.status).toBe(200);

    await expectAliasesGone(contactId);
    expect(await aliasRows("email", absorbedEmail)).toHaveLength(0);
  });

  it("erasing a merge SURVIVOR removes the absorbed rows the real merge wrote", async () => {
    const survivorExt = uid("t1-srv");
    const loserEmail = mail("t1-srv-loser");

    // Real merge: an identified contact + an email-only contact collide.
    const a = await resolveOrCreateContact({ db, userId: survivorExt });
    createdContactIds.push(a.id);
    const b = await resolveOrCreateContact({ db, email: loserEmail });
    createdContactIds.push(b.id);
    const merged = await resolveOrCreateContact({
      db,
      userId: survivorExt,
      email: loserEmail,
    });
    expect(merged.merged).toBe(true);
    expect(merged.id).toBe(a.id);

    // The merge recorded the loser's email as an absorbed alias on the survivor.
    const absorbed = await aliasRows("email", loserEmail);
    expect(absorbed.some((r) => r.contactId === a.id)).toBe(true);

    const res = await app.request("/v1/contacts", {
      method: "DELETE",
      headers: SECRET_HEADERS,
      body: JSON.stringify({ userId: survivorExt }),
    });
    expect(res.status).toBe(200);

    // EVERY row for the survivor is gone — including the absorbed loser email,
    // which in the common merge is the same human's old address.
    await expectAliasesGone(a.id);
    expect(await aliasRows("email", loserEmail)).toHaveLength(0);
  });

  it("erasing a LOSER's aliases leaves the survivor's merge trail intact", async () => {
    const survivorExt = uid("t1-trail");
    const loserEmail = mail("t1-trail-loser");

    const a = await resolveOrCreateContact({ db, userId: survivorExt });
    createdContactIds.push(a.id);
    const b = await resolveOrCreateContact({ db, email: loserEmail });
    createdContactIds.push(b.id);
    const merged = await resolveOrCreateContact({
      db,
      userId: survivorExt,
      email: loserEmail,
    });
    expect(merged.id).toBe(a.id);

    // Erase the LOSER (its row is already soft-deleted by the merge). The
    // helper is keyed on contact_id, and the merge trail lives under the
    // SURVIVOR's contact_id — so nothing of A's may move.
    await deleteIdentityAliasesForContact(db, b.id);

    const survivorRows = await aliasesFor(a.id);
    expect(survivorRows.some((r) => r.aliasValue === loserEmail)).toBe(true);

    // The loser's stale key still resolves to the survivor.
    const reResolved = await resolveOrCreateContact({ db, email: loserEmail });
    expect(reResolved.id).toBe(a.id);
    expect(reResolved.created).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T2 — dual-write on the three resolver arms
// ---------------------------------------------------------------------------

describe("T2 — ensureIdentityAliases dual-write", () => {
  it("(a) a fresh POST /v1/events with a userId writes one ('external') resolve row", async () => {
    const extId = uid("t2-create");
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: SECRET_HEADERS,
      body: JSON.stringify({ name: `${RUN}.signup`, userId: extId }),
    });
    expect(res.status).toBe(202);

    const [contact] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.externalId, extId));
    expect(contact).toBeDefined();
    if (!contact) throw new Error("unreachable");
    createdContactIds.push(contact.id);

    const rows = await aliasRows("external", extId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBe(contact.id);
    expect(rows[0]?.reason).toBe("resolve");
    expect(rows[0]?.fromContactId).toBeNull();
  });

  it("(b) a second identical event inserts nothing and leaves updated_at unchanged", async () => {
    const extId = uid("t2-idem");
    const first = await app.request("/v1/events", {
      method: "POST",
      headers: SECRET_HEADERS,
      body: JSON.stringify({ name: `${RUN}.ping`, userId: extId }),
    });
    expect(first.status).toBe(202);

    const before = await aliasRows("external", extId);
    expect(before).toHaveLength(1);

    const second = await app.request("/v1/events", {
      method: "POST",
      headers: SECRET_HEADERS,
      body: JSON.stringify({ name: `${RUN}.ping`, userId: extId }),
    });
    expect(second.status).toBe(202);

    const after = await aliasRows("external", extId);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(after[0]?.updatedAt.toISOString()).toBe(
      before[0]?.updatedAt.toISOString(),
    );

    const [contact] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.externalId, extId));
    if (contact) createdContactIds.push(contact.id);
  });

  it("(c) fill-in-link backfills a row per column on a pre-alias contact, email normalized", async () => {
    const extId = uid("t2-fill");
    const mixedEmail = `MiXeD-${RUN}@Example.COM`;
    const anonId = uid("t2-fill-anon");
    const discordId = uid("t2-fill-disc");
    // Directly seeded: columns populated, ZERO alias rows — the shape of every
    // contact that predates contact_aliases.
    const contactId = await seedContact({
      externalId: extId,
      email: mixedEmail,
      anonymousId: anonId,
      discordId,
    });

    const resolved = await resolveOrCreateContact({ db, userId: extId });
    expect(resolved.id).toBe(contactId);
    expect(resolved.linked).toBe(true);

    const rows = await aliasesFor(contactId);
    const byKind = new Map(rows.map((r) => [r.aliasKind, r]));
    expect(byKind.get("external")?.aliasValue).toBe(extId);
    // The alias stores the NORMALIZED email even when the legacy column value
    // is mixed-case — that is what findByKey's probe compares against.
    expect(byKind.get("email")?.aliasValue).toBe(
      mixedEmail.trim().toLowerCase(),
    );
    expect(byKind.get("anonymous")?.aliasValue).toBe(anonId);
    expect(byKind.get("discord")?.aliasValue).toBe(discordId);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      // The identity-alias-backfill suite runs a GLOBAL sweep in parallel and
      // can legitimately alias this directly-seeded fixture first — both
      // writers are correct, so accept either author here. The dual-write's
      // own `resolve` reason is pinned race-free by (a) and (d), whose alias
      // rows are written in the same transaction as the contact itself.
      expect(["resolve", "backfill"]).toContain(row.reason);
      expect(row.fromContactId).toBeNull();
    }
    // afterAll sweeps by RUN-prefixed values; the mixed-case email is not
    // RUN-prefixed, but the contactId sweep covers it.
  });

  it("(d) after a collide-merge the survivor holds a row per key and merge provenance survives", async () => {
    const extId = uid("t2-merge");
    const anonId = uid("t2-merge-anon");
    const email = mail("t2-merge");

    const a = await resolveOrCreateContact({ db, userId: extId });
    createdContactIds.push(a.id);
    const b = await resolveOrCreateContact({ db, anonymousId: anonId, email });
    createdContactIds.push(b.id);

    const merged = await resolveOrCreateContact({
      db,
      userId: extId,
      anonymousId: anonId,
    });
    expect(merged.merged).toBe(true);
    expect(merged.id).toBe(a.id);

    const rows = await aliasesFor(a.id);
    const byKindValue = new Map(
      rows.map((r) => [`${r.aliasKind}|${r.aliasValue}`, r]),
    );
    // Survivor's own external id: written by the dual-write.
    expect(byKindValue.get(`external|${extId}`)?.reason).toBe("resolve");
    // The loser's keys: recorded by recordMergeAliases BEFORE the dual-write
    // runs, so their 'merge' provenance must have won the conflict.
    expect(byKindValue.get(`anonymous|${anonId}`)?.reason).toBe("merge");
    expect(byKindValue.get(`email|${email}`)?.reason).toBe("merge");
    expect(byKindValue.get(`anonymous|${anonId}`)?.fromContactId).toBe(b.id);
  });

  it("(e) a key squatted by a DEAD contact's alias is skipped, never stolen", async () => {
    const extId = uid("t2-squat");
    const squattedEmail = mail("t2-squat");

    // A soft-deleted contact whose alias still claims the email. findByKey's
    // live-target rule skips it at read time; the dual-write must skip it at
    // write time (DO NOTHING) rather than repoint it.
    const deadId = await seedContact({ deletedAt: new Date() });
    await db.insert(contactAliases).values({
      contactId: deadId,
      aliasKind: "email",
      aliasValue: squattedEmail,
      fromContactId: null,
      reason: "resolve",
    });

    const resolved = await resolveOrCreateContact({
      db,
      userId: extId,
      email: squattedEmail,
    });
    createdContactIds.push(resolved.id);
    // The column write proceeds (the partial-unique index only covers live
    // rows); only the alias write is skipped.
    const [row] = await db
      .select({ email: contacts.email })
      .from(contacts)
      .where(eq(contacts.id, resolved.id));
    expect(row?.email).toBe(squattedEmail);

    const squatted = await aliasRows("email", squattedEmail);
    expect(squatted).toHaveLength(1);
    expect(squatted[0]?.contactId).toBe(deadId);
  });
});

// ---------------------------------------------------------------------------
// T5 — findByKey reads the alias table first
// ---------------------------------------------------------------------------

describe("T5 — alias-first resolution", () => {
  it("a key present ONLY as an alias resolves to its owner", async () => {
    const extId = uid("t5-only");
    const aliasOnlyAnon = uid("t5-only-anon2");
    const owner = await resolveOrCreateContact({ db, userId: extId });
    createdContactIds.push(owner.id);
    // Simulates a promoted second key (what PRD 03 makes routine): the value
    // exists in NO identity column, only as an alias row.
    await db.insert(contactAliases).values({
      contactId: owner.id,
      aliasKind: "anonymous",
      aliasValue: aliasOnlyAnon,
      fromContactId: null,
      reason: "promote",
    });

    const resolved = await resolveOrCreateContact({
      db,
      anonymousId: aliasOnlyAnon,
    });
    expect(resolved.id).toBe(owner.id);
    expect(resolved.created).toBe(false);
  });

  it("when alias and column disagree, the alias wins (source of truth)", async () => {
    const key = uid("t5-diverged");
    // Alias owner — resolution must land here after the flip. Its own
    // anonymous_id column is already occupied so the fill-in-link takes the
    // claim arm (where `keysAnotherContact` refuses the foreign value) instead
    // of a column write that would trip the partial-unique index. A diverged
    // pair is NOT manufacturable through the resolver (findByKey would have
    // resolved the owner); this direct seed pins the flip's precedence rule.
    const aliasOwner = await seedContact({
      email: mail("t5-alias-owner"),
      anonymousId: uid("t5-alias-owner-anon"),
    });
    await db.insert(contactAliases).values({
      contactId: aliasOwner,
      aliasKind: "anonymous",
      aliasValue: key,
      fromContactId: null,
      reason: "resolve",
    });
    // Column owner — directly seeded so the resolver never aliased it.
    const columnOwner = await seedContact({ anonymousId: key });

    const resolved = await resolveOrCreateContact({ db, anonymousId: key });
    expect(resolved.id).toBe(aliasOwner);
    expect(resolved.id).not.toBe(columnOwner);
    // The column owner is untouched — precedence, never a repoint.
    const [colRow] = await db
      .select({ anonymousId: contacts.anonymousId })
      .from(contacts)
      .where(eq(contacts.id, columnOwner));
    expect(colRow?.anonymousId).toBe(key);
  });

  it("a DEAD alias falls through to the identity-column probe", async () => {
    const key = uid("t5-dead");
    const deadId = await seedContact({ deletedAt: new Date() });
    await db.insert(contactAliases).values({
      contactId: deadId,
      aliasKind: "external",
      aliasValue: key,
      fromContactId: null,
      reason: "resolve",
    });
    const liveId = await seedContact({ externalId: key });

    const resolved = await resolveOrCreateContact({ db, userId: key });
    // Must resolve the LIVE column owner, never the tombstone.
    expect(resolved.id).toBe(liveId);
    expect(resolved.created).toBe(false);
  });

  it("a key in neither alias nor column still takes the create/refuse arm", async () => {
    const refused = await resolveContactNoCreate({
      db,
      anonymousId: uid("t5-refuse"),
    });
    expect(refused.id).toBeNull();
    expect(refused.created).toBe(false);

    const created = await resolveOrCreateContact({
      db,
      anonymousId: uid("t5-create"),
    });
    expect(created.created).toBe(true);
    createdContactIds.push(created.id);
  });
});
