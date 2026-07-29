import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// DB-touching test. The DEFAULT below is the repo-wide one every file in this
// directory shares, and it is what CI's service container listens on. Point a
// worktree at its own stack by exporting HOGSEND_TEST_DATABASE_URL — never by
// editing the default.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// `resolveOrCreateContact` is pure DB, but the container it comes out of builds
// a real Hatchet client at construction time — mock the module the container
// reaches for so no gRPC connection is attempted.
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

const {
  bucketMemberships,
  contactAliases,
  contacts,
  emailPreferences,
  emailSends,
  journeyStates,
  userEvents,
} = await import("@hogsend/db");
const { and, count, eq, inArray, isNull, like, or } = await import(
  "drizzle-orm"
);
const { createHogsendClient, resolveOrCreateContact } = await import(
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
const { db } = container;

// Every identity value this file writes is namespaced to ONE run, so the shared
// DB never collides across files or two consecutive runs of this file.
const RUN = `t3rep-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const uid = (label: string) => `${RUN}-${label}`;
const mail = (label: string) => `${RUN}-${label}@example.com`;

const createdContactIds: string[] = [];
function track(id: string): string {
  createdContactIds.push(id);
  return id;
}

/**
 * The five history tables PRD 04 gave a nullable `contact_id`. Each descriptor
 * carries its OWN `countFor` closure (rather than a shared generic helper over a
 * union of table types) so every read is a real, typed drizzle query against
 * that table's own column.
 */
const HISTORY = [
  {
    name: "user_events",
    countFor: (id: string) =>
      db
        .select({ n: count() })
        .from(userEvents)
        .where(eq(userEvents.contactId, id)),
  },
  {
    name: "journey_states",
    countFor: (id: string) =>
      db
        .select({ n: count() })
        .from(journeyStates)
        .where(eq(journeyStates.contactId, id)),
  },
  {
    name: "bucket_memberships",
    countFor: (id: string) =>
      db
        .select({ n: count() })
        .from(bucketMemberships)
        .where(eq(bucketMemberships.contactId, id)),
  },
  {
    name: "email_sends",
    countFor: (id: string) =>
      db
        .select({ n: count() })
        .from(emailSends)
        .where(eq(emailSends.contactId, id)),
  },
  {
    name: "email_preferences",
    countFor: (id: string) =>
      db
        .select({ n: count() })
        .from(emailPreferences)
        .where(eq(emailPreferences.contactId, id)),
  },
] as const;

type TableName = (typeof HISTORY)[number]["name"];
type Counts = Record<TableName, number>;

/** Direct SQL read of every table's `contact_id` fan-in for one contact. */
async function countsFor(contactId: string): Promise<Counts> {
  const out = {} as Counts;
  for (const t of HISTORY) {
    const rows = await t.countFor(contactId);
    out[t.name] = Number(rows[0]?.n ?? 0);
  }
  return out;
}

/**
 * Write one row per history table, all owned by `contactId` and keyed on
 * `userKey`. `slot` keeps the journey/bucket/pref-email namespaces disjoint
 * between the two sides of a merge, so the merge's key-rewrite FOLDS never have
 * a unique-index collision to resolve by DELETING a loser row — this test is
 * about the `contact_id` re-point, not about fold semantics.
 */
async function seedHistoryRow(opts: {
  contactId: string;
  userKey: string;
  slot: string;
}): Promise<{
  userEventId: string;
  journeyStateId: string;
  bucketMembershipId: string;
  emailSendId: string;
  emailPreferenceId: string;
}> {
  const { contactId, userKey, slot } = opts;

  const [ev] = await db
    .insert(userEvents)
    .values({
      userId: userKey,
      event: `${RUN}.seen.${slot}`,
      contactId,
    })
    .returning({ id: userEvents.id });
  const [js] = await db
    .insert(journeyStates)
    .values({
      userId: userKey,
      userEmail: mail(`${slot}-js`),
      journeyId: uid(`journey-${slot}`),
      currentNodeId: "start",
      contactId,
    })
    .returning({ id: journeyStates.id });
  const [bm] = await db
    .insert(bucketMemberships)
    .values({
      userId: userKey,
      bucketId: uid(`bucket-${slot}`),
      contactId,
    })
    .returning({ id: bucketMemberships.id });
  const [es] = await db
    .insert(emailSends)
    .values({
      userId: userKey,
      userEmail: mail(`${slot}-es`),
      fromEmail: mail("from"),
      toEmail: mail(`${slot}-to`),
      subject: `${RUN} ${slot}`,
      contactId,
    })
    .returning({ id: emailSends.id });
  const [ep] = await db
    .insert(emailPreferences)
    .values({
      userId: userKey,
      email: mail(`${slot}-pref`),
      contactId,
    })
    .returning({ id: emailPreferences.id });

  if (!ev || !js || !bm || !es || !ep) throw new Error("seed insert failed");
  return {
    userEventId: ev.id,
    journeyStateId: js.id,
    bucketMembershipId: bm.id,
    emailSendId: es.id,
    emailPreferenceId: ep.id,
  };
}

afterAll(async () => {
  // Precise, RUN-scoped cleanup. `contact_id` catches the rows whose user_id is
  // a contact uuid (an email-only contact's canonical key is not RUN-prefixed);
  // the `like` sweep catches everything keyed on a RUN string, including rows a
  // merge re-pointed away from a tracked contact.
  if (createdContactIds.length > 0) {
    await db
      .delete(emailSends)
      .where(inArray(emailSends.contactId, createdContactIds));
    await db
      .delete(emailPreferences)
      .where(inArray(emailPreferences.contactId, createdContactIds));
    await db
      .delete(bucketMemberships)
      .where(inArray(bucketMemberships.contactId, createdContactIds));
    await db
      .delete(journeyStates)
      .where(inArray(journeyStates.contactId, createdContactIds));
    await db
      .delete(userEvents)
      .where(inArray(userEvents.contactId, createdContactIds));
    await db
      .delete(contactAliases)
      .where(inArray(contactAliases.contactId, createdContactIds));
  }
  await db
    .delete(emailSends)
    .where(
      or(
        like(emailSends.userId, `${RUN}-%`),
        like(emailSends.toEmail, `${RUN}-%`),
      ),
    );
  await db
    .delete(emailPreferences)
    .where(
      or(
        like(emailPreferences.userId, `${RUN}-%`),
        like(emailPreferences.email, `${RUN}-%`),
      ),
    );
  await db
    .delete(bucketMemberships)
    .where(like(bucketMemberships.userId, `${RUN}-%`));
  await db.delete(journeyStates).where(like(journeyStates.userId, `${RUN}-%`));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  await db
    .delete(contactAliases)
    .where(like(contactAliases.aliasValue, `${RUN}-%`));
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

// ===========================================================================
// Case 1 — a real merge re-points every history table's contact_id
// ===========================================================================

describe("Case 1 — merge re-points contact_id on all five history tables", () => {
  let survivorId: string;
  let loserId: string;
  let before: { survivor: Counts; loser: Counts };
  let after: { survivor: Counts; loser: Counts };

  beforeAll(async () => {
    const extA = uid("c1-a-ext");
    const emailB = mail("c1-b");

    // A is IDENTIFIED (external_id) → the SURVIVOR RULE picks it regardless of
    // firstSeenAt. B is email-only, so its canonical key is its own row uuid.
    const a = await resolveOrCreateContact({ db, userId: extA });
    track(a.id);
    const b = await resolveOrCreateContact({ db, email: emailB });
    track(b.id);
    expect(a.id).not.toBe(b.id);

    // Uneven per-side row counts so a cross-table or wrong-side UPDATE cannot
    // accidentally satisfy the arithmetic.
    await seedHistoryRow({ contactId: a.id, userKey: extA, slot: "a1" });
    await seedHistoryRow({ contactId: a.id, userKey: extA, slot: "a2" });
    await seedHistoryRow({ contactId: b.id, userKey: b.id, slot: "b1" });
    await seedHistoryRow({ contactId: b.id, userKey: b.id, slot: "b2" });
    await seedHistoryRow({ contactId: b.id, userKey: b.id, slot: "b3" });

    before = { survivor: await countsFor(a.id), loser: await countsFor(b.id) };

    // Drive a REAL collide-merge: the call names A's external_id AND B's email,
    // so both candidates resolve and mergeContacts runs.
    const merged = await resolveOrCreateContact({
      db,
      userId: extA,
      email: emailB,
    });
    expect(merged.merged).toBe(true);
    // Assert on the ACTUAL survivor rather than assuming: A carries the
    // external_id, so it wins and B is soft-deleted.
    expect(merged.id).toBe(a.id);
    survivorId = a.id;
    loserId = b.id;

    const [loserRow] = await db
      .select({ deletedAt: contacts.deletedAt })
      .from(contacts)
      .where(eq(contacts.id, b.id));
    expect(loserRow?.deletedAt).not.toBeNull();

    after = { survivor: await countsFor(a.id), loser: await countsFor(b.id) };
  });

  it("seeded both sides of the merge with rows in every table", () => {
    for (const t of HISTORY) {
      expect(before.survivor[t.name], `${t.name} survivor seed`).toBe(2);
      expect(before.loser[t.name], `${t.name} loser seed`).toBe(3);
    }
  });

  // One assertion PER TABLE: deleting any single one of the five UPDATEs turns
  // exactly that table's test red.
  for (const t of HISTORY) {
    it(`${t.name}: no row is left on the soft-deleted loser`, () => {
      expect(after.loser[t.name]).toBe(0);
    });

    it(`${t.name}: the survivor absorbed the loser's rows`, () => {
      expect(after.survivor[t.name]).toBe(
        before.survivor[t.name] + before.loser[t.name],
      );
    });
  }

  it("the merged survivor is the only live contact of the pair", async () => {
    const live = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          isNull(contacts.deletedAt),
          inArray(contacts.id, [survivorId, loserId]),
        ),
      );
    expect(live.map((r) => r.id)).toEqual([survivorId]);
  });
});

