import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Same real test DB the engine singletons + the route container read.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Hatchet via the override seam — ingest's downstream push lands on a spy, never
// a live gRPC engine.
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

const { apiKeys, contacts, contactAliases, feedItems, userEvents } =
  await import("@hogsend/db");
const { and, eq, inArray, isNull, sql } = await import("drizzle-orm");
const { createApp, createHogsendClient, ingestEvent, sendFeedItem } =
  await import("@hogsend/engine");

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
const app = createApp(container);
const { db, registry, logger } = container;

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

const RUN = `idprov-${Date.now()}`;
const ORIGIN = "https://app.example.com";
const PK = `pk_idprov_${Date.now()}`;
let pkId = "";

// UUID-shaped anon ids (what @hogsend/js's crypto.randomUUID produces) — the
// worst case, where the value-path uuid row-id fallback would otherwise be in
// play. The fix keys on the contact ROW id instead.
const A1 = "11111111-aaaa-4aaa-8aaa-111111111111"; // pure anon
const A2 = "22222222-bbbb-4bbb-8bbb-222222222222"; // email + anon
const A3 = "33333333-cccc-4ccc-8ccc-333333333333"; // merged-away loser anon
const E3 = `${RUN}-survivor-ext`;
const A2_EMAIL = `${RUN}-emailanon@example.com`;

const createdIds: string[] = [];

async function ensureFeedItemsTable() {
  await db.execute(sql`
    DO $$ BEGIN
      CREATE TYPE "public"."feed_item_status" AS ENUM('unseen','seen','read','archived');
    EXCEPTION WHEN duplicate_object THEN null; END $$;`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "feed_items" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "recipient_key" text NOT NULL, "contact_id" uuid, "type" text NOT NULL,
      "title" text, "body" text, "blocks" jsonb, "action_url" text,
      "metadata" jsonb, "journey_state_id" uuid, "template_key" text,
      "category" text DEFAULT 'in_app' NOT NULL,
      "status" "feed_item_status" DEFAULT 'unseen' NOT NULL,
      "seen_at" timestamp with time zone, "read_at" timestamp with time zone,
      "archived_at" timestamp with time zone, "idempotency_key" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL);`);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS "feed_items_idempotency_key_idx" ON "feed_items" USING btree ("idempotency_key");`,
  );
}

function ingestInternal(event: {
  event: string;
  userId?: string;
  anonymousId?: string;
  contactId?: string;
  eventProperties?: Record<string, unknown>;
}) {
  return ingestEvent({
    db,
    registry,
    hatchet: mockHatchet,
    logger,
    event: { eventProperties: {}, ...event },
  });
}

function pubPost(body: unknown) {
  return app.request("/v1/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PK}`,
      Origin: ORIGIN,
    },
    body: JSON.stringify(body),
  });
}

function feedGet(anonymousId: string) {
  return app.request(
    `/v1/feed?feedId=in_app&anonymousId=${encodeURIComponent(anonymousId)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${PK}`, Origin: ORIGIN },
    },
  );
}

async function rowsWithExternalId(value: string) {
  return db
    .select()
    .from(contacts)
    .where(and(eq(contacts.externalId, value), isNull(contacts.deletedAt)));
}

async function trackCreated() {
  for (const v of [A1, A2, A3]) {
    const rs = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.anonymousId, v));
    for (const r of rs) createdIds.push(r.id);
  }
  for (const v of [E3]) {
    const rs = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.externalId, v));
    for (const r of rs) createdIds.push(r.id);
  }
}

beforeAll(async () => {
  await ensureFeedItemsTable();
  const [k] = await db
    .insert(apiKeys)
    .values({
      name: "idprov pub",
      keyPrefix: PK.slice(0, 8),
      keyHash: hashKey(PK),
      scopes: ["ingest-public"],
      allowedOrigins: [ORIGIN],
    })
    .returning({ id: apiKeys.id });
  pkId = k?.id ?? "";
});

afterAll(async () => {
  await trackCreated();
  for (const v of [A1, A2, A3, E3]) {
    await db.delete(feedItems).where(eq(feedItems.recipientKey, v));
    await db.delete(userEvents).where(eq(userEvents.userId, v));
  }
  if (createdIds.length) {
    await db
      .delete(contactAliases)
      .where(inArray(contactAliases.contactId, createdIds));
    await db
      .delete(contactAliases)
      .where(inArray(contactAliases.fromContactId, createdIds));
    await db.delete(contacts).where(inArray(contacts.id, createdIds));
  }
  await db.delete(contacts).where(eq(contacts.externalId, A1));
  await db.delete(contacts).where(eq(contacts.externalId, A2));
  await db.delete(contacts).where(eq(contacts.externalId, A3));
  if (pkId) await db.delete(apiKeys).where(eq(apiKeys.id, pkId));
});

