import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

// Same real test DB every other DB-backed suite reads.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contactAliases, contacts, crmLinks, importJobs, POSTHOG_PERSON_LINK } =
  await import("@hogsend/db");
const { and, eq, inArray, isNull, or } = await import("drizzle-orm");
const {
  createHogsendClient,
  lookupPostHogPerson,
  resolveOrCreateContact,
  resolvePostHogPerson,
} = await import("@hogsend/engine");

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

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const { db } = container;

const RUN = `phmap-${Date.now()}`;
const contactIds: string[] = [];
const jobIds: string[] = [];

/**
 * Postgres error codes arrive wrapped by drizzle — the driver error is the
 * `cause` of the thrown error, so the code has to be walked, not read off the
 * top-level object (`reference_drizzle-partial-index-onconflict`).
 */
function pgErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur; depth += 1) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

async function makeContact(suffix: string): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({ externalId: `${RUN}-${suffix}` })
    .returning({ id: contacts.id });
  if (!row) throw new Error("contact insert returned no row");
  contactIds.push(row.id);
  return row.id;
}

/** `makeContact` for a row that needs specific columns (a key, a soft-delete). */
async function insertContact(
  values: typeof contacts.$inferInsert,
): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values(values)
    .returning({ id: contacts.id });
  if (!row) throw new Error("contact insert returned no row");
  contactIds.push(row.id);
  return row.id;
}

afterAll(async () => {
  if (contactIds.length > 0) {
    await db.delete(crmLinks).where(inArray(crmLinks.contactId, contactIds));
    await db.delete(contacts).where(inArray(contacts.id, contactIds));
  }
  if (jobIds.length > 0) {
    await db.delete(importJobs).where(inArray(importJobs.id, jobIds));
  }
  await container.dbClient.end();
});