// ===========================================================================
// Case 2 — a canonical-key FLIP leaves contact_id byte-identical
// ===========================================================================

describe("Case 2 — fill-in-link flips the key but never touches contact_id", () => {
  const anonId = uid("c2-anon");
  const freshExt = uid("c2-ext");
  let contactId: string;
  let seeded: Awaited<ReturnType<typeof seedHistoryRow>>;
  let liveBefore: string[];
  let liveAfter: string[];

  async function liveC2Contacts(): Promise<string[]> {
    const rows = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          isNull(contacts.deletedAt),
          or(
            like(contacts.externalId, `${RUN}-c2-%`),
            like(contacts.anonymousId, `${RUN}-c2-%`),
            like(contacts.email, `${RUN}-c2-%`),
          ),
        ),
      );
    return rows.map((r) => r.id).sort();
  }

  beforeAll(async () => {
    // Anonymous-only: the canonical key IS the anonymous_id.
    const c = await resolveOrCreateContact({ db, anonymousId: anonId });
    track(c.id);
    contactId = c.id;
    seeded = await seedHistoryRow({
      contactId: c.id,
      userKey: anonId,
      slot: "c2",
    });
    liveBefore = await liveC2Contacts();

    // Identify: same anon id + a FRESH external id. This is the fill-in-link
    // path — one candidate, no merge — which writes external_id and therefore
    // flips the canonical key from anonId → freshExt, running repointOwnHistory.
    const identified = await resolveOrCreateContact({
      db,
      anonymousId: anonId,
      userId: freshExt,
    });
    expect(identified.id).toBe(c.id);
    expect(identified.merged).toBeFalsy();
    expect(identified.resolvedKey).toBe(freshExt);

    liveAfter = await liveC2Contacts();
  });

  it("the key flip left the string keys FROZEN (T9 — the rewrite is deleted)", async () => {
    // Guards the assertions below from being vacuous the other way around:
    // since T9, a canonical-key flip must NOT touch history's `user_id` — the
    // string is a frozen record of the key each row happened under, and
    // ownership rides `contact_id` alone. If a rewrite had run, "contact_id
    // unchanged" below would be certifying the wrong mechanism.
    const [ev] = await db
      .select({ userId: userEvents.userId })
      .from(userEvents)
      .where(eq(userEvents.id, seeded.userEventId));
    const [es] = await db
      .select({ userId: emailSends.userId })
      .from(emailSends)
      .where(eq(emailSends.id, seeded.emailSendId));
    const [bm] = await db
      .select({ userId: bucketMemberships.userId })
      .from(bucketMemberships)
      .where(eq(bucketMemberships.id, seeded.bucketMembershipId));
    expect(ev?.userId).toBe(anonId);
    expect(es?.userId).toBe(anonId);
    expect(bm?.userId).toBe(anonId);
  });

  it("no merge happened — the contact set is unchanged", () => {
    expect(liveBefore).toEqual([contactId]);
    expect(liveAfter).toEqual(liveBefore);
  });

  it("every seeded row still carries the SAME contact_id", async () => {
    const [ev] = await db
      .select({ contactId: userEvents.contactId })
      .from(userEvents)
      .where(eq(userEvents.id, seeded.userEventId));
    const [js] = await db
      .select({ contactId: journeyStates.contactId })
      .from(journeyStates)
      .where(eq(journeyStates.id, seeded.journeyStateId));
    const [bm] = await db
      .select({ contactId: bucketMemberships.contactId })
      .from(bucketMemberships)
      .where(eq(bucketMemberships.id, seeded.bucketMembershipId));
    const [es] = await db
      .select({ contactId: emailSends.contactId })
      .from(emailSends)
      .where(eq(emailSends.id, seeded.emailSendId));
    const [ep] = await db
      .select({ contactId: emailPreferences.contactId })
      .from(emailPreferences)
      .where(eq(emailPreferences.id, seeded.emailPreferenceId));

    expect(ev?.contactId).toBe(contactId);
    expect(js?.contactId).toBe(contactId);
    expect(bm?.contactId).toBe(contactId);
    expect(es?.contactId).toBe(contactId);
    expect(ep?.contactId).toBe(contactId);
  });

  it("the contact's whole fan-in is intact and still one-per-table", async () => {
    const counts = await countsFor(contactId);
    for (const t of HISTORY) {
      expect(counts[t.name], t.name).toBe(1);
    }
  });
});

