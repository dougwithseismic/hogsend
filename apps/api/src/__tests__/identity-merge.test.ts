import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

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
  journeyStates,
  userEvents,
} = await import("@hogsend/db");
const { and, eq, inArray } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
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

const createdContactIds: string[] = [];

async function putContact(body: Record<string, unknown>) {
  const res = await app.request("/v1/contacts", {
    method: "PUT",
    headers: AUTH_HEADER,
    body: JSON.stringify(body),
  });
  return res;
}

afterAll(async () => {
  const keys = [A_USER, T_USER, LINK_USER, ...createdContactIds];
  if (keys.length > 0) {
    await db.delete(userEvents).where(inArray(userEvents.userId, keys));
    await db.delete(journeyStates).where(inArray(journeyStates.userId, keys));
    await db.delete(emailSends).where(inArray(emailSends.userId, keys));
    await db
      .delete(emailPreferences)
      .where(inArray(emailPreferences.userId, keys));
  }
  for (const email of [LINK_EMAIL, A_EMAIL, B_EMAIL, T_A_EMAIL, T_B_EMAIL]) {
    await db.delete(emailPreferences).where(eq(emailPreferences.email, email));
  }
  if (createdContactIds.length > 0) {
    await db
      .delete(contactAliases)
      .where(inArray(contactAliases.contactId, createdContactIds));
    await db.delete(contacts).where(inArray(contacts.id, createdContactIds));
  }
});

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
    const evtRes = await app.request("/v1/events", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({
        name: "merge.trigger",
        userId: A_USER,
        email: B_EMAIL,
        eventProperties: {},
      }),
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
    const evtRes = await app.request("/v1/events", {
      method: "POST",
      headers: AUTH_HEADER,
      body: JSON.stringify({
        name: "term.merge.trigger",
        userId: T_USER,
        email: T_B_EMAIL,
        eventProperties: {},
      }),
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
