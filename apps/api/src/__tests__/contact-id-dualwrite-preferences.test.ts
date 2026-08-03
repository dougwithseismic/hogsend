/**
 * PRD 04 T4e — `email_preferences.contact_id` dual-write, plus the helper the
 * whole dual-write rests on (`lookupContactIdByKey`) and the D6 fault-injection
 * proof.
 *
 * Three shapes are covered:
 *
 *   1. FALLBACK — a caller with nothing in hand (the unsubscribe-token route)
 *      lets `upsertEmailPreference` do ONE D6-wrapped lookup.
 *   2. IN-HAND — the lists route passes the id `resolveOrCreateContact` just
 *      returned, so no second probe happens.
 *   3. FILL-IF-KNOWN, NEVER NULL-OUT — the conflict arm coalesces, so a later
 *      write whose resolve failed (or was explicitly null) cannot ERASE a
 *      `contact_id` an earlier write stamped.
 *
 * The helper tests cover the alias probe (a second-device anon id that lives
 * ONLY in `contact_aliases`) and its deliberate blind spot (an `email`-kind
 * alias is NOT a canonical key and must not resolve).
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

// DB-touching test. Point a worktree at its own stack with
// HOGSEND_TEST_DATABASE_URL — never by editing the default.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { hatchetMock } = vi.hoisted(() => {
  const factory = () => ({
    hatchet: {
      durableTask: vi.fn((config: Record<string, unknown>) => ({
        ...config,
        run: vi.fn(),
        runNoWait: vi.fn(),
        runAndWait: vi.fn(),
      })),
      task: vi.fn((config: Record<string, unknown>) => ({
        ...config,
        run: vi.fn(),
        runNoWait: vi.fn(),
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

// PARTIAL mock of the engine's contacts module — everything real except
// `lookupContactIdByKey`, which is the real implementation wrapped in a spy.
// Used ONLY to observe WHETHER the probe ran: the in-hand-id handoff (the lists
// route) is otherwise indistinguishable from a re-probe that happens to return
// the same id. The spy delegates, so no other test in this file changes.
const { lookupSpy, contactsMock } = vi.hoisted(() => {
  const lookupSpy = vi.fn();
  const contactsMock = async (
    importOriginal: () => Promise<Record<string, unknown>>,
  ) => {
    const actual = await importOriginal();
    lookupSpy.mockImplementation(
      actual.lookupContactIdByKey as (...a: unknown[]) => unknown,
    );
    return { ...actual, lookupContactIdByKey: lookupSpy };
  };
  return { lookupSpy, contactsMock };
});
vi.mock("../../../../packages/engine/src/lib/contacts.ts", contactsMock);
vi.mock("../../../../packages/engine/src/lib/contacts.js", contactsMock);

const { contactAliases, contacts, emailPreferences } = await import(
  "@hogsend/db"
);
const { and, eq, like, or } = await import("drizzle-orm");
const { createApp, createHogsendClient, resolveOrCreateContact } = await import(
  "@hogsend/engine"
);
const { generateUnsubscribeUrl } = await import("@hogsend/email");

// `upsertEmailPreference` and `lookupContactIdByKey` are engine-INTERNAL (not
// re-exported from @hogsend/engine), so they are loaded at runtime through Vite
// with a variable specifier — the impact-digest / provision-posthog-loop idiom.
// A literal cross-package import would pull engine files into this package's TS
// program and trip rootDir (TS6059) under `tsc --noEmit`.
const preferencesModulePath = new URL(
  "../../../../packages/engine/src/lib/preferences.ts",
  import.meta.url,
).pathname;
const { upsertEmailPreference } = (await import(
  /* @vite-ignore */ preferencesModulePath
)) as {
  upsertEmailPreference: (opts: {
    db: unknown;
    externalId: string;
    email: string;
    update: Record<string, unknown>;
    contactId?: string | null;
    emitOutbound?: boolean;
  }) => Promise<void>;
};

const contactsModulePath = new URL(
  "../../../../packages/engine/src/lib/contacts.ts",
  import.meta.url,
).pathname;
const { lookupContactIdByKey } = (await import(
  /* @vite-ignore */ contactsModulePath
)) as {
  lookupContactIdByKey: (db: unknown, key: string) => Promise<string | null>;
};

