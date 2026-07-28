import { afterAll, describe, expect, it, vi } from "vitest";

// Same real test DB the engine singletons + the route container read.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Hatchet via the override seam — nothing here pushes, but the container needs
// a handle and a live engine must never be reached from a unit suite.
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
} as unknown as ReturnType<typeof createHogsendClient>["hatchet"];

const {
  bucketMemberships,
  contactAliases,
  contacts,
  emailPreferences,
  emailSends,
  journeyStates,
  userEvents,
} = await import("@hogsend/db");
const { and, eq, inArray, isNull } = await import("drizzle-orm");
const { createHogsendClient, resolveContactNoCreate, resolveOrCreateContact } =
  await import("@hogsend/engine");

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const { db } = container;

const RUN = `nocreate-${Date.now()}`;

// ---- refusal case (unseen anon id) ----
const MISS_ANON = `${RUN}-miss-anon`;

// ---- D8 precondition cases ----
const D8_EMAIL = `${RUN}-d8@example.com`;
const D8_DISCORD = `${RUN}-d8-discord`;

// ---- fill-in-link case ----
const LINK_ANON = `${RUN}-link-anon`;
const LINK_USER = `${RUN}-link-user`;

// ---- collide-MERGE case ----
const MERGE_USER = `${RUN}-merge-user`;
const MERGE_ANON = `${RUN}-merge-anon`;

// ---- resolveOrCreateContact still-creates control ----
const CTRL_ANON = `${RUN}-ctrl-anon`;

// ---- T2 history-adoption case ----
const T2_ANON = `${RUN}-t2-anon`;
const T2_USER = `${RUN}-t2-user`;
const T2_EMAIL = `${RUN}-t2@example.com`;
const T2_JOURNEY = `${RUN}-t2-journey`;
const T2_BUCKET = `${RUN}-t2-bucket`;

// ---- T3 fill-in-link history-adoption case (the docs sign-in sequence) ----
const T3_ANON = `${RUN}-t3-anon`;
const T3_USER = `${RUN}-t3-user`;
const T3_EMAIL = `${RUN}-t3@example.com`;
const T3_JOURNEY = `${RUN}-t3-journey`;

const createdContactIds: string[] = [];

/** Live (non-soft-deleted) contacts owning any of the given anon/external keys. */
async function liveContactsForKeys(keys: string[]) {
  return db
    .select()
    .from(contacts)
    .where(
      and(inArray(contacts.anonymousId, keys), isNull(contacts.deletedAt)),
    );
}

async function countContactsByAnon(anonymousId: string): Promise<number> {
  const rows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.anonymousId, anonymousId));
  return rows.length;
}

afterAll(async () => {
  const keys = [
    MISS_ANON,
    LINK_ANON,
    LINK_USER,
    MERGE_USER,
    MERGE_ANON,
    CTRL_ANON,
    T2_ANON,
    T2_USER,
    T3_ANON,
    T3_USER,
    ...createdContactIds,
  ];
  await db.delete(userEvents).where(inArray(userEvents.userId, keys));
  await db.delete(journeyStates).where(inArray(journeyStates.userId, keys));
  await db.delete(emailSends).where(inArray(emailSends.userId, keys));
  await db
    .delete(bucketMemberships)
    .where(inArray(bucketMemberships.userId, keys));
  await db
    .delete(emailPreferences)
    .where(inArray(emailPreferences.userId, keys));
  if (createdContactIds.length > 0) {
    await db
      .delete(contactAliases)
      .where(inArray(contactAliases.contactId, createdContactIds));
    await db.delete(contacts).where(inArray(contacts.id, createdContactIds));
  }
});

