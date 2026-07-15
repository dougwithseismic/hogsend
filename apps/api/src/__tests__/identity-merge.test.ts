import type { AnalyticsProvider, HogsendClient } from "@hogsend/engine";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Hatchet via the override seam — the merge runs inside `resolveOrCreateContact`
// (driven through PUT /v1/contacts + POST /v1/events), and the events route's
// downstream Hatchet push lands on a spy instead of a live engine.
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

const {
  contactAliases,
  contacts,
  emailPreferences,
  emailSends,
  groupMemberships,
  groups,
  journeyStates,
  userEvents,
} = await import("@hogsend/db");
const { and, eq, inArray, like } = await import("drizzle-orm");
const { createApp, createHogsendClient, mergeAnalyticsIdentities } =
  await import("@hogsend/engine");

// ---------------------------------------------------------------------------
// Spy analytics provider — a neutral `AnalyticsProvider` whose `mergeIdentities`
// is a `vi.fn()`. Injected via the BARE `analytics: provider` arm
// (`isAnalyticsProvider` → register-and-ACTIVATE branch). The group form
// (`{ provider }`) only registers and needs a `defaultProvider`/env id to pick
// the active one — the bare form makes the spy `container.analytics` outright.
// MF-9: the vitest env sets no POSTHOG_API_KEY / ANALYTICS_PROVIDER, so no real
// PostHog provider is built by `analyticsProvidersFromEnv` to win resolution
// over this spy. `identityMerge` is true so the engine's helper fans
// `mergeIdentities` out instead of no-oping.
// ---------------------------------------------------------------------------
const mergeIdentities = vi.fn();
const spyProvider: AnalyticsProvider = {
  meta: { id: "spy", name: "Spy" },
  capabilities: {
    personReads: false,
    personWrites: true,
    identityMerge: true,
  },
  getPersonProperties: vi.fn(async () => ({})),
  setPersonProperties: vi.fn(async () => {}),
  mergeIdentities,
  capture: vi.fn(),
};

const container = createHogsendClient({
  analytics: spyProvider,
  overrides: { hatchet: mockHatchet },
});
// MF-9 guard — the spy IS the resolved active provider (no real PostHog
// provider wins resolution and silently swallows the merge calls).
if (container.analytics !== spyProvider) {
  throw new Error(
    "spy analytics provider is not the active container provider",
  );
}
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};

const RUN = `idm-${Date.now()}`;

// ---- link case ----
const LINK_EMAIL = `${RUN}-link@example.com`;
const LINK_USER = `${RUN}-link-user`;

// ---- merge case ----
const A_USER = `${RUN}-merge-a-user`;
const A_EMAIL = `${RUN}-merge-a@example.com`;
const B_EMAIL = `${RUN}-merge-b@example.com`;

// ---- terminal-collision merge case (both completed the same journey) ----
const T_USER = `${RUN}-term-a-user`;
const T_A_EMAIL = `${RUN}-term-a@example.com`;
const T_B_EMAIL = `${RUN}-term-b@example.com`;
const SHARED_JOURNEY = `${RUN}-shared-journey`;

// ---- MF-2 identified-loser case (loser also carries an external_id) ----
const TWIN_SURVIVOR_USER = `${RUN}-twin-survivor-user`;
const TWIN_SURVIVOR_EMAIL = `${RUN}-twin-survivor@example.com`;
const TWIN_LOSER_USER = `${RUN}-twin-loser-user`;
const TWIN_LOSER_EMAIL = `${RUN}-twin-loser@example.com`;
const TWIN_LOSER_ANON = `${RUN}-twin-loser-anon`;

// ---- MF-3 fill-in-link flip case (anon/email → real external_id) ----
const FLIP_EMAIL = `${RUN}-flip@example.com`;
const FLIP_USER = `${RUN}-flip-user`;

// ---- idempotency case ----
const IDEM_SURVIVOR_USER = `${RUN}-idem-survivor-user`;
const IDEM_SURVIVOR_EMAIL = `${RUN}-idem-survivor@example.com`;
const IDEM_LOSER_EMAIL = `${RUN}-idem-loser@example.com`;

// ---- provider-absent case ----
const ABSENT_USER = `${RUN}-absent-user`;
const ABSENT_A_EMAIL = `${RUN}-absent-a@example.com`;
const ABSENT_B_EMAIL = `${RUN}-absent-b@example.com`;

// ---- (vi-c) group_memberships re-parent case ----
const G_SURVIVOR_USER = `${RUN}-grp-survivor-user`;
const G_SURVIVOR_EMAIL = `${RUN}-grp-survivor@example.com`;
const G_LOSER_EMAIL = `${RUN}-grp-loser@example.com`;
const G_COMPANY_KEY = `${RUN}-grp-acme.com`;

