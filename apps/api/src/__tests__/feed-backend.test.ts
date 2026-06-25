import { createHash, createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The feed service (`sendFeedItem`) reads its OWN db singleton off
// `DATABASE_URL`, and the route container reads the same env. Point BOTH at the
// real 5434 test DB (mirrors publishable-key.test.ts) BEFORE importing the
// engine so the singleton + the container hit the same database.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Hatchet is module-mocked so a successful ingest (the mark routes push through
// `ingestEvent` → Hatchet) never reaches a live gRPC engine.
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

const { apiKeys, contacts, emailPreferences, feedItems, userEvents } =
  await import("@hogsend/db");
const { and, eq, sql } = await import("drizzle-orm");
const { createApp, createHogsendClient, sendFeedItem } = await import(
  "@hogsend/engine"
);

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

const container = createHogsendClient({
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db } = container;

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// Mint a userToken with the SAME construction `verifyUserToken` expects, keyed
// by the vitest-injected BETTER_AUTH_SECRET.
const AUTH_SECRET = "test-secret-for-vitest-minimum-32-characters-long";
function mintUserToken(userId: string, expEpochSeconds?: number): string {
  const payload = {
    userId,
    exp: expEpochSeconds ?? Math.floor(Date.now() / 1000) + 3600,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", AUTH_SECRET)
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}

const ORIGIN = "https://app.example.com";

// A publishable (pk_) key WITH a matching Origin allowlist.
const PK_OK = "pk_feed_publishable_allowed_origin_key";
// A secret ingest key.
const INGEST_KEY = "hsk_feed_ingest_key";

let pkOkId = "";
let ingestId = "";

// ---- Recipient fixtures ----
// Recipient A — an identified contact (externalId). Its canonical recipientKey
// is its externalId, which is what `sendFeedItem` writes under and what a
// userToken for that userId resolves to.
const A_USER = "feed-recipient-a";
// Recipient B — a second identified contact; A must never see/mutate B's items.
const B_USER = "feed-recipient-b";
// An anonymous recipient (no contact, raw anon id IS the recipientKey).
const ANON_ID = "feed-anon-recipient-id";
// A suppressed recipient (unsubscribed from "in_app").
const SUPP_USER = "feed-suppressed-user";
const SUPP_EMAIL = "feed-suppressed@example.com";

async function ensureFeedItemsTable() {
  // The feed migration (0034) is intentionally NOT applied via `db:migrate`
  // (per task constraint). Apply ONLY the feed_items DDL here, idempotently, so
  // the suite is self-contained without invoking the migration runner. SQL is
  // copied verbatim from drizzle/0034_light_synch.sql.
  await db.execute(sql`
    DO $$ BEGIN
      CREATE TYPE "public"."feed_item_status" AS ENUM('unseen', 'seen', 'read', 'archived');
    EXCEPTION WHEN duplicate_object THEN null; END $$;
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "feed_items" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "recipient_key" text NOT NULL,
      "contact_id" uuid,
      "type" text NOT NULL,
      "title" text,
      "body" text,
      "blocks" jsonb,
      "action_url" text,
      "metadata" jsonb,
      "journey_state_id" uuid,
      "template_key" text,
      "category" text DEFAULT 'in_app' NOT NULL,
      "status" "feed_item_status" DEFAULT 'unseen' NOT NULL,
      "seen_at" timestamp with time zone,
      "read_at" timestamp with time zone,
      "archived_at" timestamp with time zone,
      "idempotency_key" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "feed_items_recipient_created_idx" ON "feed_items" USING btree ("recipient_key","created_at");`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "feed_items_recipient_status_idx" ON "feed_items" USING btree ("recipient_key","status");`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "feed_items_contact_idx" ON "feed_items" USING btree ("contact_id");`,
  );
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS "feed_items_idempotency_key_idx" ON "feed_items" USING btree ("idempotency_key");`,
  );
}

async function cleanup() {
  for (const key of [A_USER, B_USER, ANON_ID, SUPP_USER, SUPP_EMAIL]) {
    await db.delete(feedItems).where(eq(feedItems.recipientKey, key));
  }
  for (const id of [A_USER, B_USER, ANON_ID, SUPP_USER, "inapp.item_read"]) {
    await db.delete(userEvents).where(eq(userEvents.userId, id));
  }
  await db.delete(contacts).where(eq(contacts.externalId, A_USER));
  await db.delete(contacts).where(eq(contacts.externalId, B_USER));
  await db.delete(contacts).where(eq(contacts.externalId, SUPP_USER));
  await db.delete(contacts).where(eq(contacts.email, SUPP_EMAIL));
  // The anon mark route ingests `inapp.*` keyed on the recipientKey (the anon
  // id) as a `userId`, which mints an `external_id = ANON_ID` contact. Clear it
  // so the next run's anon GET isn't rejected as colliding with an identified
  // contact (the cross-recipient impersonation guard).
  await db.delete(contacts).where(eq(contacts.externalId, ANON_ID));
  await db.delete(contacts).where(eq(contacts.anonymousId, ANON_ID));
  await db
    .delete(emailPreferences)
    .where(eq(emailPreferences.userId, SUPP_USER));
}

beforeAll(async () => {
  await ensureFeedItemsTable();
  await cleanup();

  const [a] = await db
    .insert(apiKeys)
    .values({
      name: "feed pub allowed",
      keyPrefix: PK_OK.slice(0, 8),
      keyHash: hashKey(PK_OK),
      scopes: ["ingest-public"],
      allowedOrigins: [ORIGIN],
    })
    .returning({ id: apiKeys.id });
  pkOkId = a?.id ?? "";

  const [c] = await db
    .insert(apiKeys)
    .values({
      name: "feed secret ingest",
      keyPrefix: INGEST_KEY.slice(0, 8),
      keyHash: hashKey(INGEST_KEY),
      scopes: ["ingest"],
    })
    .returning({ id: apiKeys.id });
  ingestId = c?.id ?? "";

  // Suppressed recipient: an identified contact (needs an email for the
  // suppression resolver) unsubscribed from the reserved "in_app" list.
  await db.insert(contacts).values({
    externalId: SUPP_USER,
    email: SUPP_EMAIL,
  });
  await db.insert(emailPreferences).values({
    userId: SUPP_USER,
    email: SUPP_EMAIL,
    unsubscribedAll: false,
    categories: { in_app: false },
  });
});

afterAll(async () => {
  await cleanup();
  if (pkOkId) await db.delete(apiKeys).where(eq(apiKeys.id, pkOkId));
  if (ingestId) await db.delete(apiKeys).where(eq(apiKeys.id, ingestId));
});

function authedGet(path: string) {
  return app.request(path, {
    method: "GET",
    headers: { Authorization: `Bearer ${PK_OK}`, Origin: ORIGIN },
  });
}
function authedPost(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PK_OK}`,
      Origin: ORIGIN,
    },
    body: JSON.stringify(body),
  });
}

