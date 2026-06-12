import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Hatchet via the override seam — ingest's downstream push lands on a spy.
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

const { contactAliases, contacts, userEvents } = await import("@hogsend/db");
const { and, eq, inArray } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};

const RUN = `ckr-${Date.now()}`;

const RT_EMAIL = `${RUN}-roundtrip@example.com`;
const M_LOSER_EMAIL = `${RUN}-merge-loser@example.com`;
const M_SURVIVOR_USER = `${RUN}-merge-survivor-user`;

const createdContactIds: string[] = [];

async function postEvent(body: Record<string, unknown>) {
  const res = await app.request("/v1/events", {
    method: "POST",
    headers: AUTH_HEADER,
    body: JSON.stringify(body),
  });
  return res;
}

afterAll(async () => {
  if (createdContactIds.length > 0) {
    await db
      .delete(userEvents)
      .where(inArray(userEvents.userId, createdContactIds));
    await db
      .delete(contactAliases)
      .where(inArray(contactAliases.contactId, createdContactIds));
    await db.delete(contacts).where(inArray(contacts.id, createdContactIds));
  }
  await db.delete(userEvents).where(eq(userEvents.userId, M_SURVIVOR_USER));
});

describe("contactKey on POST /v1/events", () => {
  it("returns the canonical key, and that key ROUND-TRIPS as a userId to the same contact", async () => {
    // (1) Email-only ingest → contact created; its canonical key is its row id.
    const first = await postEvent({
      name: `${RUN}.subscribed`,
      email: RT_EMAIL,
    });
    expect(first.status).toBe(202);
    const firstBody = await first.json();
    expect(firstBody.stored).toBe(true);
    expect(typeof firstBody.contactKey).toBe("string");

    const [created] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.email, RT_EMAIL));
    expect(created).toBeDefined();
    if (!created) throw new Error("contact not created");
    createdContactIds.push(created.id);
    expect(firstBody.contactKey).toBe(created.id);

    // (2) The key round-trips: an event keyed ONLY by that contactKey (the
    // shape a PostHog webhook forwards after an identify under the key)
    // resolves to the SAME contact — no duplicate row.
    const second = await postEvent({
      name: `${RUN}.pageview`,
      userId: firstBody.contactKey,
    });
    expect(second.status).toBe(202);
    const secondBody = await second.json();
    expect(secondBody.contactKey).toBe(firstBody.contactKey);

    const rows = await db
      .select()
      .from(contacts)
      .where(eq(contacts.externalId, created.id));
    // Self-healed: the round-tripped key was promoted onto external_id of the
    // SAME row (no second contact minted with external_id = the old row id).
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(created.id);
    expect(rows[0]?.email).toBe(RT_EMAIL);
  });
});

describe("merge records the email-only loser's row-id key as an alias", () => {
  it("a stale id-key still resolves to the survivor after the merge", async () => {
    // Loser: email-only (canonical key = row id).
    const loserRes = await postEvent({
      name: `${RUN}.merge-a`,
      email: M_LOSER_EMAIL,
    });
    expect(loserRes.status).toBe(202);
    const { contactKey: loserKey } = await loserRes.json();

    const [loser] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.email, M_LOSER_EMAIL));
    if (!loser) throw new Error("loser contact not created");
    createdContactIds.push(loser.id);
    expect(loserKey).toBe(loser.id);

    // Survivor-to-be: identified (external_id wins the survivor rule).
    const survivorRes = await postEvent({
      name: `${RUN}.merge-b`,
      userId: M_SURVIVOR_USER,
    });
    expect(survivorRes.status).toBe(202);
    const [survivor] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.externalId, M_SURVIVOR_USER));
    if (!survivor) throw new Error("survivor contact not created");
    createdContactIds.push(survivor.id);

    // Collide-merge: one event carrying BOTH keys.
    const mergeRes = await postEvent({
      name: `${RUN}.merge-collide`,
      email: M_LOSER_EMAIL,
      userId: M_SURVIVOR_USER,
    });
    expect(mergeRes.status).toBe(202);
    const { contactKey: mergedKey } = await mergeRes.json();
    expect(mergedKey).toBe(M_SURVIVOR_USER);

    // The loser's circulated row-id key was aliased to the survivor…
    const [alias] = await db
      .select()
      .from(contactAliases)
      .where(
        and(
          eq(contactAliases.aliasKind, "external"),
          eq(contactAliases.aliasValue, loser.id),
        ),
      );
    expect(alias?.contactId).toBe(survivor.id);

    // …so an event still keyed by the DEAD row's id resolves to the survivor.
    const staleRes = await postEvent({
      name: `${RUN}.stale-key`,
      userId: loser.id,
    });
    expect(staleRes.status).toBe(202);
    const { contactKey: staleKey } = await staleRes.json();
    expect(staleKey).toBe(M_SURVIVOR_USER);
  });
});