const container = createHogsendClient();
const app = createApp(container);
const { db, env } = container;

const AUTH_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};

const RUN = `cipf-${randomUUID().slice(0, 8)}-${Date.now()}`;
const uid = (label: string) => `${RUN}-${label}`;
const mail = (label: string) => `${RUN}-${label}@example.com`;

const prefsFor = (userId: string) =>
  db.select().from(emailPreferences).where(eq(emailPreferences.userId, userId));

afterAll(async () => {
  await db
    .delete(emailPreferences)
    .where(
      or(
        like(emailPreferences.userId, `${RUN}-%`),
        like(emailPreferences.email, `${RUN}-%`),
      ),
    );
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

describe("T4e — the fallback lookup (unsubscribe route passes nothing)", () => {
  it("a real token unsubscribe stamps the owning contacts.id", async () => {
    const ext = uid("unsub");
    const email = mail("unsub");
    const contact = await resolveOrCreateContact({ db, userId: ext, email });

    // The REAL hosted unsubscribe surface: a signed token → GET → the route
    // calls `upsertEmailPreference` with no contactId, so the internal
    // D6-wrapped lookup is the only thing that can fill the column.
    const url = generateUnsubscribeUrl({
      baseUrl: "http://localhost:3002",
      secret: env.BETTER_AUTH_SECRET,
      externalId: ext,
      email,
    });
    lookupSpy.mockClear();
    const res = await app.request(url.replace("http://localhost:3002", ""));
    expect(res.status).toBe(200);

    const rows = await prefsFor(ext);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.unsubscribedAll).toBe(true);
    expect(rows[0]?.contactId).toBe(contact.id);
    // The probe REALLY ran on this path — which also proves the partial mock is
    // wired into the engine's own `./contacts.js` specifier, so the
    // "never probed" assertion in the lists-route test below is not vacuous.
    expect(lookupSpy).toHaveBeenCalled();
  });

  it("an unresolvable externalId writes the row with NULL", async () => {
    const ghost = uid("ghost");
    await upsertEmailPreference({
      db,
      externalId: ghost,
      email: mail("ghost"),
      update: { unsubscribedAll: true },
      emitOutbound: false,
    });

    const rows = await prefsFor(ghost);
    expect(rows).toHaveLength(1);
    // The preference itself is fully written — bookkeeping never degrades it.
    expect(rows[0]?.unsubscribedAll).toBe(true);
    expect(rows[0]?.contactId).toBeNull();
  });
});

describe("T4e — the in-hand id (lists route)", () => {
  it("POST /v1/lists/preferences stamps the contact it just resolved", async () => {
    const ext = uid("lists");
    const email = mail("lists");
    const contact = await resolveOrCreateContact({ db, userId: ext, email });

    lookupSpy.mockClear();
    const res = await app.request("/v1/lists/preferences", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({ userId: ext, unsubscribedAll: true }),
    });
    expect(res.status).toBe(200);

    const rows = await prefsFor(ext);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBe(contact.id);
    // The HANDOFF, not just the outcome: this handler already holds the id
    // `resolveOrCreateContact` returned, so `upsertEmailPreference` must NOT
    // re-probe. Without this the stamp alone is indistinguishable from a
    // redundant lookup that happened to return the same row.
    expect(lookupSpy).not.toHaveBeenCalled();
  });
});