// ===========================================================================
// 1. sendFeedItem inserts a row; idempotency key dedups a second call.
// ===========================================================================
describe("sendFeedItem service", () => {
  it("inserts a feed_items row for a recipient", async () => {
    const res = await sendFeedItem({
      recipient: { userId: A_USER },
      type: "welcome",
      title: "Hello",
      body: "Welcome aboard",
      actionUrl: "https://app.example.com/x",
    });

    expect(res.suppressed).toBe(false);
    expect(res.feedItemId).toBeTruthy();
    expect(res.recipientKey).toBe(A_USER);

    const rows = await db
      .select()
      .from(feedItems)
      .where(eq(feedItems.recipientKey, A_USER));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("welcome");
    expect(rows[0]?.title).toBe("Hello");
    expect(rows[0]?.status).toBe("unseen");
  });

  it("a second call with the SAME idempotencyKey does NOT double-insert", async () => {
    const opts = {
      recipient: { userId: A_USER },
      type: "promo",
      title: "Promo",
      idempotencyKey: "feed-idem-promo-1",
    };
    const first = await sendFeedItem(opts);
    expect(first.feedItemId).toBeTruthy();

    const second = await sendFeedItem(opts);
    // The conflicting insert is absorbed (Layer 2 onConflictDoNothing) — no row,
    // no double publish.
    expect(second.feedItemId).toBeNull();
    expect(second.suppressed).toBe(false);

    const rows = await db
      .select()
      .from(feedItems)
      .where(
        and(
          eq(feedItems.recipientKey, A_USER),
          eq(feedItems.idempotencyKey, "feed-idem-promo-1"),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});

// ===========================================================================
// 6. "in_app" suppression — a recipient unsubscribed from "in_app" gets no row.
// ===========================================================================
describe('sendFeedItem "in_app" suppression', () => {
  it("does not insert a row for a recipient unsubscribed from in_app", async () => {
    const res = await sendFeedItem({
      recipient: { userId: SUPP_USER, email: SUPP_EMAIL },
      type: "should-not-land",
      title: "Blocked",
    });
    expect(res.suppressed).toBe(true);
    expect(res.feedItemId).toBeNull();

    const rows = await db
      .select()
      .from(feedItems)
      .where(eq(feedItems.recipientKey, SUPP_USER));
    expect(rows).toHaveLength(0);
  });
});

// ===========================================================================
// 2. GET /v1/feed (pk_ + userToken) returns ONLY that recipient's items +
//    correct metadata counts.
// ===========================================================================
describe("GET /v1/feed (identified recipient)", () => {
  it("returns only the recipient's items + correct metadata", async () => {
    // A already has the "welcome" + "promo" rows from above (both unseen).
    const token = mintUserToken(A_USER);
    const res = await authedGet(
      `/v1/feed?userToken=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: string; type: string; status: string }>;
      pageInfo: { hasNextPage: boolean };
      metadata: {
        total_count: number;
        unseen_count: number;
        unread_count: number;
      };
    };

    // Every returned item belongs to A (recipient-scoped query).
    expect(body.items.length).toBeGreaterThanOrEqual(2);
    const types = body.items.map((i) => i.type).sort();
    expect(types).toContain("welcome");
    expect(types).toContain("promo");

    // Two unseen rows for A → counts reflect exactly A's rows.
    expect(body.metadata.total_count).toBe(body.items.length);
    expect(body.metadata.unseen_count).toBe(body.items.length);
    // unread = unseen + seen; all unseen here.
    expect(body.metadata.unread_count).toBe(body.items.length);
  });

  it("rejects an invalid userToken → 403", async () => {
    const valid = mintUserToken(A_USER);
    const [body] = valid.split(".");
    const forged = `${body}.${"x".repeat(43)}`;
    const res = await authedGet(
      `/v1/feed?userToken=${encodeURIComponent(forged)}`,
    );
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// 3. CROSS-RECIPIENT ISOLATION (critical).
// ===========================================================================
describe("cross-recipient isolation", () => {
  it("A cannot see B's items, and cannot mark B's item ids", async () => {
    // Seed one item for B.
    const bItem = await sendFeedItem({
      recipient: { userId: B_USER },
      type: "b-secret",
      title: "B only",
    });
    expect(bItem.feedItemId).toBeTruthy();
    const bItemId = bItem.feedItemId as string;

    // A reads its feed (token-bound to A) — B's item must not appear.
    const aToken = mintUserToken(A_USER);
    const aFeed = await authedGet(
      `/v1/feed?userToken=${encodeURIComponent(aToken)}`,
    );
    const aBody = (await aFeed.json()) as {
      items: Array<{ id: string; type: string }>;
    };
    expect(aBody.items.find((i) => i.id === bItemId)).toBeUndefined();
    expect(aBody.items.find((i) => i.type === "b-secret")).toBeUndefined();

    // A attempts to mark B's item id as read. The WHERE recipientKey = A scope
    // intersects to ZERO rows — nothing updated, B's row untouched.
    const mark = await authedPost("/v1/feed/mark", {
      ids: [bItemId],
      state: "read",
      userToken: aToken,
    });
    expect(mark.status).toBe(200);
    const markBody = (await mark.json()) as { updated: number };
    expect(markBody.updated).toBe(0);

    // B's row is still unseen — never mutated by A.
    const [bRow] = await db
      .select()
      .from(feedItems)
      .where(eq(feedItems.id, bItemId));
    expect(bRow?.status).toBe("unseen");
    expect(bRow?.readAt).toBeNull();
  });

  it("a token-less pk_ caller CANNOT impersonate an identified contact via anonymousId", async () => {
    // Seed one item for the identified recipient B (stored under B's externalId
    // canonical key).
    const bItem = await sendFeedItem({
      recipient: { userId: B_USER },
      type: "b-private-exploit",
      title: "B only",
    });
    expect(bItem.feedItemId).toBeTruthy();
    const bItemId = bItem.feedItemId as string;

    // A publishable (token-less) caller passes B's externalId AS anonymousId.
    // Because `sendFeedItem` keys an identified recipient's rows on its
    // external_id, the raw-anon-id path would otherwise read/mutate B's feed.
    // The resolver must reject the collision with an identified contact → 403.
    const leakRead = await authedGet(
      `/v1/feed?anonymousId=${encodeURIComponent(B_USER)}`,
    );
    expect(leakRead.status).toBe(403);

    const leakMark = await authedPost("/v1/feed/mark", {
      ids: [bItemId],
      state: "archived",
      anonymousId: B_USER,
    });
    expect(leakMark.status).toBe(403);

    // B's row is untouched.
    const [bRow] = await db
      .select()
      .from(feedItems)
      .where(eq(feedItems.id, bItemId));
    expect(bRow?.status).toBe("unseen");
    expect(bRow?.archivedAt).toBeNull();
  });
});

// ===========================================================================
// 4. POST /v1/feed/mark sets status + *At AND emits inapp.* server-side;
//    a duplicate mark with the same idempotency key does not double-emit.
// ===========================================================================
describe("POST /v1/feed/mark", () => {
  it("sets status + readAt and emits a single inapp.item_read user_event", async () => {
    // Fresh item for A to mark.
    const item = await sendFeedItem({
      recipient: { userId: A_USER },
      type: "to-read",
      title: "Read me",
      idempotencyKey: "feed-idem-to-read-1",
    });
    const itemId = item.feedItemId as string;
    expect(itemId).toBeTruthy();

    const token = mintUserToken(A_USER);
    const eventIdem = `inapp:in_app:${itemId}:inapp.item_read`;

    // Clean any prior emit for a deterministic count.
    await db.delete(userEvents).where(eq(userEvents.idempotencyKey, eventIdem));

    const res = await authedPost("/v1/feed/mark", {
      ids: [itemId],
      state: "read",
      userToken: token,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { updated: number }).updated).toBe(1);

    // Row status + readAt set.
    const [row] = await db
      .select()
      .from(feedItems)
      .where(eq(feedItems.id, itemId));
    expect(row?.status).toBe("read");
    expect(row?.readAt).not.toBeNull();

    // The inapp.item_read event was emitted server-side (recipient-keyed).
    const evs = await db
      .select()
      .from(userEvents)
      .where(eq(userEvents.idempotencyKey, eventIdem));
    expect(evs).toHaveLength(1);
    expect(evs[0]?.event).toBe("inapp.item_read");
    expect(evs[0]?.userId).toBe(A_USER);

    // A SECOND mark with the same item → same idempotencyKey → the client's
    // optimistic capture and this server emit DEDUP. No second user_events row.
    const res2 = await authedPost("/v1/feed/mark", {
      ids: [itemId],
      state: "read",
      userToken: token,
    });
    expect(res2.status).toBe(200);
    const evs2 = await db
      .select()
      .from(userEvents)
      .where(eq(userEvents.idempotencyKey, eventIdem));
    expect(evs2).toHaveLength(1);
  });
});

// ===========================================================================
// 5. Anon recipient can read/mark its OWN anon feed; no identity → 400.
// ===========================================================================
describe("anonymous recipient", () => {
  it("can read and mark its own anon feed (anonymousId, no token)", async () => {
    const item = await sendFeedItem({
      recipient: { anonymousId: ANON_ID },
      type: "anon-item",
      title: "For anon",
    });
    expect(item.feedItemId).toBeTruthy();
    expect(item.recipientKey).toBe(ANON_ID);

    // Read its own anon feed — raw anonymousId IS the recipientKey.
    const feed = await authedGet(`/v1/feed?anonymousId=${ANON_ID}`);
    expect(feed.status).toBe(200);
    const body = (await feed.json()) as {
      items: Array<{ id: string; type: string }>;
      metadata: { total_count: number };
    };
    expect(body.items.find((i) => i.type === "anon-item")).toBeTruthy();
    expect(body.metadata.total_count).toBe(body.items.length);

    // Mark its own anon item.
    const mark = await authedPost("/v1/feed/mark", {
      ids: [item.feedItemId],
      state: "seen",
      anonymousId: ANON_ID,
    });
    expect(mark.status).toBe(200);
    expect(((await mark.json()) as { updated: number }).updated).toBe(1);

    const [row] = await db
      .select()
      .from(feedItems)
      .where(eq(feedItems.id, item.feedItemId as string));
    expect(row?.status).toBe("seen");
    expect(row?.seenAt).not.toBeNull();
  });

  it("rejects a request with NO identity → 400 (fail-closed)", async () => {
    const res = await authedGet("/v1/feed");
    expect(res.status).toBe(400);

    const markRes = await authedPost("/v1/feed/mark", {
      ids: ["00000000-0000-0000-0000-000000000000"],
      state: "read",
    });
    expect(markRes.status).toBe(400);
  });
});