// ---- (vi-c) group_memberships COLLISION case (both are already members) ----
const GC_SURVIVOR_USER = `${RUN}-gcol-survivor-user`;
const GC_SURVIVOR_EMAIL = `${RUN}-gcol-survivor@example.com`;
const GC_LOSER_EMAIL = `${RUN}-gcol-loser@example.com`;
const GC_COMPANY_KEY = `${RUN}-gcol-acme.com`;

const createdContactIds: string[] = [];

async function putContact(body: Record<string, unknown>) {
  const res = await app.request("/v1/contacts", {
    method: "PUT",
    headers: AUTH_HEADER,
    body: JSON.stringify(body),
  });
  return res;
}

async function postEvent(body: Record<string, unknown>) {
  return app.request("/v1/events", {
    method: "POST",
    headers: AUTH_HEADER,
    body: JSON.stringify(body),
  });
}

/** Resolve the canonical contact id for an email (the uuid key a never-linked
 *  email-only contact's history is keyed on). */
async function contactIdForEmail(email: string): Promise<string> {
  const res = await app.request(
    `/v1/contacts/find?email=${encodeURIComponent(email)}`,
    { headers: AUTH_HEADER },
  );
  const body = await res.json();
  return body.contacts[0].id as string;
}

beforeEach(() => {
  mergeIdentities.mockClear();
});

afterAll(async () => {
  const keys = [
    A_USER,
    T_USER,
    LINK_USER,
    TWIN_SURVIVOR_USER,
    TWIN_LOSER_USER,
    TWIN_LOSER_ANON,
    FLIP_USER,
    IDEM_SURVIVOR_USER,
    ABSENT_USER,
    G_SURVIVOR_USER,
    GC_SURVIVOR_USER,
    ...createdContactIds,
  ];
  if (keys.length > 0) {
    await db.delete(userEvents).where(inArray(userEvents.userId, keys));
    await db.delete(journeyStates).where(inArray(journeyStates.userId, keys));
    await db.delete(emailSends).where(inArray(emailSends.userId, keys));
    await db
      .delete(emailPreferences)
      .where(inArray(emailPreferences.userId, keys));
  }
  for (const email of [
    LINK_EMAIL,
    A_EMAIL,
    B_EMAIL,
    T_A_EMAIL,
    T_B_EMAIL,
    TWIN_SURVIVOR_EMAIL,
    TWIN_LOSER_EMAIL,
    FLIP_EMAIL,
    IDEM_SURVIVOR_EMAIL,
    IDEM_LOSER_EMAIL,
    ABSENT_A_EMAIL,
    ABSENT_B_EMAIL,
    G_SURVIVOR_EMAIL,
    G_LOSER_EMAIL,
    GC_SURVIVOR_EMAIL,
    GC_LOSER_EMAIL,
  ]) {
    await db.delete(emailPreferences).where(eq(emailPreferences.email, email));
  }
  if (createdContactIds.length > 0) {
    await db
      .delete(contactAliases)
      .where(inArray(contactAliases.contactId, createdContactIds));
    await db.delete(contacts).where(inArray(contacts.id, createdContactIds));
  }
  // group_memberships cascade off contacts/groups; drop the run's groups.
  await db.delete(groups).where(like(groups.groupKey, `${RUN}%`));
});