describe("T4e — the admin preferences route (its own raw upsert)", () => {
  const putPrefs = (contactId: string, body: unknown) =>
    app.request(`/v1/admin/contacts/${contactId}/preferences`, {
      method: "PUT",
      headers: AUTH_HEADER,
      body: JSON.stringify(body),
    });

  it("a fresh insert stamps the contact the route resolved", async () => {
    const ext = uid("adminpref");
    const email = mail("adminpref");
    const contact = await resolveOrCreateContact({ db, userId: ext, email });

    const res = await putPrefs(contact.id, { unsubscribedAll: true });
    expect(res.status).toBe(200);

    const rows = await prefsFor(ext);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBe(contact.id);
  });

  it("the conflict arm FILLS a row this route finds stamped NULL", async () => {
    // This route writes `email_preferences` directly (it does not go through
    // `upsertEmailPreference`), so its own conflict arm needs the same
    // fill-if-known coalesce or a pre-existing NULL row would stay NULL forever.
    const ext = uid("adminpref-fill");
    const email = mail("adminpref-fill");
    const contact = await resolveOrCreateContact({ db, userId: ext, email });

    await upsertEmailPreference({
      db,
      externalId: ext,
      email,
      update: { unsubscribedAll: true },
      contactId: null,
      emitOutbound: false,
    });
    expect((await prefsFor(ext))[0]?.contactId).toBeNull();

    const res = await putPrefs(contact.id, { unsubscribedAll: false });
    expect(res.status).toBe(200);

    const rows = await prefsFor(ext);
    expect(rows).toHaveLength(1);
    // The write really took the conflict arm (the flag flipped) AND filled.
    expect(rows[0]?.unsubscribedAll).toBe(false);
    expect(rows[0]?.contactId).toBe(contact.id);
  });
});

describe("T4e — fill-if-known, never null-out (the coalesce guard)", () => {
  it("a later explicit-null upsert cannot erase a prior stamp", async () => {
    const ext = uid("coalesce");
    const email = mail("coalesce");
    const contact = await resolveOrCreateContact({ db, userId: ext, email });

    // Pre-stamp.
    await upsertEmailPreference({
      db,
      externalId: ext,
      email,
      update: { unsubscribedAll: true },
      emitOutbound: false,
    });
    expect((await prefsFor(ext))[0]?.contactId).toBe(contact.id);

    // A second write on the SAME (user_id, email) whose resolve produced
    // nothing. Without the coalesce this UPDATE would null the column.
    await upsertEmailPreference({
      db,
      externalId: ext,
      email,
      update: { unsubscribedAll: false },
      contactId: null,
      emitOutbound: false,
    });

    const rows = await prefsFor(ext);
    expect(rows).toHaveLength(1);
    // The preference DID change (proving the upsert really took the conflict
    // arm) while the stamp survived.
    expect(rows[0]?.unsubscribedAll).toBe(false);
    expect(rows[0]?.contactId).toBe(contact.id);
  });

  it("a later known id FILLS a row that was stamped NULL", async () => {
    const ext = uid("fill");
    const email = mail("fill");

    await upsertEmailPreference({
      db,
      externalId: ext,
      email,
      update: { unsubscribedAll: true },
      contactId: null,
      emitOutbound: false,
    });
    expect((await prefsFor(ext))[0]?.contactId).toBeNull();

    const contact = await resolveOrCreateContact({ db, userId: ext, email });
    await upsertEmailPreference({
      db,
      externalId: ext,
      email,
      update: { unsubscribedAll: false },
      emitOutbound: false,
    });

    expect((await prefsFor(ext))[0]?.contactId).toBe(contact.id);
  });
});

describe("D6 — a throwing resolve never fails the operation it rides on", () => {
  it("upsertEmailPreference still writes the row when the lookup throws", async () => {
    const ext = uid("d6");
    const email = mail("d6");
    await resolveOrCreateContact({ db, userId: ext, email });

    // FAULT INJECTION with no mocking machinery: the REAL db handle, wrapped so
    // that `select` (the ONLY read `lookupContactIdByKey` performs on this path)
    // blows up, while `insert` still reaches Postgres. The row is therefore real
    // and read back below.
    const failingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "select") {
          return () => {
            throw new Error("injected: contact lookup unavailable");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    await expect(
      upsertEmailPreference({
        db: failingDb,
        externalId: ext,
        email,
        update: { unsubscribedAll: true },
        emitOutbound: false,
      }),
    ).resolves.toBeUndefined();

    const rows = await prefsFor(ext);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.unsubscribedAll).toBe(true);
    // Degraded to NULL, exactly as D6 specifies — a backfill fills it later.
    expect(rows[0]?.contactId).toBeNull();
  });
});