describe("engine-internal provenance (contactId) prevents phantom twins", () => {
  it("R1: an internal re-emit keyed by an anon contact's own canonical key folds in — no external_id twin", async () => {
    // Anon visitor fires a publishable event → anon contact {anonymous_id:A1}.
    const fired = await pubPost({ name: `${RUN}.fired`, anonymousId: A1 });
    expect(fired.status).toBe(202);
    const [anon] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.anonymousId, A1));
    if (!anon) throw new Error("anon contact not created");
    expect(anon.externalId).toBeNull();

    // Simulate the engine's internal re-emit (feed mark / journey lifecycle /
    // tracking): userId = the anon canonical key, with the unforgeable contactId.
    const re = await ingestInternal({
      event: `${RUN}.internal`,
      userId: A1,
      contactId: anon.id,
    });
    expect(re.stored).toBe(true);
    expect(re.contactKey).toBe(A1); // history keyed identically to today

    // No phantom identified twin minted, and the anon contact is untouched.
    expect(await rowsWithExternalId(A1)).toHaveLength(0);
    const anonRows = await db
      .select()
      .from(contacts)
      .where(eq(contacts.anonymousId, A1));
    expect(anonRows).toHaveLength(1);
    expect(anonRows[0]?.externalId).toBeNull();
  });

  it("R2: the anon visitor's own feed stays readable (200, never 403 'not addressable') after the re-emit", async () => {
    const res = await feedGet(A1);
    expect(res.status).toBe(200); // explicitly NOT 403
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("R2b: driving the real feed mark route mints no twin (the actual lockout trigger)", async () => {
    await sendFeedItem({
      recipient: { anonymousId: A1 },
      type: "welcome",
      title: "hi",
      body: "b",
    });
    // Mark-all read → the route's inapp.feed_cleared / emitMarkEvents re-ingest.
    const mark = await app.request("/v1/feed/mark-all", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PK}`,
        Origin: ORIGIN,
      },
      body: JSON.stringify({
        feedId: "in_app",
        anonymousId: A1,
        state: "read",
      }),
    });
    expect([200, 201, 204]).toContain(mark.status);
    // Still no twin, and the feed still reads.
    expect(await rowsWithExternalId(A1)).toHaveLength(0);
    expect((await feedGet(A1)).status).toBe(200);
  });

  it("R3: email+anon contact (canonical key = anon id) — internal re-emit mints no twin, email intact", async () => {
    const created = await pubPost({ name: `${RUN}.ea`, anonymousId: A2 });
    expect(created.status).toBe(202);
    // attach an email via the secret path (publishable can't assert email)
    await ingestEvent({
      db,
      registry,
      hatchet: mockHatchet,
      logger,
      event: {
        event: `${RUN}.ea2`,
        anonymousId: A2,
        userEmail: A2_EMAIL,
        eventProperties: {},
      },
    });
    const [ea] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.anonymousId, A2));
    if (!ea) throw new Error("email+anon contact not created");

    await ingestInternal({ event: `${RUN}.ea3`, userId: A2, contactId: ea.id });
    expect(await rowsWithExternalId(A2)).toHaveLength(0);
    const [after] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, ea.id));
    expect(after?.email).toBe(A2_EMAIL);
    expect(after?.externalId).toBeNull();
  });

  it("R5: a merged-away loser's contactId follows the alias to the live survivor", async () => {
    // Loser: anon-only {anonymous_id:A3}. Survivor: identified {external_id:E3}.
    await ingestEvent({
      db,
      registry,
      hatchet: mockHatchet,
      logger,
      event: { event: `${RUN}.l`, anonymousId: A3, eventProperties: {} },
    });
    const [loser] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.anonymousId, A3));
    if (!loser) throw new Error("loser not created");
    await ingestEvent({
      db,
      registry,
      hatchet: mockHatchet,
      logger,
      event: { event: `${RUN}.s`, userId: E3, eventProperties: {} },
    });
    // Collide-merge (one event naming both keys) → loser soft-deleted, alias
    // from_contact_id=loser.id → survivor.
    await ingestEvent({
      db,
      registry,
      hatchet: mockHatchet,
      logger,
      event: {
        event: `${RUN}.m`,
        userId: E3,
        anonymousId: A3,
        eventProperties: {},
      },
    });

    // Internal re-emit pinned at the (now soft-deleted) loser id → survivor.
    const re = await ingestInternal({
      event: `${RUN}.late`,
      userId: A3,
      contactId: loser.id,
    });
    expect(re.stored).toBe(true);
    expect(re.contactKey).toBe(E3); // followed the alias to the survivor
    // No phantom external_id=A3 twin minted. (A3 itself was ABSORBED onto the
    // survivor by the merge, so a live anonymous_id=A3 row exists — and it is the
    // survivor, carrying external_id=E3 — never a separate identified twin.)
    expect(await rowsWithExternalId(A3)).toHaveLength(0);
    const [a3owner] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.anonymousId, A3), isNull(contacts.deletedAt)));
    expect(a3owner?.externalId).toBe(E3);
  });

  it("R6: provenance lost (hard-deleted/unknown subject) → drop, never mint", async () => {
    const ghostUuid = "99999999-dddd-4ddd-8ddd-999999999999";
    const re = await ingestInternal({
      event: `${RUN}.ghost`,
      userId: "ghost-key",
      contactId: ghostUuid,
    });
    expect(re.stored).toBe(false); // dropped, not stored
    // Nothing minted for either the ghost contactId or the userId.
    const byId = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, ghostUuid));
    expect(byId).toHaveLength(0);
    const byExt = await rowsWithExternalId("ghost-key");
    expect(byExt).toHaveLength(0);
  });

  it("SECURITY: a publishable caller cannot forge contactId via the request body", async () => {
    // POST a publishable event that ALSO carries a (victim-shaped) contactId.
    // The route schema strips it + the handler never reads it, so it must be
    // ignored: the event resolves to the caller's OWN anon contact, and the
    // injected uuid is never pinned/created.
    const injected = "00000000-eeee-4eee-8eee-000000000000";
    const res = await pubPost({
      name: `${RUN}.forge`,
      anonymousId: A1,
      contactId: injected,
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.contactKey).toBe(A1); // own anon contact, NOT the injected id
    const byInjected = await db
      .select()
      .from(contacts)
      .where(eq(contacts.id, injected));
    expect(byInjected).toHaveLength(0); // injected uuid never touched
  });
});