describe("PostHog person id as a mapped alias", () => {
  it("names the (provider, kind) pair the mapping is keyed on", () => {
    expect(POSTHOG_PERSON_LINK).toEqual({
      provider: "posthog",
      kind: "person",
    });
  });

  it("persists person_id → contact keyed on (provider, kind, external_id)", async () => {
    const contactId = await makeContact("a");
    const personId = `${RUN}-person-a`;

    await db
      .insert(crmLinks)
      .values({ ...POSTHOG_PERSON_LINK, externalId: personId, contactId });

    const rows = await db
      .select()
      .from(crmLinks)
      .where(
        and(
          eq(crmLinks.provider, POSTHOG_PERSON_LINK.provider),
          eq(crmLinks.kind, POSTHOG_PERSON_LINK.kind),
          eq(crmLinks.externalId, personId),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBe(contactId);
  });

  it("repairs a stale mapping through the unique arbiter, never duplicating", async () => {
    const first = await makeContact("b1");
    const second = await makeContact("b2");
    const personId = `${RUN}-person-b`;

    await db.insert(crmLinks).values({
      ...POSTHOG_PERSON_LINK,
      externalId: personId,
      contactId: first,
    });

    // AC 4's repair leg: a mapping pointing at a contact that was merged away
    // is re-pointed on the (provider, kind, external_id) arbiter.
    await db
      .insert(crmLinks)
      .values({
        ...POSTHOG_PERSON_LINK,
        externalId: personId,
        contactId: second,
      })
      .onConflictDoUpdate({
        target: [crmLinks.provider, crmLinks.kind, crmLinks.externalId],
        set: { contactId: second },
      });

    const rows = await db
      .select()
      .from(crmLinks)
      .where(eq(crmLinks.externalId, personId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBe(second);

    // Same key without the arbiter is a hard 23505, walked off `cause`.
    const dup = db.insert(crmLinks).values({
      ...POSTHOG_PERSON_LINK,
      externalId: personId,
      contactId: first,
    });
    await expect(dup).rejects.toSatisfy(
      (err: unknown) => pgErrorCode(err) === "23505",
    );
  });

  it("stays invisible to CRM reads, which key on kind 'contact'/'deal'", async () => {
    const contactId = await makeContact("c");
    const sharedId = `${RUN}-shared-id`;

    // A PostHog person and a CRM contact can carry the SAME external id
    // string — the unique index spans (provider, kind, external_id), and the
    // `person` kind keeps the analytics row out of every CRM lookup.
    await db.insert(crmLinks).values([
      { ...POSTHOG_PERSON_LINK, externalId: sharedId, contactId },
      {
        provider: "hubspot",
        kind: "contact",
        externalId: sharedId,
        contactId,
      },
    ]);

    const crmRows = await db
      .select()
      .from(crmLinks)
      .where(
        and(eq(crmLinks.externalId, sharedId), eq(crmLinks.kind, "contact")),
      );
    expect(crmRows).toHaveLength(1);
    expect(crmRows[0]?.provider).toBe("hubspot");

    const allRows = await db
      .select()
      .from(crmLinks)
      .where(eq(crmLinks.externalId, sharedId));
    expect(allRows).toHaveLength(2);
  });

  it("carries the mapping to the survivor when two contacts merge", async () => {
    const externalId = `${RUN}-merge-ext`;
    const email = `${RUN}-merge@example.com`;

    const byExternal = await resolveOrCreateContact({ db, userId: externalId });
    const byEmail = await resolveOrCreateContact({ db, email });
    contactIds.push(byExternal.id, byEmail.id);
    expect(byExternal.id).not.toBe(byEmail.id);

    await db.insert(crmLinks).values([
      {
        ...POSTHOG_PERSON_LINK,
        externalId: `${RUN}-person-m1`,
        contactId: byExternal.id,
      },
      {
        ...POSTHOG_PERSON_LINK,
        externalId: `${RUN}-person-m2`,
        contactId: byEmail.id,
      },
    ]);

    // Both keys in one call ⇒ collide-MERGE.
    const survivor = await resolveOrCreateContact({
      db,
      userId: externalId,
      email,
    });
    contactIds.push(survivor.id);

    const rows = await db
      .select()
      .from(crmLinks)
      .where(
        inArray(crmLinks.externalId, [`${RUN}-person-m1`, `${RUN}-person-m2`]),
      );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.contactId).toBe(survivor.id);
    }
  });
});

describe("import_jobs resumable cursor/metadata", () => {
  it("round-trips a cursor bag and defaults to null", async () => {
    const [bare] = await db
      .insert(importJobs)
      .values({ format: "posthog-cohort" })
      .returning({ id: importJobs.id, metadata: importJobs.metadata });
    if (!bare) throw new Error("import job insert returned no row");
    jobIds.push(bare.id);
    expect(bare.metadata).toBeNull();

    const [withCursor] = await db
      .insert(importJobs)
      .values({
        format: "posthog-cohort",
        metadata: {
          cursor: "https://eu.posthog.com/api/next?offset=200",
          cohortId: 4321,
          lastCalculation: "2026-07-27T09:00:00.000Z",
          consecutiveFailures: 2,
          degraded: true,
        },
      })
      .returning({ id: importJobs.id });
    if (!withCursor) throw new Error("import job insert returned no row");
    jobIds.push(withCursor.id);

    const [read] = await db
      .select()
      .from(importJobs)
      .where(eq(importJobs.id, withCursor.id));
    expect(read?.metadata).toEqual({
      cursor: "https://eu.posthog.com/api/next?offset=200",
      cohortId: 4321,
      lastCalculation: "2026-07-27T09:00:00.000Z",
      consecutiveFailures: 2,
      degraded: true,
    });
  });
});

describe("lookupPostHogPerson (find-only)", () => {
  it("returns { found: null } and creates NOTHING for an unknown person", async () => {
    const personId = `${RUN}-lk-unknown-p`;
    const distinctIds = [`${RUN}-lk-unknown-d1`, `${RUN}-lk-unknown-d2`];
    const email = `${RUN}-lk-unknown@example.com`;

    const result = await lookupPostHogPerson({
      db,
      personId,
      distinctIds,
      email,
    });
    expect(result).toEqual({ found: null });

    // AC 5's mutation guard: routing this through `resolveOrCreateContact`
    // materialises BOTH of the rows below (a zero-candidate call falls through
    // to an unconditional insert), so a swap to the creating path fails here.
    const minted = await db
      .select()
      .from(contacts)
      .where(
        or(
          inArray(contacts.externalId, distinctIds),
          inArray(contacts.anonymousId, distinctIds),
          eq(contacts.email, email),
        ),
      );
    expect(minted).toEqual([]);

    const mapped = await db
      .select()
      .from(crmLinks)
      .where(eq(crmLinks.externalId, personId));
    expect(mapped).toEqual([]);
  });

  it("resolves the same contact whatever order the distinct_ids arrive in", async () => {
    // The contact is keyed on the LAST id lexicographically, so anything that
    // reads `distinctIds[0]` — or trusts arrival order — misses it.
    const last = `${RUN}-lk-ord-c`;
    const ids = [`${RUN}-lk-ord-a`, `${RUN}-lk-ord-b`, last];
    const contactId = await insertContact({ externalId: last });

    const forward = await lookupPostHogPerson({
      db,
      personId: `${RUN}-lk-ord-p1`,
      distinctIds: ids,
    });
    const reversed = await lookupPostHogPerson({
      db,
      personId: `${RUN}-lk-ord-p2`,
      distinctIds: [...ids].reverse(),
    });

    expect(forward.found?.id).toBe(contactId);
    expect(reversed.found?.id).toBe(contactId);
  });

  it("persists the mapping on a hit, then replays it without value resolution", async () => {
    const personId = `${RUN}-lk-map-p`;
    const distinctIds = [`${RUN}-lk-map-d`];
    const contactId = await insertContact({ externalId: distinctIds[0] });

    const first = await lookupPostHogPerson({ db, personId, distinctIds });
    expect(first.found?.id).toBe(contactId);

    const rows = await db
      .select()
      .from(crmLinks)
      .where(eq(crmLinks.externalId, personId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBe(contactId);

    // Break every value key. Only the mapping can answer the second call.
    await db
      .update(contacts)
      .set({ externalId: `${RUN}-lk-map-moved` })
      .where(eq(contacts.id, contactId));

    const second = await lookupPostHogPerson({ db, personId, distinctIds });
    expect(second.found?.id).toBe(contactId);
  });

  it("re-resolves and repairs a mapping whose contact was merged away", async () => {
    const personId = `${RUN}-lk-stale-p`;
    const distinctIds = [`${RUN}-lk-stale-d`];
    const dead = await insertContact({
      externalId: `${RUN}-lk-stale-dead`,
      deletedAt: new Date(),
    });
    const live = await insertContact({ externalId: distinctIds[0] });
    await db.insert(crmLinks).values({
      ...POSTHOG_PERSON_LINK,
      externalId: personId,
      contactId: dead,
    });

    const result = await lookupPostHogPerson({ db, personId, distinctIds });
    // A mapping miss means RE-RESOLVE, never "absent" — an "absent" here is
    // what removes a live membership downstream.
    expect(result.found?.id).toBe(live);

    const rows = await db
      .select()
      .from(crmLinks)
      .where(eq(crmLinks.externalId, personId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBe(live);
  });

  it("finds a contact through a merge alias left by an earlier merge", async () => {
    // The alias table is the ONLY route to the answer here. The survivor is
    // identified AND already carries its own anonymous_id, so the loser's
    // anonymous_id is never folded onto it — after the merge soft-deletes the
    // loser, `staleAnon` exists nowhere but `contact_aliases`.
    const externalId = `${RUN}-lk-alias-ext`;
    const survivorAnon = `${RUN}-lk-alias-anon-live`;
    const staleAnon = `${RUN}-lk-alias-anon-stale`;

    const identified = await insertContact({
      externalId,
      anonymousId: survivorAnon,
    });
    const anonOnly = await insertContact({ anonymousId: staleAnon });

    // Both keys in one call ⇒ collide-MERGE; identified beats anonymous.
    const survivor = await resolveOrCreateContact({
      db,
      userId: externalId,
      anonymousId: staleAnon,
    });
    contactIds.push(survivor.id);
    expect(survivor.id).toBe(identified);

    // Pin the setup: the loser is gone from every live-row probe, and the
    // survivor kept its own anonymous_id rather than absorbing the loser's.
    const live = await db
      .select()
      .from(contacts)
      .where(
        and(eq(contacts.anonymousId, staleAnon), isNull(contacts.deletedAt)),
      );
    expect(live).toEqual([]);
    const [loser] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, anonOnly));
    expect(loser?.deletedAt).not.toBeNull();
    const aliasRows = await db
      .select()
      .from(contactAliases)
      .where(eq(contactAliases.aliasValue, staleAnon));
    expect(aliasRows).toHaveLength(1);
    expect(aliasRows[0]?.contactId).toBe(survivor.id);

    // A PostHog person still lists the stale distinct_id. It must resolve to
    // the SURVIVOR, not read as unknown — an unknown here drops a live
    // membership downstream.
    const result = await lookupPostHogPerson({
      db,
      personId: `${RUN}-lk-alias-p`,
      distinctIds: [staleAnon],
    });
    expect(result.found?.id).toBe(survivor.id);
  });

  it("resolves an anonymous-keyed contact by its distinct_id", async () => {
    // A pre-identify PostHog distinct_id lands on `anonymous_id`, never
    // `external_id`. Probing only `external_id` makes every anonymous cohort
    // member invisible.
    const anonymousId = `${RUN}-lk-anon-d`;
    const contactId = await insertContact({ anonymousId });

    const result = await lookupPostHogPerson({
      db,
      personId: `${RUN}-lk-anon-p`,
      distinctIds: [anonymousId],
    });
    expect(result.found?.id).toBe(contactId);
  });

  it("resolves a contact whose canonical key IS its row id", async () => {
    // An email-only contact has no external_id and no anonymous_id, so its
    // canonical key — the one that circulates as a distinct_id — is its uuid.
    const email = `${RUN}-lk-uuid@example.com`;
    const contactId = await insertContact({ email });

    // Deliberately no `email` on the call: the uuid probe is the only route.
    const result = await lookupPostHogPerson({
      db,
      personId: `${RUN}-lk-uuid-p`,
      distinctIds: [contactId],
    });
    expect(result.found?.id).toBe(contactId);
  });

  it("never resolves to a soft-deleted contact", async () => {
    // A merged-away row still holds its old keys until the alias table takes
    // over. Reading it back as the answer would resurrect a dead contact and
    // re-point the person mapping at it.
    const distinctId = `${RUN}-lk-dead-d`;
    const dead = await insertContact({
      externalId: distinctId,
      deletedAt: new Date(),
    });

    const result = await lookupPostHogPerson({
      db,
      personId: `${RUN}-lk-dead-p`,
      distinctIds: [distinctId],
    });
    expect(result).toEqual({ found: null });

    // And no mapping was minted onto the dead row.
    const rows = await db
      .select()
      .from(crmLinks)
      .where(eq(crmLinks.contactId, dead));
    expect(rows).toEqual([]);
  });

  it("is a no-op, not a throw, when nothing identifies the person", async () => {
    await expect(lookupPostHogPerson({ db, personId: null })).resolves.toEqual({
      found: null,
    });
  });
});

// ===========================================================================
// The SURVIVOR RULE, one leg per test.
//
// A PostHog person listing [a, b] where live contact-1 holds external_id=a and
// live contact-2 holds anonymous_id=b hands `findByValue` TWO candidates, and
// `pickCanonical` decides which one the person maps to. Its ordering is
// deliberately byte-identical to the resolver's `pickSurvivor`
// (`packages/engine/src/lib/contacts.ts`) — if the two ever disagree, a lookup
// resolves to one row while a later merge keeps the other, and the person
// mapping silently points at a merged-away contact.
//
// `pickCanonical` is module-private, so each leg is pinned through
// `lookupPostHogPerson`. Every test below fixes the OTHER two legs to favour
// the LOSER, so the assertion can only pass because the leg under test decided
// it — inverting that one comparator flips the answer.
// ===========================================================================
describe("pickCanonical SURVIVOR RULE (matches pickSurvivor)", () => {
  /**
   * Two uuids sharing all but their last character, so `a.id < b.id` (the
   * final tie-break's plain string compare) is known ahead of the insert
   * instead of left to `defaultRandom()`.
   */
  function orderedIdPair(): { low: string; high: string } {
    const base = randomUUID().slice(0, -1);
    return { low: `${base}0`, high: `${base}1` };
  }

  const OLD = new Date("2020-01-01T00:00:00.000Z");
  const NEW = new Date("2024-01-01T00:00:00.000Z");

  it("prefers the IDENTIFIED row over the anonymous one", async () => {
    const { low, high } = orderedIdPair();
    const anonKey = `${RUN}-rule-ident-anon`;
    const extKey = `${RUN}-rule-ident-ext`;

    // The anonymous row wins the other two legs outright — older firstSeenAt
    // AND the lower id — so only the identified/anonymous leg can hand the
    // answer to the external_id row.
    const anonymous = await insertContact({
      id: low,
      anonymousId: anonKey,
      firstSeenAt: OLD,
    });
    const identified = await insertContact({
      id: high,
      externalId: extKey,
      firstSeenAt: NEW,
    });

    const result = await lookupPostHogPerson({
      db,
      distinctIds: [anonKey, extKey],
    });
    expect(result.found?.id).toBe(identified);
    expect(result.found?.id).not.toBe(anonymous);
  });

  it("prefers the OLDEST firstSeenAt when both rows are identified", async () => {
    const { low, high } = orderedIdPair();
    const oldKey = `${RUN}-rule-seen-old`;
    const newKey = `${RUN}-rule-seen-new`;

    // Both identified ⇒ the first leg ties. The NEWER row also holds the lower
    // id, so the final tie-break points the other way: only the firstSeenAt
    // leg can pick the older row.
    const older = await insertContact({
      id: high,
      externalId: oldKey,
      firstSeenAt: OLD,
    });
    const newer = await insertContact({
      id: low,
      externalId: newKey,
      firstSeenAt: NEW,
    });

    const result = await lookupPostHogPerson({
      db,
      distinctIds: [oldKey, newKey],
    });
    expect(result.found?.id).toBe(older);
    expect(result.found?.id).not.toBe(newer);
  });

  it("falls back to the LOWEST id when identity and firstSeenAt tie", async () => {
    const { low, high } = orderedIdPair();
    const lowKey = `${RUN}-rule-id-low`;
    const highKey = `${RUN}-rule-id-high`;
    // Identical to the microsecond, so the first two legs both tie and the
    // answer is the tie-break's alone. Without it the winner would be whatever
    // order the two SELECTs happened to return.
    const sameInstant = new Date("2022-06-01T12:00:00.000Z");

    const lower = await insertContact({
      id: low,
      externalId: lowKey,
      firstSeenAt: sameInstant,
    });
    const higher = await insertContact({
      id: high,
      externalId: highKey,
      firstSeenAt: sameInstant,
    });

    const result = await lookupPostHogPerson({
      db,
      distinctIds: [lowKey, highKey],
    });
    expect(result.found?.id).toBe(lower);
    expect(result.found?.id).not.toBe(higher);
  });

  it("is stable whatever order the two candidates arrive in", async () => {
    // Insert order is the one input the rule must NOT read: PostHog reshuffles
    // distinct_ids between polls, and `findByValue` merges two unordered
    // SELECTs into a Map. Same pair, opposite insert order ⇒ same winner.
    const { low, high } = orderedIdPair();
    const anonKey = `${RUN}-rule-order-anon`;
    const extKey = `${RUN}-rule-order-ext`;

    const identified = await insertContact({
      id: high,
      externalId: extKey,
      firstSeenAt: NEW,
    });
    await insertContact({ id: low, anonymousId: anonKey, firstSeenAt: OLD });

    const forward = await lookupPostHogPerson({
      db,
      distinctIds: [anonKey, extKey],
    });
    const reversed = await lookupPostHogPerson({
      db,
      distinctIds: [extKey, anonKey],
    });
    expect(forward.found?.id).toBe(identified);
    expect(reversed.found?.id).toBe(identified);
  });
});

describe("resolvePostHogPerson (creating)", () => {
  it("creates through resolveOrCreateContact with a source, then maps it", async () => {
    const personId = `${RUN}-res-new-p`;
    const distinctIds = [`${RUN}-res-new-d`];
    const email = `${RUN}-res-new@example.com`;

    const first = await resolvePostHogPerson({
      db,
      personId,
      distinctIds,
      email,
      source: "posthog-cohort",
    });
    expect(first.created).toBe(true);
    const contact = first.contact;
    if (!contact) throw new Error("expected a contact");
    contactIds.push(contact.id);
    expect(contact.externalId).toBe(distinctIds[0]);
    expect(contact.email).toBe(email);
    expect(contact.source).toBe("posthog-cohort");

    // AC 2: the same person id resolves again to the same contact, one mapping.
    const second = await resolvePostHogPerson({
      db,
      personId,
      distinctIds,
      email,
      source: "posthog-cohort",
    });
    expect(second.created).toBe(false);
    expect(second.contact?.id).toBe(contact.id);

    const rows = await db
      .select()
      .from(crmLinks)
      .where(eq(crmLinks.externalId, personId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBe(contact.id);
  });

  it("keys a created contact on the lexicographically first distinct_id", async () => {
    // AC 3's create leg: PostHog promises no distinct_id order and changes it
    // between polls. Normalizing to a SORTED set is what stops two polls of the
    // same person from minting two contacts keyed on two different ids.
    const arrival = [
      `${RUN}-res-sort-c`,
      `${RUN}-res-sort-a`,
      `${RUN}-res-sort-b`,
    ];

    const created = await resolvePostHogPerson({
      db,
      personId: `${RUN}-res-sort-p`,
      distinctIds: arrival,
      source: "posthog-cohort",
    });
    expect(created.created).toBe(true);
    const contact = created.contact;
    if (!contact) throw new Error("expected a contact");
    contactIds.push(contact.id);
    // NOT `arrival[0]` — the sorted set's first element.
    expect(contact.externalId).toBe(`${RUN}-res-sort-a`);
  });

  it("attaches to an existing contact keyed on a NON-first distinct_id", async () => {
    const first = `${RUN}-res-ord-a`;
    const middle = `${RUN}-res-ord-b`;
    const last = `${RUN}-res-ord-c`;
    const ids = [first, middle, last];
    const contactId = await insertContact({ externalId: last });

    const forward = await resolvePostHogPerson({
      db,
      personId: `${RUN}-res-ord-p1`,
      distinctIds: ids,
      source: "posthog-cohort",
    });
    const reversed = await resolvePostHogPerson({
      db,
      personId: `${RUN}-res-ord-p2`,
      distinctIds: [...ids].reverse(),
      source: "posthog-cohort",
    });

    expect(forward.created).toBe(false);
    expect(forward.contact?.id).toBe(contactId);
    expect(reversed.created).toBe(false);
    expect(reversed.contact?.id).toBe(contactId);

    // No phantom twin keyed on whichever id happened to sort first.
    const twins = await db
      .select()
      .from(contacts)
      .where(inArray(contacts.externalId, [first, middle]));
    expect(twins).toEqual([]);
  });

  it("is a no-op, not a throw, when nothing identifies the person", async () => {
    await expect(
      resolvePostHogPerson({ db, personId: null, source: "posthog-cohort" }),
    ).resolves.toEqual({ contact: null, created: false });
  });
});
