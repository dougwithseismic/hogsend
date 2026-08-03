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
const { createApp, createHogsendClient, resolveOrCreateContact } = await import(
  "@hogsend/engine"
);
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

const RUN = `cmk-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const uid = (label: string) => `${RUN}-${label}`;
const mail = (label: string) => `${RUN}-${label}@example.com`;

const PK_KEY = `pk_test_${RUN}_publishable`;
const ORIGIN = "https://app.example.com";
const PK_HEADERS = {
  Authorization: `Bearer ${PK_KEY}`,
  "Content-Type": "application/json",
  Origin: ORIGIN,
};

const hashKey = (raw: string) => createHash("sha256").update(raw).digest("hex");
const createdKeyIds: string[] = [];
const createdContactIds: string[] = [];

function track(id: string): string {
  createdContactIds.push(id);
  return id;
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

async function eventsUnder(key: string) {
  return db.select().from(userEvents).where(eq(userEvents.userId, key));
}

async function contactColumns(id: string) {
  const [row] = await db
    .select({
      externalId: contacts.externalId,
      email: contacts.email,
      anonymousId: contacts.anonymousId,
      discordId: contacts.discordId,
    })
    .from(contacts)
    .where(eq(contacts.id, id));
  return row;
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
        like(contacts.discordId, `${RUN}-%`),
      ),
    );
  for (const id of createdKeyIds) {
    await db.delete(apiKeys).where(eq(apiKeys.id, id));
  }
});

// ===========================================================================
// T1 — every canonical-capable claim is gated on keysAnotherContact
// ===========================================================================

describe("T1 — foreign-key claims are refused on BOTH attach arms", () => {
  it("if-arm: a victim's external_id named as anonymousId is not claimed, aliased, or adopted", async () => {
    const victimKey = uid("t1a-victim");
    const attackerKey = uid("t1a-attacker");

    // Victim: identified, canonical key = external_id.
    const victim = await resolveOrCreateContact({ db, userId: victimKey });
    track(victim.id);
    await db
      .insert(userEvents)
      .values({ userId: victimKey, event: `${RUN}.victim.action` });

    // Attacker: identified, anonymous_id column FREE — the shape the docs
    // server-side fold produces, which routes the claim through the IF-arm
    // (column write), the arm the pre-PRD-03 code left ungated.
    const attacker = await resolveOrCreateContact({
      db,
      userId: attackerKey,
      email: mail("t1a-attacker"),
    });
    track(attacker.id);

    const result = await resolveOrCreateContact({
      db,
      userId: attackerKey,
      anonymousId: victimKey, // ← names the victim's canonical key
    });
    expect(result.id).toBe(attacker.id);

    // The claim was refused wholesale: no column write, no alias, no report.
    const cols = await contactColumns(attacker.id);
    expect(cols?.anonymousId).toBeNull();
    expect(await aliasRows("anonymous", victimKey)).toHaveLength(0);
    expect(result.mergedKeys ?? []).not.toContain(victimKey);

    // And no history moved: the victim's events still key on THEIR string, and
    // none jumped to the attacker's canonical key.
    expect(await eventsUnder(victimKey)).toHaveLength(1);
    const attackerEvents = await eventsUnder(attackerKey);
    expect(
      attackerEvents.filter((e) => e.event === `${RUN}.victim.action`),
    ).toHaveLength(0);
  });

  it("external-arm: a victim's anon-canonical key named as userId is not claimed and flips nothing", async () => {
    const victimAnon = uid("t1b-victim-anon");
    const attackerEmail = mail("t1b-attacker");

    // Victim: anonymous-only — canonical key IS the anonymous_id.
    const victim = await resolveOrCreateContact({
      db,
      anonymousId: victimAnon,
    });
    track(victim.id);
    await db
      .insert(userEvents)
      .values({ userId: victimAnon, event: `${RUN}.victim2.action` });

    // Attacker: email-only contact (canonical key = its row uuid).
    const attacker = await resolveOrCreateContact({ db, email: attackerEmail });
    track(attacker.id);
    await db
      .insert(userEvents)
      .values({ userId: attacker.id, event: `${RUN}.attacker2.action` });

    // Resolve naming the victim's canonical key as userId. findByKey('external')
    // never probes the anonymous namespace, so this reaches fill-in-link as a
    // single candidate — and pre-PRD-03 would have WRITTEN external_id = victim
    // key, flipped the attacker's canonical key onto it, and repointed the
    // attacker's history INTO the victim's key string.
    const result = await resolveOrCreateContact({
      db,
      email: attackerEmail,
      userId: victimAnon,
    });
    expect(result.id).toBe(attacker.id);

    const cols = await contactColumns(attacker.id);
    expect(cols?.externalId).toBeNull();
    expect(await aliasRows("external", victimAnon)).toHaveLength(0);
    expect(result.mergedKeys ?? []).not.toContain(victimAnon);
    expect(result.mergedIdentifiedKeys ?? []).not.toContain(victimAnon);

    // ZERO rows moved between the two key strings.
    const underVictimKey = await eventsUnder(victimAnon);
    expect(underVictimKey).toHaveLength(1);
    expect(underVictimKey[0]?.event).toBe(`${RUN}.victim2.action`);
    expect(await eventsUnder(attacker.id)).toHaveLength(1);
  });
});

// ===========================================================================
// T2 — adoption + idempotence through the uniform claim path
// ===========================================================================

describe("T2 — uniform claim path preserves adoption and idempotence", () => {
  it("a second device's anon id is claimed, its orphaned history adopted, and it resolves back", async () => {
    const extId = uid("t2-ext");
    const device1 = uid("t2-anon1");
    const device2 = uid("t2-anon2");

    const contact = await resolveOrCreateContact({
      db,
      userId: extId,
      anonymousId: device1,
    });
    track(contact.id);

    // Orphaned pre-sign-in history on the second device (observation refusal
    // stored the event, minted nothing).
    await db
      .insert(userEvents)
      .values({ userId: device2, event: `${RUN}.browsed` });

    const claimed = await resolveOrCreateContact({
      db,
      userId: extId,
      anonymousId: device2,
    });
    expect(claimed.id).toBe(contact.id);
    expect(claimed.mergedKeys).toContain(device2);

    // Column keeps the first device; the second is an identity row.
    const cols = await contactColumns(contact.id);
    expect(cols?.anonymousId).toBe(device1);
    const rows = await aliasRows("anonymous", device2);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBe(contact.id);

    // History adopted by STAMP (T9 — rows never move): the row stays frozen
    // under the second device's key and carries the contact's id, which is
    // the axis every read now resolves.
    const adopted = await eventsUnder(device2);
    expect(adopted).toHaveLength(1);
    expect(adopted[0]?.event).toBe(`${RUN}.browsed`);
    expect(adopted[0]?.contactId).toBe(contact.id);

    // A later resolve on the second id alone lands on the same person.
    const reResolved = await resolveOrCreateContact({
      db,
      anonymousId: device2,
    });
    expect(reResolved.id).toBe(contact.id);
    expect(reResolved.created).toBe(false);
  });

  it("re-supplying the same second value re-reports nothing and leaves one alias row", async () => {
    const extId = uid("t2i-ext");
    const device2 = uid("t2i-anon2");

    const contact = await resolveOrCreateContact({
      db,
      userId: extId,
      anonymousId: uid("t2i-anon1"),
    });
    track(contact.id);

    const first = await resolveOrCreateContact({
      db,
      userId: extId,
      anonymousId: device2,
    });
    expect(first.mergedKeys).toContain(device2);

    // The repeat is the hottest path there is (every page load from a known
    // second device). It must not re-claim, re-adopt, or — the part that
    // escapes the DB — re-fire the analytics stitch via mergedKeys.
    const second = await resolveOrCreateContact({
      db,
      userId: extId,
      anonymousId: device2,
    });
    expect(second.id).toBe(contact.id);
    expect(second.mergedKeys ?? []).not.toContain(device2);
    expect(await aliasRows("anonymous", device2)).toHaveLength(1);
  });
});

// ===========================================================================
// T3 — second values for email / discord / external become identity rows
// ===========================================================================

describe("T3 — a second value per kind is claimed, never dropped", () => {
  it("a second email is an identity row; the column (and send target) keeps the first", async () => {
    const extId = uid("t3e-ext");
    const email1 = mail("t3e-first");
    const email2 = mail("t3e-second");

    const contact = await resolveOrCreateContact({
      db,
      userId: extId,
      email: email1,
    });
    track(contact.id);

    const second = await resolveOrCreateContact({
      db,
      userId: extId,
      email: email2,
    });
    expect(second.id).toBe(contact.id);

    const cols = await contactColumns(contact.id);
    expect(cols?.email).toBe(email1); // send target unchanged
    const rows = await aliasRows("email", email2);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBe(contact.id);

    const byEmail2 = await resolveOrCreateContact({ db, email: email2 });
    expect(byEmail2.id).toBe(contact.id);
    expect(byEmail2.created).toBe(false);
  });

  it("a second discordId is an identity row; the column keeps the first", async () => {
    const extId = uid("t3d-ext");
    const disc1 = uid("t3d-disc1");
    const disc2 = uid("t3d-disc2");

    const contact = await resolveOrCreateContact({
      db,
      userId: extId,
      discordId: disc1,
    });
    track(contact.id);

    const second = await resolveOrCreateContact({
      db,
      userId: extId,
      discordId: disc2,
    });
    expect(second.id).toBe(contact.id);

    const cols = await contactColumns(contact.id);
    expect(cols?.discordId).toBe(disc1);
    expect((await aliasRows("discord", disc2))[0]?.contactId).toBe(contact.id);

    const byDisc2 = await resolveOrCreateContact({ db, discordId: disc2 });
    expect(byDisc2.id).toBe(contact.id);
    expect(byDisc2.created).toBe(false);
  });

  it("a second external id is an identity row: no column overwrite, no flip, history NOT moved (PRD 04's job)", async () => {
    const email = mail("t3x");
    const ext1 = uid("t3x-u1");
    const ext2 = uid("t3x-u2");

    const contact = await resolveOrCreateContact({
      db,
      email,
      userId: ext1,
    });
    track(contact.id);

    // History already keyed on the second id (e.g. another system's exports).
    await db
      .insert(userEvents)
      .values({ userId: ext2, event: `${RUN}.imported` });

    const second = await resolveOrCreateContact({ db, email, userId: ext2 });
    expect(second.id).toBe(contact.id);

    const cols = await contactColumns(contact.id);
    expect(cols?.externalId).toBe(ext1); // canonical key did NOT flip
    expect((await aliasRows("external", ext2))[0]?.contactId).toBe(contact.id);

    const byExt2 = await resolveOrCreateContact({ db, userId: ext2 });
    expect(byExt2.id).toBe(contact.id);
    expect(byExt2.created).toBe(false);

    // The deliberate limit of this PRD: claiming adds a resolution edge and
    // moves NOTHING. PRD 04's contact_id backfill reunites these rows through
    // the identity row written above.
    expect(await eventsUnder(ext2)).toHaveLength(1);
    expect(await eventsUnder(ext1)).toHaveLength(0);
  });
});

// ===========================================================================
// T4 — the merge arm claims call-supplied keys the survivor cannot hold
// ===========================================================================

describe("T4 — collide-merge claims what the survivor's columns cannot hold", () => {
  it("a call-supplied external id neither candidate holds survives as an identity row on the survivor", async () => {
    const anonShared = uid("t4-anon");
    const emailB = mail("t4-b");
    const freshExt = uid("t4-fresh-ext");

    // A: anonymous-only. B: identified — the survivor by the SURVIVOR RULE.
    const a = await resolveOrCreateContact({ db, anonymousId: anonShared });
    track(a.id);
    const b = await resolveOrCreateContact({
      db,
      userId: uid("t4-b-ext"),
      email: emailB,
    });
    track(b.id);

    // Collide A (via anon) with B (via email), supplying an external id
    // NEITHER holds. B's external_id column is occupied, so pre-PRD-03 the
    // supplied value was silently dropped.
    const merged = await resolveOrCreateContact({
      db,
      anonymousId: anonShared,
      email: emailB,
      userId: freshExt,
    });
    expect(merged.merged).toBe(true);
    expect(merged.id).toBe(b.id);

    const cols = await contactColumns(b.id);
    expect(cols?.externalId).toBe(uid("t4-b-ext")); // column unchanged
    const rows = await aliasRows("external", freshExt);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBe(b.id);

    // Both the absorbed anon key and the claimed external id resolve back.
    const byAnon = await resolveOrCreateContact({
      db,
      anonymousId: anonShared,
    });
    expect(byAnon.id).toBe(b.id);
    const byFresh = await resolveOrCreateContact({ db, userId: freshExt });
    expect(byFresh.id).toBe(b.id);
    expect(byFresh.created).toBe(false);
  });

  it("a call-supplied FOREIGN key is still refused on the merge arm", async () => {
    // Victim: anonymous-only — canonical key IS the anon id, which the
    // 'external' probes never see, so a merge supplying it as userId reaches
    // the claim path un-candidated. The gate must refuse it there too.
    const victimAnon = uid("t4f-victim-anon");
    const victim = await resolveOrCreateContact({
      db,
      anonymousId: victimAnon,
    });
    track(victim.id);
    await db
      .insert(userEvents)
      .values({ userId: victimAnon, event: `${RUN}.t4f.victim` });

    const anonShared = uid("t4f-anon");
    const bExt = uid("t4f-b-ext");
    const a = await resolveOrCreateContact({ db, anonymousId: anonShared });
    track(a.id);
    const b = await resolveOrCreateContact({
      db,
      userId: bExt,
      email: mail("t4f-b"),
    });
    track(b.id);

    // Collide A (anon) with B (email) while naming the victim's canonical key
    // as userId. B's external_id column is occupied, so the value routes
    // through the merge arm's claim step — which must refuse it, not alias it.
    const merged = await resolveOrCreateContact({
      db,
      anonymousId: anonShared,
      email: mail("t4f-b"),
      userId: victimAnon,
    });
    expect(merged.merged).toBe(true);
    expect(merged.id).toBe(b.id);

    expect(await aliasRows("external", victimAnon)).toHaveLength(0);
    const cols = await contactColumns(b.id);
    expect(cols?.externalId).toBe(bExt);
    // The victim and their history are untouched.
    expect(await eventsUnder(victimAnon)).toHaveLength(1);
    const [victimRow] = await db
      .select({ deletedAt: contacts.deletedAt })
      .from(contacts)
      .where(eq(contacts.id, victim.id));
    expect(victimRow?.deletedAt).toBeNull();
  });
});

// ===========================================================================
// T5 — the feed's anonymous recipient resolves through identity rows
// ===========================================================================

describe("T5 — feed recipient sees a second device held as an identity row", () => {
  it("mark-all from the second device folds into the contact instead of being refused", async () => {
    const extId = uid("t5-ext");
    const device1 = uid("t5-anon1");
    const device2 = uid("t5-anon2");
    const feedId = uid("t5-feed");

    // Identified contact whose FIRST device holds the column; the SECOND
    // device's id is claimed as an identity row.
    const contact = await resolveOrCreateContact({
      db,
      userId: extId,
      anonymousId: device1,
    });
    track(contact.id);
    const claimed = await resolveOrCreateContact({
      db,
      userId: extId,
      anonymousId: device2,
    });
    expect(claimed.id).toBe(contact.id);

    // The second device reads its bell: 200, never a 403 — its id is not an
    // identified contact's canonical key, just their alias.
    const read = await app.request(
      `/v1/feed?anonymousId=${encodeURIComponent(device2)}`,
      { headers: PK_HEADERS },
    );
    expect(read.status).toBe(200);

    // The second device clears its bell. Pre-PRD-03 the recipient resolver was
    // blind to alias-held ids: contactId came back undefined, allowCreate was
    // forced off, and the re-ingest was REFUSED — the event stranded under the
    // raw device id with no contact. With the identity-row fallback the
    // re-ingest is pinned to the contact and folds into their canonical key.
    const clear = await app.request("/v1/feed/mark-all", {
      method: "POST",
      headers: PK_HEADERS,
      body: JSON.stringify({ state: "read", anonymousId: device2, feedId }),
    });
    expect(clear.status).toBe(200);

    const underCanonical = await eventsUnder(extId);
    expect(underCanonical.some((e) => e.event === "inapp.feed_cleared")).toBe(
      true,
    );
    // Nothing stranded under the raw device id, and no ghost was minted.
    const underDevice = await eventsUnder(device2);
    expect(underDevice.some((e) => e.event === "inapp.feed_cleared")).toBe(
      false,
    );
    const ghosts = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.externalId, device2));
    expect(ghosts).toHaveLength(0);
  });
});