// ===========================================================================
// Case 3 — a loser with nothing to give leaves the survivor's counts alone
// ===========================================================================

describe("Case 3 — an empty loser side is a no-op, not a reverse re-point", () => {
  let survivorId: string;
  let loserId: string;
  let before: Counts;
  let after: Counts;
  let loserAfter: Counts;
  let loserEventsBefore: number;

  beforeAll(async () => {
    const extC = uid("c3-a-ext");
    const emailD = mail("c3-b");

    const s = await resolveOrCreateContact({ db, userId: extC });
    track(s.id);
    const l = await resolveOrCreateContact({ db, email: emailD });
    track(l.id);

    // Survivor owns a row in ALL five tables; the loser owns rows in
    // user_events ONLY — so the other four tables see an UPDATE that matches
    // nothing. A reversed UPDATE (`set contact_id = loser where contact_id =
    // survivor`) would empty the survivor here.
    await seedHistoryRow({ contactId: s.id, userKey: extC, slot: "c3s" });
    await db.insert(userEvents).values([
      { userId: l.id, event: `${RUN}.c3.loser.1`, contactId: l.id },
      { userId: l.id, event: `${RUN}.c3.loser.2`, contactId: l.id },
    ]);

    before = await countsFor(s.id);
    loserEventsBefore = (await countsFor(l.id)).user_events;

    const merged = await resolveOrCreateContact({
      db,
      userId: extC,
      email: emailD,
    });
    expect(merged.merged).toBe(true);
    expect(merged.id).toBe(s.id);
    survivorId = s.id;
    loserId = l.id;

    after = await countsFor(s.id);
    loserAfter = await countsFor(l.id);
  });

  it("the loser really did own only user_events rows", () => {
    expect(loserEventsBefore).toBe(2);
    expect(survivorId).not.toBe(loserId);
  });

  it("user_events: the loser's rows moved to the survivor", () => {
    expect(after.user_events).toBe(before.user_events + loserEventsBefore);
    expect(loserAfter.user_events).toBe(0);
  });

  for (const name of [
    "journey_states",
    "bucket_memberships",
    "email_sends",
    "email_preferences",
  ] as const) {
    it(`${name}: the survivor's count is untouched by an empty loser`, () => {
      expect(before[name]).toBe(1);
      expect(after[name]).toBe(before[name]);
      expect(loserAfter[name]).toBe(0);
    });
  }
});
