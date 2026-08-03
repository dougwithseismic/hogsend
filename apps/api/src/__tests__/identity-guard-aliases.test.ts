import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// DB-touching test. The DEFAULT below is the repo-wide one every file in this
// directory shares, and it is what CI's service container listens on. Point a
// worktree at its own stack by exporting HOGSEND_TEST_DATABASE_URL — never by
// editing the default.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// The feed routes AWAIT `ingestEvent`, whose Hatchet push failure triggers a
// compensating delete — the CONTAINER's hatchet must be mocked, not just
// apps/api's module-level one.
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

const { apiKeys, contactAliases, contacts, feedItems, userEvents } =
  await import("@hogsend/db");
const { and, eq, inArray, like, or } = await import("drizzle-orm");
const { createApp, createHogsendClient, resolveOrCreateContact, sendFeedItem } =
  await import("@hogsend/engine");
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

const RUN = `iga-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const uid = (label: string) => `${RUN}-${label}`;
const mail = (label: string) => `${RUN}-${label}@example.com`;

const PK_KEY = `pk_test_${RUN}_publishable`;
const SECRET_KEY = `hsk_test_${RUN}_secret`;
const ORIGIN = "https://app.example.com";
const PK_HEADERS = {
  Authorization: `Bearer ${PK_KEY}`,
  "Content-Type": "application/json",
  Origin: ORIGIN,
};
const SECRET_HEADERS = {
  Authorization: `Bearer ${SECRET_KEY}`,
  "Content-Type": "application/json",
};
const ADMIN_HEADERS = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};

const hashKey = (raw: string) => createHash("sha256").update(raw).digest("hex");
const createdKeyIds: string[] = [];
const createdContactIds: string[] = [];

function track(id: string): string {
  createdContactIds.push(id);
  return id;
}

/** Read the bell exactly as an unidentified browser does: pk_ key + anon id. */
function readBell(anonymousId: string) {
  return app.request(
    `/v1/feed?anonymousId=${encodeURIComponent(anonymousId)}`,
    { method: "GET", headers: PK_HEADERS },
  );
}

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

/**
 * Drive a REAL merge and return `{ survivorId, staleKey }`: two identified
 * contacts (the shared-browser shape) collide on the loser's email, the older
 * one survives, and the loser's external key becomes a STALE alias on the
 * survivor while its own row is soft-deleted.
 */
async function mergedPair(label: string, opts?: { survivorEmail?: boolean }) {
  const survivorKey = uid(`${label}-survivor`);
  const staleKey = uid(`${label}-stale`);
  const loserEmail = mail(`${label}-loser`);

  // With `survivorEmail`, the survivor keeps its OWN address, so the loser's
  // email is NOT folded onto the column and survives ONLY as an alias row —
  // the shape that exercises email-alias fallbacks.
  const survivor = await resolveOrCreateContact({
    db,
    userId: survivorKey,
    ...(opts?.survivorEmail ? { email: mail(`${label}-survivor`) } : {}),
  });
  track(survivor.id);
  const loser = await resolveOrCreateContact({
    db,
    userId: staleKey,
    email: loserEmail,
  });
  track(loser.id);

  const merged = await resolveOrCreateContact({
    db,
    userId: survivorKey,
    email: loserEmail,
  });
  expect(merged.id).toBe(survivor.id);

  // The merge really happened: the loser is soft-deleted and its old external
  // key resolves to the survivor through the identity table only.
  const [loserRow] = await db
    .select({ deletedAt: contacts.deletedAt })
    .from(contacts)
    .where(eq(contacts.id, loser.id));
  expect(loserRow?.deletedAt).not.toBeNull();
  const stale = await aliasRows("external", staleKey);
  expect(stale).toHaveLength(1);
  expect(stale[0]?.contactId).toBe(survivor.id);

  return { survivorId: survivor.id, survivorKey, staleKey, loserEmail };
}

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
  await db
    .delete(contactAliases)
    .where(like(contactAliases.aliasValue, `${RUN}-%`));
  if (createdContactIds.length > 0) {
    await db
      .delete(contactAliases)
      .where(inArray(contactAliases.contactId, createdContactIds));
  }
  await db.delete(feedItems).where(like(feedItems.recipientKey, `${RUN}-%`));
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

// ===========================================================================
// PRD 07 T6b — the guards read the identity table, not just the columns.
// The column probes are blind to a merged loser's STALE keys (its row is
// soft-deleted) and, before 0.61.0, that blindness was a live leak: a
// publishable caller presenting a merged-away external key as `?anonymousId=`
// read the pre-merge feed items still stored under that key.
// ===========================================================================

describe("collidesWithIdentified — alias leg (feed 403 boundary)", () => {
  it("a merged-away external key is NOT addressable as an anonymousId", async () => {
    const label = "stale";
    const survivorKey = uid(`${label}-survivor`);
    const staleKey = uid(`${label}-stale`);
    const loserEmail = mail(`${label}-loser`);

    // The victim's second identified contact gets a feed item BEFORE the
    // merge, keyed on its then-canonical external key.
    const survivor = await resolveOrCreateContact({ db, userId: survivorKey });
    track(survivor.id);
    const loser = await resolveOrCreateContact({
      db,
      userId: staleKey,
      email: loserEmail,
    });
    track(loser.id);
    const sent = await sendFeedItem({
      recipient: { userId: staleKey },
      type: `${RUN}.premerge`,
      title: "Pre-merge private item",
    });
    expect(sent.recipientKey).toBe(staleKey);

    const merged = await resolveOrCreateContact({
      db,
      userId: survivorKey,
      email: loserEmail,
    });
    expect(merged.id).toBe(survivor.id);

    // The attack: a token-less publishable caller names the victim's STALE
    // key as its own anon id. The column guard cannot see it (the loser row
    // is soft-deleted); the alias leg must. Before the fix this returned 200
    // WITH the pre-merge item — a real leak, not a theoretical one.
    const res = await readBell(staleKey);
    expect(res.status).toBe(403);
  });

  it("an identified contact's email is NOT addressable as an anonymousId", async () => {
    // Deliberate tightening: the column guard allowed an email when an
    // external_id existed (the email keys no history), the alias leg rejects
    // every non-anonymous key of a live contact. Pinned as intended behaviour.
    const email = mail("tight");
    const row = await resolveOrCreateContact({
      db,
      userId: uid("tight-user"),
      email,
    });
    track(row.id);

    const res = await readBell(email);
    expect(res.status).toBe(403);
  });

  it("a claimed second-device anon id STAYS addressable (anti-lockout)", async () => {
    // The alias leg excludes kind 'anonymous' precisely so a browser's own
    // anon id — even one held by an identified contact as a claimed identity
    // row — keeps reading its own bell. Widening the rejection over anonymous
    // aliases would 403-lock every identified visitor out.
    const userId = uid("own-user");
    const device1 = uid("own-dev1");
    const device2 = uid("own-dev2");

    const first = await resolveOrCreateContact({
      db,
      userId,
      anonymousId: device1,
    });
    track(first.id);
    const second = await resolveOrCreateContact({
      db,
      userId,
      anonymousId: device2,
    });
    expect(second.id).toBe(first.id);
    // The second device's id lives ONLY as an identity row (the column holds
    // the first device's) — exactly the shape the guard must not reject.
    expect(await aliasRows("anonymous", device2)).toHaveLength(1);

    const res = await readBell(device2);
    expect(res.status).toBe(200);
  });
});

describe("contactSearchFilter — alias leg", () => {
  it("admin search finds the survivor by a merged-away stale key", async () => {
    // The stale key exists ONLY as an identity row (the loser's columns left
    // with its soft-deleted row), so this hit can come from nowhere but the
    // EXISTS leg.
    const { survivorId, staleKey } = await mergedPair("search");

    const res = await app.request(
      `/v1/admin/contacts?search=${encodeURIComponent(staleKey)}&identity=all`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
          "Content-Type": "application/json",
        },
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.contacts.map((c: { id: string }) => c.id);
    expect(ids).toContain(survivorId);
  });
});

describe("resolution flips onto the identity table (PRD 07 T7c)", () => {
  it("public find + admin detail resolve a stale external key to the survivor", async () => {
    const { survivorId, staleKey } = await mergedPair("resolve");

    const find = await app.request(
      `/v1/contacts/find?userId=${encodeURIComponent(staleKey)}`,
      { method: "GET", headers: SECRET_HEADERS },
    );
    expect(find.status).toBe(200);
    const found = await find.json();
    expect(found.contacts.map((c: { id: string }) => c.id)).toContain(
      survivorId,
    );

    const detail = await app.request(
      `/v1/admin/contacts/${encodeURIComponent(staleKey)}`,
      { method: "GET", headers: ADMIN_HEADERS },
    );
    expect(detail.status).toBe(200);
    const body = await detail.json();
    expect(body.contact.id).toBe(survivorId);
  });

  it("find by a stale email resolves the survivor through the alias row", async () => {
    // survivorEmail: the loser's address is NOT folded onto the survivor's
    // column, so only the alias row can produce this hit.
    const { survivorId, loserEmail } = await mergedPair("findmail", {
      survivorEmail: true,
    });

    const res = await app.request(
      `/v1/contacts/find?email=${encodeURIComponent(loserEmail)}`,
      { method: "GET", headers: SECRET_HEADERS },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contacts.map((c: { id: string }) => c.id)).toContain(
      survivorId,
    );
  });

  it("the secret-key feed keys a stale email onto the survivor's feed", async () => {
    const { survivorId, survivorKey, loserEmail } = await mergedPair("feed", {
      survivorEmail: true,
    });
    const sent = await sendFeedItem({
      recipient: { userId: survivorKey },
      type: `${RUN}.postmerge`,
      title: "Survivor feed item",
    });
    expect(sent.recipientKey).toBe(survivorKey);
    expect(survivorId).toBeTruthy();

    const res = await app.request(
      `/v1/feed?email=${encodeURIComponent(loserEmail)}`,
      { method: "GET", headers: SECRET_HEADERS },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: { type: string }) => i.type)).toContain(
      `${RUN}.postmerge`,
    );
  });

  it("erasure by a stale external key soft-deletes the survivor", async () => {
    const { survivorId, staleKey } = await mergedPair("erase");

    const res = await app.request("/v1/contacts", {
      method: "DELETE",
      headers: SECRET_HEADERS,
      body: JSON.stringify({ userId: staleKey }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);

    const [row] = await db
      .select({ deletedAt: contacts.deletedAt })
      .from(contacts)
      .where(eq(contacts.id, survivorId));
    expect(row?.deletedAt).not.toBeNull();
  });

  it("a merge freezes the loser's string keys — ownership moves on the FK only", async () => {
    const label = "freeze";
    const survivorKey = uid(`${label}-survivor`);
    const staleKey = uid(`${label}-stale`);
    const loserEmail = mail(`${label}-loser`);

    const survivor = await resolveOrCreateContact({ db, userId: survivorKey });
    track(survivor.id);
    const loser = await resolveOrCreateContact({
      db,
      userId: staleKey,
      email: loserEmail,
    });
    track(loser.id);
    // One row the loser OWNS (stamped at write time) and one ORPHAN under its
    // key — the two shapes the merge must handle differently, with the same
    // frozen-key outcome.
    await db.insert(userEvents).values([
      { userId: staleKey, contactId: loser.id, event: `${RUN}.owned` },
      { userId: staleKey, event: `${RUN}.orphan` },
    ]);

    const merged = await resolveOrCreateContact({
      db,
      userId: survivorKey,
      email: loserEmail,
    });
    expect(merged.id).toBe(survivor.id);

    const rows = await db
      .select({
        userId: userEvents.userId,
        contactId: userEvents.contactId,
        event: userEvents.event,
      })
      .from(userEvents)
      .where(eq(userEvents.userId, staleKey));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // The string key is a frozen record of the key the write happened
      // under; the survivor owns the rows through contact_id alone.
      expect(row.userId).toBe(staleKey);
      expect(row.contactId).toBe(survivor.id);
    }
  });
});

describe("keysAnotherContact — alias leg (claim gate)", () => {
  it("a stale merged-away key cannot be claimed cross-kind as an anonymousId", async () => {
    // Same blindness, other arm: before the fix the claim gate's column probe
    // missed the soft-deleted loser, so an attacker could CLAIM the stale key
    // as their anon id — hijacking its resolution edge, so the victim's later
    // events under that key would fold into the attacker's contact.
    const { staleKey } = await mergedPair("claim");
    const attackerKey = uid("claim-attacker");

    const attacker = await resolveOrCreateContact({ db, userId: attackerKey });
    track(attacker.id);
    const result = await resolveOrCreateContact({
      db,
      userId: attackerKey,
      anonymousId: staleKey, // ← the victim's merged-away external key
    });
    expect(result.id).toBe(attacker.id);

    // Refused wholesale: no anonymous claim, no column write, no report — and
    // the stale key still resolves to the SURVIVOR, not the attacker.
    expect(await aliasRows("anonymous", staleKey)).toHaveLength(0);
    const [attackerRow] = await db
      .select({ anonymousId: contacts.anonymousId })
      .from(contacts)
      .where(eq(contacts.id, attacker.id));
    expect(attackerRow?.anonymousId).toBeNull();
    expect(result.mergedKeys ?? []).not.toContain(staleKey);
  });
});