// ===========================================================================
// T1 — `resolveContactNoCreate`: the refusal arm, the D8 precondition, and the
// two non-create arms (fill-in-link / collide-MERGE) which must behave exactly
// as `resolveOrCreateContact` does.
// ===========================================================================
describe("resolveContactNoCreate", () => {
  it("refuses an unseen anonymousId: id null, no contacts row (D1)", async () => {
    const before = await countContactsByAnon(MISS_ANON);
    expect(before).toBe(0);

    const r = await resolveContactNoCreate({ db, anonymousId: MISS_ANON });

    expect(r.id).toBeNull();
    // The refusal key IS the key the create arm would have made canonical
    // (`external_id ?? anonymous_id ?? id`) for this permitted shape.
    expect(r.resolvedKey).toBe(MISS_ANON);
    expect(r.created).toBe(false);
    expect(r.linked).toBe(false);
    expect(r.merged).toBe(false);
    // The load-bearing assertion: ZERO rows, not merely a null return value.
    expect(await countContactsByAnon(MISS_ANON)).toBe(0);
  });

  it("throws when the highest-precedence supplied key is email (D8)", async () => {
    await expect(
      resolveContactNoCreate({ db, email: D8_EMAIL }),
    ).rejects.toThrow(/userId or anonymousId/);
    // And the misuse minted nothing on its way out.
    const rows = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.email, D8_EMAIL));
    expect(rows).toHaveLength(0);
  });

  it("throws when the highest-precedence supplied key is discordId (D8)", async () => {
    await expect(
      resolveContactNoCreate({ db, discordId: D8_DISCORD }),
    ).rejects.toThrow(/userId or anonymousId/);
    const rows = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.discordId, D8_DISCORD));
    expect(rows).toHaveLength(0);
  });

  it("accepts email alongside a higher-precedence userId (D8 permits it)", async () => {
    // email is supplied, but `userId` outranks it in `external_id ??
    // anonymous_id ?? id`, so the refusal key is stable and the call is legal.
    const r = await resolveContactNoCreate({
      db,
      userId: `${RUN}-mixed-user`,
      email: `${RUN}-mixed@example.com`,
    });
    expect(r.id).toBeNull();
    expect(r.resolvedKey).toBe(`${RUN}-mixed-user`);
  });

  it("fill-in-links a single existing contact exactly as the creating sibling does", async () => {
    const seeded = await resolveOrCreateContact({ db, anonymousId: LINK_ANON });
    createdContactIds.push(seeded.id);
    expect(seeded.created).toBe(true);

    const r = await resolveContactNoCreate({
      db,
      userId: LINK_USER,
      anonymousId: LINK_ANON,
    });

    expect(r.id).toBe(seeded.id);
    expect(r.created).toBe(false);
    expect(r.linked).toBe(true);
    expect(r.merged).toBe(false);
    // The canonical key flipped anon → external, so the old key is reported for
    // the analytics stitch.
    expect(r.resolvedKey).toBe(LINK_USER);
    expect(r.mergedKeys).toEqual([LINK_ANON]);

    const row = (
      await db.select().from(contacts).where(eq(contacts.id, seeded.id))
    )[0];
    expect(row?.externalId).toBe(LINK_USER);
    expect(row?.anonymousId).toBe(LINK_ANON);
  });

  it("collide-MERGEs two existing contacts exactly as the creating sibling does", async () => {
    const identified = await resolveOrCreateContact({
      db,
      userId: MERGE_USER,
    });
    createdContactIds.push(identified.id);
    const anon = await resolveOrCreateContact({ db, anonymousId: MERGE_ANON });
    createdContactIds.push(anon.id);
    expect(identified.id).not.toBe(anon.id);

    const r = await resolveContactNoCreate({
      db,
      userId: MERGE_USER,
      anonymousId: MERGE_ANON,
    });

    expect(r.id).toBe(identified.id);
    expect(r.created).toBe(false);
    expect(r.merged).toBe(true);
    expect(r.resolvedKey).toBe(MERGE_USER);
    expect(r.mergedKeys).toEqual([MERGE_ANON]);

    // Exactly one live row survives the fold.
    const live = await liveContactsForKeys([MERGE_ANON]);
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(identified.id);
  });

  it("leaves resolveOrCreateContact creating on a miss (unchanged behavior)", async () => {
    const r = await resolveOrCreateContact({ db, anonymousId: CTRL_ANON });
    createdContactIds.push(r.id);
    expect(r.created).toBe(true);
    // `id` is a plain `string` here — the exported type must NOT have widened.
    expect(typeof r.id).toBe("string");
    expect(r.resolvedKey).toBe(CTRL_ANON);
    expect(await countContactsByAnon(CTRL_ANON)).toBe(1);
  });
});