describe("lookupContactIdByKey — the probe the dual-write rests on", () => {
  it("resolves an external_id, an anonymous_id and a row uuid", async () => {
    const ext = uid("probe-ext");
    const extContact = await resolveOrCreateContact({ db, userId: ext });
    const anon = uid("probe-anon");
    const anonContact = await resolveOrCreateContact({ db, anonymousId: anon });
    const emailOnly = await resolveOrCreateContact({
      db,
      email: mail("probe-email"),
    });

    expect(await lookupContactIdByKey(db, ext)).toBe(extContact.id);
    expect(await lookupContactIdByKey(db, anon)).toBe(anonContact.id);
    // An email-only contact's canonical key IS its row uuid.
    expect(await lookupContactIdByKey(db, emailOnly.id)).toBe(emailOnly.id);
  });

  it("resolves a second-device anon id that lives ONLY in contact_aliases", async () => {
    // Post-PRD-03 shape: the contact row already carries a DIFFERENT
    // anonymous_id, so the second device's key exists only as an identity row.
    // A column-only probe would NULL this visitor's history forever.
    const primaryAnon = uid("alias-primary");
    const secondDevice = uid("alias-second");
    const contact = await resolveOrCreateContact({
      db,
      anonymousId: primaryAnon,
    });
    await db.insert(contactAliases).values({
      contactId: contact.id,
      aliasKind: "anonymous",
      aliasValue: secondDevice,
      reason: "resolve",
    });

    // The column probe MISSES (proving the alias leg is what answers).
    const columnHit = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        or(
          eq(contacts.externalId, secondDevice),
          eq(contacts.anonymousId, secondDevice),
        ),
      );
    expect(columnHit).toHaveLength(0);

    expect(await lookupContactIdByKey(db, secondDevice)).toBe(contact.id);
  });

  it("an email-kind alias value does NOT resolve (not a canonical key)", async () => {
    const contact = await resolveOrCreateContact({
      db,
      userId: uid("alias-email-owner"),
    });
    const staleEmail = mail("alias-email");
    await db.insert(contactAliases).values({
      contactId: contact.id,
      aliasKind: "email",
      aliasValue: staleEmail,
      reason: "merge",
    });

    // Folding email aliases in would resolve history that today resolves to
    // nothing — a read-shape change smuggled in through a write.
    expect(await lookupContactIdByKey(db, staleEmail)).toBeNull();
  });

  it("prefers the external alias over the anonymous one, deterministically", async () => {
    const value = uid("alias-both");
    const extOwner = await resolveOrCreateContact({
      db,
      userId: uid("alias-both-ext"),
    });
    const anonOwner = await resolveOrCreateContact({
      db,
      userId: uid("alias-both-anon"),
    });
    await db.insert(contactAliases).values([
      {
        contactId: anonOwner.id,
        aliasKind: "anonymous",
        aliasValue: `${value}-x`,
        reason: "resolve",
      },
    ]);
    // The unique index is on (kind, value), so BOTH kinds can carry the SAME
    // value — precedence must be stated, not left to index order.
    await db.insert(contactAliases).values([
      {
        contactId: anonOwner.id,
        aliasKind: "anonymous",
        aliasValue: value,
        reason: "resolve",
      },
      {
        contactId: extOwner.id,
        aliasKind: "external",
        aliasValue: value,
        reason: "resolve",
      },
    ]);

    expect(await lookupContactIdByKey(db, value)).toBe(extOwner.id);
  });

  it("never resolves a soft-deleted target, and never throws on junk", async () => {
    const ext = uid("probe-deleted");
    const dead = await resolveOrCreateContact({ db, userId: ext });
    await db
      .update(contacts)
      .set({ deletedAt: new Date() })
      .where(eq(contacts.id, dead.id));

    expect(await lookupContactIdByKey(db, ext)).toBeNull();
    // A non-uuid key must not reach the uuid comparison (22P02).
    expect(await lookupContactIdByKey(db, "not-a-uuid-at-all")).toBeNull();
    expect(await lookupContactIdByKey(db, "")).toBeNull();

    // Housekeeping: the soft-deleted row is outside the afterAll `like` sweep's
    // reach only if a later merge moves it, so assert it is still ours.
    const [row] = await db
      .select({ externalId: contacts.externalId })
      .from(contacts)
      .where(and(eq(contacts.id, dead.id)));
    expect(row?.externalId).toBe(ext);
  });
});