// ===========================================================================
// Unit — the engine merge helper (`mergeAnalyticsIdentities`), §5.3 / §10.4.
// Direction (MF-1), no-op gates, MF-2 (caller never hands it an external_id),
// self-alias skip, and never-throws-on-provider-error.
// ===========================================================================
describe("mergeAnalyticsIdentities (helper)", () => {
  it("fans out one alias per loser key, survivor=distinctId / loser=alias (MF-1)", () => {
    const fn = vi.fn();
    mergeAnalyticsIdentities({
      analytics: {
        meta: { id: "p", name: "P" },
        capabilities: {
          personReads: false,
          personWrites: true,
          identityMerge: true,
        },
        getPersonProperties: async () => ({}),
        setPersonProperties: async () => {},
        mergeIdentities: fn,
        capture: () => {},
      },
      survivorKey: "canon",
      loserKeys: ["anon-1", "anon-2"],
      reason: "collide_merge",
    });
    expect(fn).toHaveBeenCalledTimes(2);
    // Direction is load-bearing: canonical survivor is `distinctId`, the
    // absorbed anon id is `alias` — NEVER the posthog-node `.d.ts` example.
    expect(fn).toHaveBeenNthCalledWith(1, {
      distinctId: "canon",
      alias: "anon-1",
    });
    expect(fn).toHaveBeenNthCalledWith(2, {
      distinctId: "canon",
      alias: "anon-2",
    });
  });

  it("no-ops when no provider is injected", () => {
    expect(() =>
      mergeAnalyticsIdentities({
        survivorKey: "canon",
        loserKeys: ["anon-1"],
        reason: "collide_merge",
      }),
    ).not.toThrow();
  });

  it("no-ops when the active provider can't merge (identityMerge falsy)", () => {
    const fn = vi.fn();
    mergeAnalyticsIdentities({
      analytics: {
        meta: { id: "legacy", name: "Legacy" },
        // identityMerge omitted → no-op (legacy adapter shape).
        capabilities: { personReads: false, personWrites: true },
        getPersonProperties: async () => ({}),
        setPersonProperties: async () => {},
        mergeIdentities: fn,
        capture: () => {},
      },
      survivorKey: "canon",
      loserKeys: ["anon-1"],
      reason: "collide_merge",
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("skips a self-alias (loserKey === survivorKey)", () => {
    const fn = vi.fn();
    mergeAnalyticsIdentities({
      analytics: {
        meta: { id: "p", name: "P" },
        capabilities: {
          personReads: false,
          personWrites: true,
          identityMerge: true,
        },
        getPersonProperties: async () => ({}),
        setPersonProperties: async () => {},
        mergeIdentities: fn,
        capture: () => {},
      },
      survivorKey: "canon",
      loserKeys: ["canon", "anon-1"],
      reason: "collide_merge",
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({ distinctId: "canon", alias: "anon-1" });
  });

  it("never throws when the provider's mergeIdentities throws (fire-and-forget)", () => {
    const fn = vi.fn(() => {
      throw new Error("posthog queue exploded");
    });
    expect(() =>
      mergeAnalyticsIdentities({
        analytics: {
          meta: { id: "p", name: "P" },
          capabilities: {
            personReads: false,
            personWrites: true,
            identityMerge: true,
          },
          getPersonProperties: async () => ({}),
          setPersonProperties: async () => {},
          mergeIdentities: fn,
          capture: () => {},
        },
        survivorKey: "canon",
        loserKeys: ["anon-1"],
        reason: "collide_merge",
      }),
    ).not.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// Existing resolver-merge DB tests — the mechanical re-point/fold behaviour,
// independent of analytics. Preserved verbatim.
// ===========================================================================
describe("fill-in-link (email-only then userId links them)", () => {
  it("attaches the userId to the existing email-only contact (single row)", async () => {
    // Create an email-only contact (external_id null).
    const first = await putContact({
      email: LINK_EMAIL,
      properties: { source: "email-first" },
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.created).toBe(true);
    expect(firstBody.linked).toBe(false);
    createdContactIds.push(firstBody.id);

    // A later PUT with the SAME email + a userId matches the single existing row
    // → fill-in-link (NOT a new contact). Same id, linked:true.
    const second = await putContact({ userId: LINK_USER, email: LINK_EMAIL });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.created).toBe(false);
    expect(secondBody.linked).toBe(true);

    // The row now carries BOTH identity keys.
    const [row] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, firstBody.id));
    expect(row?.email).toBe(LINK_EMAIL);
    expect(row?.externalId).toBe(LINK_USER);

    // A `promote` alias was recorded for the newly-attached external key.
    const [alias] = await db
      .select()
      .from(contactAliases)
      .where(
        and(
          eq(contactAliases.aliasKind, "external"),
          eq(contactAliases.aliasValue, LINK_USER),
        ),
      );
    expect(alias?.contactId).toBe(firstBody.id);
    expect(alias?.reason).toBe("promote");
  });
});

describe("collide-merge (two distinct rows share a resolve)", () => {
  it("re-points user_events/journey_states/email_sends/email_preferences onto the survivor, soft-deletes the loser, and aliases the stale key", async () => {
    // Survivor candidate A: identified (external_id) — wins the SURVIVOR RULE.
    const aRes = await putContact({
      userId: A_USER,
      email: A_EMAIL,
      properties: { plan: "pro" },
    });
    const aBody = await aRes.json();
    createdContactIds.push(aBody.id);
    const survivorKey = A_USER; // A's text key is its external_id.

    // Loser candidate B: email-only, no external/anonymous id → its history is
    // keyed on its CONTACT ID (the last-resort user_id key).
    const bRes = await putContact({
      email: B_EMAIL,
      properties: { plan: "free", onlyOnLoser: "keep-me" },
    });
    const bBody = await bRes.json();
    createdContactIds.push(bBody.id);
    const loserKey: string = bBody.id;

    // Seed loser-keyed history across the 4 string-keyed tables.
    await db
      .insert(userEvents)
      .values({ userId: loserKey, event: "loser.event", properties: {} });
    await db.insert(journeyStates).values({
      userId: loserKey,
      userEmail: B_EMAIL,
      journeyId: `${RUN}-loser-journey`,
      currentNodeId: "start",
      status: "completed",
    });
    await db.insert(emailSends).values({
      userId: loserKey,
      userEmail: B_EMAIL,
      fromEmail: "from@hogsend.test",
      toEmail: B_EMAIL,
      subject: "loser send",
      status: "sent",
    });
    // Loser pref carries an UNSUBSCRIBE that must survive the FOLD (risk 6).
    await db.insert(emailPreferences).values({
      userId: loserKey,
      email: B_EMAIL,
      unsubscribedAll: true,
    });

    // Drive the merge through the public surface: an event carrying BOTH keys
    // (userId=A, email=B) resolves A on external_id + B on email → 2 distinct
    // rows → collide-merge inside resolveOrCreateContact.
    const evtRes = await postEvent({
      name: "merge.trigger",
      userId: A_USER,
      email: B_EMAIL,
      eventProperties: {},
    });
    expect(evtRes.status).toBe(202);

    // (ii) user_events re-pointed onto the survivor key (loser key drained).
    const loserEvents = await db
      .select()
      .from(userEvents)
      .where(eq(userEvents.userId, loserKey));
    expect(loserEvents).toHaveLength(0);
    const survivorLoserEvent = await db
      .select()
      .from(userEvents)
      .where(
        and(
          eq(userEvents.userId, survivorKey),
          eq(userEvents.event, "loser.event"),
        ),
      );
    expect(survivorLoserEvent).toHaveLength(1);

    // (iii) journey_states re-pointed (+ user_email rewritten to survivor's).
    const survivorStates = await db
      .select()
      .from(journeyStates)
      .where(
        and(
          eq(journeyStates.userId, survivorKey),
          eq(journeyStates.journeyId, `${RUN}-loser-journey`),
        ),
      );
    expect(survivorStates).toHaveLength(1);
    expect(survivorStates[0]?.userEmail).toBe(A_EMAIL);

    // (iv) email_sends re-pointed onto the survivor key.
    const survivorSends = await db
      .select()
      .from(emailSends)
      .where(
        and(
          eq(emailSends.userId, survivorKey),
          eq(emailSends.subject, "loser send"),
        ),
      );
    expect(survivorSends).toHaveLength(1);

    // (vi) email_preferences FOLD — the loser's unsubscribe was OR'd onto the
    // survivor key (never lost); the loser pref row is gone.
    const loserPrefs = await db
      .select()
      .from(emailPreferences)
      .where(eq(emailPreferences.userId, loserKey));
    expect(loserPrefs).toHaveLength(0);
    const survivorPrefs = await db
      .select()
      .from(emailPreferences)
      .where(eq(emailPreferences.userId, survivorKey));
    expect(survivorPrefs.some((p) => p.unsubscribedAll)).toBe(true);

    // (vii) properties folded — survivor wins on conflict, loser-only keys kept.
    const [survivorRow] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, aBody.id));
    const props = survivorRow?.properties as Record<string, unknown>;
    expect(props?.plan).toBe("pro"); // survivor wins
    expect(props?.onlyOnLoser).toBe("keep-me"); // loser-only key preserved

    // (viii) loser soft-deleted.
    const [loserRow] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, bBody.id));
    expect(loserRow?.deletedAt).not.toBeNull();

    // (ix) the stale loser email is aliased → survivor, so a find under the
    //      stale key returns the survivor (NOT a fresh contact).
    const findRes = await app.request(`/v1/contacts/find?userId=${A_USER}`, {
      headers: AUTH_HEADER,
    });
    const findBody = await findRes.json();
    expect(findBody.contacts).toHaveLength(1);
    expect(findBody.contacts[0].id).toBe(aBody.id);
    expect(findBody.contacts[0].email).toBe(A_EMAIL);

    // A subsequent resolve under the stale loser email links back to the
    // survivor via the merge alias (no new contact row minted).
    const reResolve = await putContact({ email: B_EMAIL });
    const reBody = await reResolve.json();
    expect(reBody.id).toBe(aBody.id);
    expect(reBody.created).toBe(false);

    // §5.3 emission point 1 — the analytics merge fired exactly once, folding
    // the loser's SAFE (anon/uuid) key INTO the survivor key. Direction (MF-1):
    // survivor=distinctId, absorbed=alias.
    expect(mergeIdentities).toHaveBeenCalledWith({
      distinctId: survivorKey,
      alias: loserKey,
    });
    // MF-2 — the survivor's identified key is NEVER absorbed as an `alias`.
    expect(mergeIdentities).not.toHaveBeenCalledWith(
      expect.objectContaining({ alias: survivorKey }),
    );
  });
});

describe("collide-merge with a TERMINAL journey-state collision", () => {
  it("does not violate uq_user_journey_active when survivor AND loser both 'completed' the same journey", async () => {
    // Survivor T_A: identified → wins the SURVIVOR RULE. Its history is keyed on
    // its external_id.
    const aRes = await putContact({ userId: T_USER, email: T_A_EMAIL });
    const aBody = await aRes.json();
    createdContactIds.push(aBody.id);

    // Loser T_B: email-only → history keyed on its contact id.
    const bRes = await putContact({ email: T_B_EMAIL });
    const bBody = await bRes.json();
    createdContactIds.push(bBody.id);
    const loserKey: string = bBody.id;

    // BOTH identities completed the SAME journey. uq_user_journey_active is a
    // FULL (non-partial) unique index on (user_id, journey_id, status), so a
    // blind rewrite of the loser's 'completed' row onto the survivor key would
    // duplicate (T_USER, SHARED_JOURNEY, 'completed') and abort the whole merge
    // tx. The fold must dedupe terminal rows, not just active ones.
    await db.insert(journeyStates).values({
      userId: T_USER,
      userEmail: T_A_EMAIL,
      journeyId: SHARED_JOURNEY,
      currentNodeId: "done",
      status: "completed",
    });
    await db.insert(journeyStates).values({
      userId: loserKey,
      userEmail: T_B_EMAIL,
      journeyId: SHARED_JOURNEY,
      currentNodeId: "done",
      status: "completed",
    });

    // Drive the merge: an event carrying BOTH keys collides the two rows.
    const evtRes = await postEvent({
      name: "term.merge.trigger",
      userId: T_USER,
      email: T_B_EMAIL,
      eventProperties: {},
    });
    // The merge tx must COMMIT (202), not 500 on a unique violation.
    expect(evtRes.status).toBe(202);

    // Exactly ONE 'completed' row for (survivor, SHARED_JOURNEY) survives — the
    // loser's duplicate was dropped, not rewritten into a collision.
    const survivorStates = await db
      .select()
      .from(journeyStates)
      .where(
        and(
          eq(journeyStates.userId, T_USER),
          eq(journeyStates.journeyId, SHARED_JOURNEY),
          eq(journeyStates.status, "completed"),
        ),
      );
    expect(survivorStates).toHaveLength(1);

    // No journey_states rows remain under the loser key.
    const loserStates = await db
      .select()
      .from(journeyStates)
      .where(eq(journeyStates.userId, loserKey));
    expect(loserStates).toHaveLength(0);

    // The loser contact was soft-deleted (the merge completed end-to-end).
    const [loserRow] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, bBody.id));
    expect(loserRow?.deletedAt).not.toBeNull();
  });
});

describe("deep-merge of DEEP_MERGE_KEYS (contacts.properties.discord)", () => {
  it("merges the nested `discord` object one level instead of clobbering it (fill-in-link path)", async () => {
    const DM_EMAIL = `${RUN}-deepmerge@example.com`;

    // First write: a `discord` sub-object carrying username (e.g. a member-link
    // or a MESSAGE_CREATE). Plain sibling keys come along too.
    const first = await putContact({
      email: DM_EMAIL,
      properties: {
        plan: "free",
        discord: { id: "snow1", username: "alice", global_name: "Alice" },
      },
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    createdContactIds.push(firstBody.id);

    // Second write: a `discord` sub-object carrying ONLY id + last_seen (e.g. a
    // MESSAGE_REACTION_ADD, which can't know the username). With the §2.1
    // shallow `||` this would REPLACE the whole `discord` object and erase
    // `username`/`global_name`; the DEEP_MERGE_KEYS exception must preserve them.
    const second = await putContact({
      email: DM_EMAIL,
      properties: {
        discord: { id: "snow1", last_seen: "2026-06-13T00:00:00Z" },
      },
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.id).toBe(firstBody.id);

    const [row] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, firstBody.id));
    const props = (row?.properties ?? {}) as Record<string, unknown>;
    const discord = props.discord as Record<string, unknown>;

    // The nested object is the UNION: prior fields survive, new ones added.
    expect(discord).toEqual({
      id: "snow1",
      username: "alice",
      global_name: "Alice",
      last_seen: "2026-06-13T00:00:00Z",
    });
    // Sibling top-level keys are untouched by the discord deep-merge.
    expect(props.plan).toBe("free");
  });
});

// ===========================================================================
// Integration — §5.3 emission point 2 (canonical-key flip on fill-in-link) +
// MF-3 gate. Driven through POST /v1/events (the ONLY surface that threads
// `analytics` into ingestEvent — PUT /v1/contacts deliberately does NOT emit).
// ===========================================================================
describe("fill-in-link key flip emits one alias (MF-3 safe path)", () => {
  it("aliases the OLD anon/uuid key INTO the new external_id", async () => {
    // (1) An email-only event creates the contact; its canonical key is the
    // contact UUID (no external/anonymous id). No merge fires on a fresh create.
    const create = await postEvent({
      name: "flip.seed",
      email: FLIP_EMAIL,
      eventProperties: {},
    });
    expect(create.status).toBe(202);
    expect(mergeIdentities).not.toHaveBeenCalled();
    const oldKey = await contactIdForEmail(FLIP_EMAIL); // the uuid key
    createdContactIds.push(oldKey);

    mergeIdentities.mockClear();

    // (2) A later event with the SAME email + a real userId fill-in-links the
    // single existing row and FLIPS its canonical key uuid → external_id. The
    // old key is anon/uuid (never an external_id being superseded) → MF-3 gate
    // passes → exactly one safe alias fires.
    const flip = await postEvent({
      name: "flip.identify",
      email: FLIP_EMAIL,
      userId: FLIP_USER,
      eventProperties: {},
    });
    expect(flip.status).toBe(202);

    expect(mergeIdentities).toHaveBeenCalledTimes(1);
    expect(mergeIdentities).toHaveBeenCalledWith({
      distinctId: FLIP_USER, // the new canonical (survivor) key
      alias: oldKey, // the absorbed anon/uuid key
    });
  });
});

// ===========================================================================
// Integration — MF-2: a loser that ALSO carries an external_id is an
// already-identified person. Its external_id MUST NOT be aliased (the merge
// PostHog refuses) — it surfaces as a residual twin, never as an `alias`.
// ===========================================================================
describe("collide-merge with an IDENTIFIED loser (MF-2)", () => {
  it("aliases ONLY the loser's safe anon key, NEVER its external_id (residual twin)", async () => {
    // Survivor: identified AND older → wins the SURVIVOR RULE (identified, then
    // OLDEST). Created FIRST so it is the oldest of the two identified rows.
    const survivor = await putContact({
      userId: TWIN_SURVIVOR_USER,
      email: TWIN_SURVIVOR_EMAIL,
    });
    const survivorBody = await survivor.json();
    createdContactIds.push(survivorBody.id);

    // Loser: ALSO identified (own external_id) AND carries an anon id, younger →
    // loses the tie-break. Its external_id carried an identified PostHog person
    // (MF-2 residual, NEVER aliased); its anon id is SAFE to absorb. Giving the
    // loser BOTH keys makes the split observable: the merge MUST fire for the
    // anon key (proving it ran) and MUST NOT fire for the external_id.
    const loser = await putContact({
      userId: TWIN_LOSER_USER,
      email: TWIN_LOSER_EMAIL,
      anonymousId: TWIN_LOSER_ANON,
    });
    const loserBody = await loser.json();
    createdContactIds.push(loserBody.id);

    // Collide the two identified rows: an event naming the survivor's external_id
    // + the loser's email resolves BOTH → two distinct rows → collide-merge.
    const evtRes = await postEvent({
      name: "twin.merge.trigger",
      userId: TWIN_SURVIVOR_USER,
      email: TWIN_LOSER_EMAIL,
      eventProperties: {},
    });
    expect(evtRes.status).toBe(202);

    // The merge DID run — the loser's SAFE anon key was absorbed into the
    // survivor (this is the meaningful positive that makes the negatives below
    // non-vacuous).
    expect(mergeIdentities).toHaveBeenCalledWith({
      distinctId: TWIN_SURVIVOR_USER,
      alias: TWIN_LOSER_ANON,
    });

    // MF-2 — the loser's external_id (an already-identified key) is NEVER passed
    // as an `alias`; aliasing it is the identified→identified merge PostHog
    // refuses (R2/R4). It is the residual twin, surfaced for observability only.
    expect(mergeIdentities).not.toHaveBeenCalledWith(
      expect.objectContaining({ alias: TWIN_LOSER_USER }),
    );
    // The loser's uuid is never aliased either (its events were under its keys,
    // not its raw id).
    expect(mergeIdentities).not.toHaveBeenCalledWith(
      expect.objectContaining({ alias: loserBody.id }),
    );
    // The canonical survivor key is never the absorbed side (MF-1).
    expect(mergeIdentities).not.toHaveBeenCalledWith(
      expect.objectContaining({ alias: TWIN_SURVIVOR_USER }),
    );
  });
});

// ===========================================================================
// Integration — idempotency placement: a retry with the SAME idempotencyKey
// must NOT re-fire `mergeIdentities` (it sits INSIDE the idempotency-guarded
// block, after a FRESH insert; the duplicate path returns early).
// ===========================================================================
describe("merge emission is idempotency-guarded", () => {
  it("fires alias once on the first ingest, zero on a same-key replay", async () => {
    const survivor = await putContact({
      userId: IDEM_SURVIVOR_USER,
      email: IDEM_SURVIVOR_EMAIL,
    });
    const survivorBody = await survivor.json();
    createdContactIds.push(survivorBody.id);

    const loser = await putContact({ email: IDEM_LOSER_EMAIL });
    const loserBody = await loser.json();
    createdContactIds.push(loserBody.id);
    const loserKey: string = loserBody.id;

    const idempotencyKey = `${RUN}-idem-key`;

    // First ingest: collide-merge → one alias for the loser's safe key.
    const first = await postEvent({
      name: "idem.merge.trigger",
      userId: IDEM_SURVIVOR_USER,
      email: IDEM_LOSER_EMAIL,
      idempotencyKey,
      eventProperties: {},
    });
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ stored: true });
    expect(mergeIdentities).toHaveBeenCalledTimes(1);
    expect(mergeIdentities).toHaveBeenCalledWith({
      distinctId: IDEM_SURVIVOR_USER,
      alias: loserKey,
    });

    mergeIdentities.mockClear();

    // Replay the SAME idempotencyKey. The event insert dedups (onConflictDoNothing
    // → stored:false, early return BEFORE the merge emission), so the alias must
    // NOT fire again — honoring "only at the moment two keys first become one".
    const replay = await postEvent({
      name: "idem.merge.trigger",
      userId: IDEM_SURVIVOR_USER,
      email: IDEM_LOSER_EMAIL,
      idempotencyKey,
      eventProperties: {},
    });
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ stored: false });
    expect(mergeIdentities).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Integration — provider absent / can't merge: the DB re-point still happens
// and the event is still 202; the engine simply no-ops the analytics stitch.
// A second container with NO analytics provider exercises this seam.
// ===========================================================================
describe("merge with NO analytics provider (graceful no-op)", () => {
  it("re-points the contact store and still 202s without any alias", async () => {
    const noAnalytics = createHogsendClient({
      overrides: { hatchet: mockHatchet },
    });
    expect(noAnalytics.analytics).toBeUndefined();
    const noAnalyticsApp = createApp(noAnalytics);

    const survivor = await noAnalyticsApp.request("/v1/contacts", {
      method: "PUT",
      headers: AUTH_HEADER,
      body: JSON.stringify({ userId: ABSENT_USER, email: ABSENT_A_EMAIL }),
    });
    const survivorBody = await survivor.json();
    createdContactIds.push(survivorBody.id);

    const loser = await noAnalyticsApp.request("/v1/contacts", {
      method: "PUT",
      headers: AUTH_HEADER,
      body: JSON.stringify({ email: ABSENT_B_EMAIL }),
    });
    const loserBody = await loser.json();
    createdContactIds.push(loserBody.id);
    const loserKey: string = loserBody.id;

    // Seed a loser-keyed event so we can assert the DB re-point happened.
    await db.insert(userEvents).values({
      userId: loserKey,
      event: "absent.loser.event",
      properties: {},
    });

    const evtRes = await noAnalyticsApp.request("/v1/events", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({
        name: "absent.merge.trigger",
        userId: ABSENT_USER,
        email: ABSENT_B_EMAIL,
        eventProperties: {},
      }),
    });
    // Still accepted — analytics is non-load-bearing.
    expect(evtRes.status).toBe(202);

    // DB re-point unchanged: the loser-keyed event followed onto the survivor.
    const loserEvents = await db
      .select()
      .from(userEvents)
      .where(eq(userEvents.userId, loserKey));
    expect(loserEvents).toHaveLength(0);
    const survivorEvents = await db
      .select()
      .from(userEvents)
      .where(
        and(
          eq(userEvents.userId, ABSENT_USER),
          eq(userEvents.event, "absent.loser.event"),
        ),
      );
    expect(survivorEvents).toHaveLength(1);

    // The shared spy provider belongs to the OTHER container — it must not have
    // been touched by this no-provider container's merge.
    expect(mergeIdentities).not.toHaveBeenCalled();

    await noAnalytics.dbClient.end({ timeout: 5 }).catch(() => {});
  });
});

// ===========================================================================
// Integration — (vi-c) group_memberships. `contact_id` is a uuid FK, but the
// merge SOFT-deletes the loser, so `onDelete: cascade` NEVER fires: without the
// fold the loser's memberships are stranded on a dead row (survivor's drawer
// reads "no groups"; the group's member count/list disagree). Both memberships
// below are seeded through the REAL ingest path (an event carrying a `groups`
// map), and the merge is driven through the REAL collide-merge — no raw SQL
// merge surgery.
// ===========================================================================
describe("collide-merge re-parents group_memberships (vi-c)", () => {
  it("moves the loser's membership onto the survivor", async () => {
    const survivorRes = await putContact({
      userId: G_SURVIVOR_USER,
      email: G_SURVIVOR_EMAIL,
    });
    const survivorBody = await survivorRes.json();
    createdContactIds.push(survivorBody.id);
    const survivorId: string = survivorBody.id;

    // Loser: email-only → loses the SURVIVOR RULE to the identified row.
    const loserRes = await putContact({ email: G_LOSER_EMAIL });
    const loserBody = await loserRes.json();
    createdContactIds.push(loserBody.id);
    const loserId: string = loserBody.id;

    // The LOSER is the group's member (the survivor is not) — the association
    // is ensured by ingest from the event's `groups` map.
    const seed = await postEvent({
      name: "grp.loser.seed",
      email: G_LOSER_EMAIL,
      groups: { company: G_COMPANY_KEY },
      eventProperties: {},
    });
    expect(seed.status).toBe(202);
    const before = await db
      .select()
      .from(groupMemberships)
      .where(eq(groupMemberships.contactId, loserId));
    expect(before).toHaveLength(1);

    // Collide the two rows (userId=survivor + email=loser) → collide-merge.
    const evtRes = await postEvent({
      name: "grp.merge.trigger",
      userId: G_SURVIVOR_USER,
      email: G_LOSER_EMAIL,
      eventProperties: {},
    });
    expect(evtRes.status).toBe(202);

    // The membership FOLLOWED the survivor; nothing is stranded on the loser.
    const loserAfter = await db
      .select()
      .from(groupMemberships)
      .where(eq(groupMemberships.contactId, loserId));
    expect(loserAfter).toHaveLength(0);
    const survivorAfter = await db
      .select()
      .from(groupMemberships)
      .where(eq(groupMemberships.contactId, survivorId));
    expect(survivorAfter).toHaveLength(1);

    // ...and the survivor's contact drawer now shows the group.
    const detail = await app.request(`/v1/admin/contacts/${survivorId}`, {
      headers: AUTH_HEADER,
    });
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(
      detailBody.groups.some(
        (g: { groupType: string; groupKey: string }) =>
          g.groupType === "company" && g.groupKey === G_COMPANY_KEY,
      ),
    ).toBe(true);
  });

  it("drops the loser's duplicate when the survivor is ALREADY a member (uq(group_id, contact_id))", async () => {
    const survivorRes = await putContact({
      userId: GC_SURVIVOR_USER,
      email: GC_SURVIVOR_EMAIL,
    });
    const survivorBody = await survivorRes.json();
    createdContactIds.push(survivorBody.id);
    const survivorId: string = survivorBody.id;

    const loserRes = await putContact({ email: GC_LOSER_EMAIL });
    const loserBody = await loserRes.json();
    createdContactIds.push(loserBody.id);
    const loserId: string = loserBody.id;

    // BOTH identities are members of the SAME group before the merge — a blind
    // rewrite of the loser's row onto the survivor would violate
    // uq(group_id, contact_id) and abort the whole merge tx.
    for (const who of [
      { name: "gcol.survivor.seed", userId: GC_SURVIVOR_USER },
      { name: "gcol.loser.seed", email: GC_LOSER_EMAIL },
    ]) {
      const res = await postEvent({
        ...who,
        groups: { company: GC_COMPANY_KEY },
        eventProperties: {},
      });
      expect(res.status).toBe(202);
    }

    const [group] = await db
      .select()
      .from(groups)
      .where(
        and(
          eq(groups.groupType, "company"),
          eq(groups.groupKey, GC_COMPANY_KEY),
        ),
      );
    const groupId = group?.id ?? "";
    expect(groupId).not.toBe("");

    // The SURVIVOR's membership carries the authoritative role — the fold keeps
    // the survivor's row, so this must still be here after the merge.
    await db
      .update(groupMemberships)
      .set({ role: "admin" })
      .where(
        and(
          eq(groupMemberships.groupId, groupId),
          eq(groupMemberships.contactId, survivorId),
        ),
      );
    const rowsBefore = await db
      .select()
      .from(groupMemberships)
      .where(eq(groupMemberships.groupId, groupId));
    expect(rowsBefore).toHaveLength(2);

    // The merge tx must COMMIT (202), not 500 on the unique violation.
    const evtRes = await postEvent({
      name: "gcol.merge.trigger",
      userId: GC_SURVIVOR_USER,
      email: GC_LOSER_EMAIL,
      eventProperties: {},
    });
    expect(evtRes.status).toBe(202);

    // Exactly ONE membership row for (group, survivor) survives — the loser's
    // duplicate was DROPPED, and the survivor's role/joinedAt won.
    const rowsAfter = await db
      .select()
      .from(groupMemberships)
      .where(eq(groupMemberships.groupId, groupId));
    expect(rowsAfter).toHaveLength(1);
    expect(rowsAfter[0]?.contactId).toBe(survivorId);
    expect(rowsAfter[0]?.role).toBe("admin");

    const loserAfter = await db
      .select()
      .from(groupMemberships)
      .where(eq(groupMemberships.contactId, loserId));
    expect(loserAfter).toHaveLength(0);

    // count == list on the admin surface: one live member, counted once.
    const detail = await app.request(
      `/v1/admin/groups/company/${encodeURIComponent(GC_COMPANY_KEY)}`,
      { headers: AUTH_HEADER },
    );
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.group.memberCount).toBe(1);
    expect(detailBody.group.recentMembers).toHaveLength(1);
    expect(detailBody.group.recentMembers[0].contactId).toBe(survivorId);
  });
});