// ===========================================================================
// T2 — history adoption on the CREATE arm (D2). With the anon ROW refused, a
// later identify takes the create arm, which historically had no repoint: every
// row keyed on the anon id would be orphaned. The create arm must now adopt it.
// ===========================================================================
describe("create-arm history adoption", () => {
  it("repoints anon-keyed history onto the new canonical key and reports it in mergedKeys", async () => {
    // (1) The contactless observation: refused, so NO contact row exists for A.
    const refused = await resolveContactNoCreate({ db, anonymousId: T2_ANON });
    expect(refused.id).toBeNull();

    // (2) The history that observation leaves behind, keyed on A across all
    // five string-keyed tables `repointOwnHistory` covers.
    await db
      .insert(userEvents)
      .values({ userId: T2_ANON, event: "demo.viewed" });
    await db.insert(journeyStates).values({
      userId: T2_ANON,
      userEmail: T2_EMAIL,
      journeyId: T2_JOURNEY,
      currentNodeId: "start",
      status: "active",
    });
    await db.insert(bucketMemberships).values({
      userId: T2_ANON,
      bucketId: T2_BUCKET,
      status: "active",
      source: "event",
    });
    await db.insert(emailSends).values({
      userId: T2_ANON,
      fromEmail: "from@hogsend.com",
      toEmail: T2_EMAIL,
      subject: "hello",
      status: "sent",
    });
    await db.insert(emailPreferences).values({
      userId: T2_ANON,
      email: T2_EMAIL,
      unsubscribedAll: true,
    });

    // (3) The identify: userId + the same anon id, with no row owning either —
    // the CREATE arm.
    const created = await resolveOrCreateContact({
      db,
      userId: T2_USER,
      anonymousId: T2_ANON,
    });
    createdContactIds.push(created.id);
    expect(created.created).toBe(true);
    expect(created.resolvedKey).toBe(T2_USER);
    // Without this, the DB history is adopted but the PostHog anon→known stitch
    // stays broken (ingestion fires `mergeAnalyticsIdentities` off mergedKeys).
    expect(created.mergedKeys).toEqual([T2_ANON]);

    // (4) ZERO residual rows under A; every one of them now sits under U.
    const eventsA = await db
      .select({ id: userEvents.id })
      .from(userEvents)
      .where(eq(userEvents.userId, T2_ANON));
    expect(eventsA).toHaveLength(0);
    const eventsU = await db
      .select({ id: userEvents.id })
      .from(userEvents)
      .where(eq(userEvents.userId, T2_USER));
    expect(eventsU).toHaveLength(1);

    const statesA = await db
      .select({ id: journeyStates.id })
      .from(journeyStates)
      .where(eq(journeyStates.userId, T2_ANON));
    expect(statesA).toHaveLength(0);
    const statesU = await db
      .select({ id: journeyStates.id })
      .from(journeyStates)
      .where(eq(journeyStates.userId, T2_USER));
    expect(statesU).toHaveLength(1);

    const membershipsA = await db
      .select({ id: bucketMemberships.id })
      .from(bucketMemberships)
      .where(eq(bucketMemberships.userId, T2_ANON));
    expect(membershipsA).toHaveLength(0);
    const membershipsU = await db
      .select({ id: bucketMemberships.id })
      .from(bucketMemberships)
      .where(eq(bucketMemberships.userId, T2_USER));
    expect(membershipsU).toHaveLength(1);

    const sendsA = await db
      .select({ id: emailSends.id })
      .from(emailSends)
      .where(eq(emailSends.userId, T2_ANON));
    expect(sendsA).toHaveLength(0);
    const sendsU = await db
      .select({ id: emailSends.id })
      .from(emailSends)
      .where(eq(emailSends.userId, T2_USER));
    expect(sendsU).toHaveLength(1);

    const prefsA = await db
      .select({ id: emailPreferences.id })
      .from(emailPreferences)
      .where(eq(emailPreferences.userId, T2_ANON));
    expect(prefsA).toHaveLength(0);
    const prefsU = await db
      .select()
      .from(emailPreferences)
      .where(eq(emailPreferences.userId, T2_USER));
    expect(prefsU).toHaveLength(1);
    // The suppression the anon key carried must survive the adoption.
    expect(prefsU[0]?.unsubscribedAll).toBe(true);

    // Exactly one contact, canonical key = U.
    const live = await liveContactsForKeys([T2_ANON]);
    expect(live).toHaveLength(1);
    expect(live[0]?.externalId).toBe(T2_USER);
  });

  it("does not repoint when the anon id IS the new canonical key", async () => {
    // An anon-only create: `contactKey` === the anon id, so there is nothing to
    // adopt and no phantom key-flip merge may be reported.
    const anon = `${RUN}-selfkey-anon`;
    const r = await resolveOrCreateContact({ db, anonymousId: anon });
    createdContactIds.push(r.id);
    expect(r.resolvedKey).toBe(anon);
    expect(r.mergedKeys).toBeUndefined();
  });
});

// ===========================================================================
// T3 — the FILL-IN-LINK arm must adopt orphaned anon history too.
//
// This is the docs sign-in sequence, and it reaches a different arm than T2.
// A visitor browses anonymously as A (refused — no row). They then sign in, and
// TWO writes land in this order:
//   1. the server-side fold (`/api/hogsend-token` → `foldContactIdentity`)
//      resolves { email, userId } with NO anon id → the CREATE arm, so the row
//      is born already carrying `external_id = U`;
//   2. the browser's `identify()` resolves { userId, anonymousId } → that row is
//      found by U, so this is FILL-IN-LINK, not the create arm.
//
// `fillInLink` only repointed when the canonical key FLIPPED, and attaching an
// anon id to a row that already has an `external_id` never flips it
// (`external_id ?? anonymous_id ?? id`). So the anon history stayed orphaned:
// the contact gained `anonymous_id = A` as an alias while every row keyed on the
// string A kept pointing at nothing. Before the refusal shipped, a row for A
// existed and the MERGE arm repointed it — refusal removed the row, and with it
// the only path that adopted the history.
// ===========================================================================
describe("fill-in-link history adoption", () => {
  it("adopts anon-keyed history when the anon id is attached WITHOUT a key flip", async () => {
    // (1) Contactless observation: refused, no row for A.
    const refused = await resolveContactNoCreate({ db, anonymousId: T3_ANON });
    expect(refused.id).toBeNull();

    // (2) The anonymous browsing history, keyed on A.
    await db
      .insert(userEvents)
      .values({ userId: T3_ANON, event: "demo.viewed" });
    await db.insert(journeyStates).values({
      userId: T3_ANON,
      userEmail: T3_EMAIL,
      journeyId: T3_JOURNEY,
      currentNodeId: "start",
      status: "active",
    });

    // (3) The SERVER fold: email + userId, no anon id → create arm. The row is
    // born with `external_id = U` already set, which is what defuses the flip.
    const folded = await resolveOrCreateContact({
      db,
      email: T3_EMAIL,
      userId: T3_USER,
    });
    createdContactIds.push(folded.id);
    expect(folded.created).toBe(true);
    expect(folded.resolvedKey).toBe(T3_USER);
    // It never saw A, so it cannot have adopted anything.
    expect(folded.mergedKeys).toBeUndefined();

    // (4) The BROWSER identify: same userId, plus the anon id. Resolves the row
    // by U → fill-in-link. The canonical key does NOT move.
    const linked = await resolveOrCreateContact({
      db,
      userId: T3_USER,
      anonymousId: T3_ANON,
    });
    expect(linked.id).toBe(folded.id);
    expect(linked.created).toBe(false);
    expect(linked.resolvedKey).toBe(T3_USER);
    // The adoption must still be REPORTED, or the PostHog anon→known stitch
    // never fires for anyone who signs in through the docs.
    expect(linked.mergedKeys).toEqual([T3_ANON]);

    // (5) The history must have followed the person onto their canonical key.
    const eventsA = await db
      .select({ id: userEvents.id })
      .from(userEvents)
      .where(eq(userEvents.userId, T3_ANON));
    expect(eventsA).toHaveLength(0);
    const eventsU = await db
      .select({ id: userEvents.id })
      .from(userEvents)
      .where(eq(userEvents.userId, T3_USER));
    expect(eventsU).toHaveLength(1);

    const statesA = await db
      .select({ id: journeyStates.id })
      .from(journeyStates)
      .where(eq(journeyStates.userId, T3_ANON));
    expect(statesA).toHaveLength(0);
    const statesU = await db
      .select({ id: journeyStates.id })
      .from(journeyStates)
      .where(eq(journeyStates.userId, T3_USER));
    expect(statesU).toHaveLength(1);

    // Still exactly one contact — adoption must not mint a second row.
    const live = await liveContactsForKeys([T3_ANON]);
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(folded.id);
    expect(live[0]?.externalId).toBe(T3_USER);
  });
});
