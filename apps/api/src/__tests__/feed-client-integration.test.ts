import { createHash, createHmac } from "node:crypto";
import { createHogsend, HogsendAPIError } from "@hogsend/js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The feed service (`sendFeedItem`) reads its OWN db singleton off
// `DATABASE_URL`, and the route container reads the same env. Point BOTH at the
// real 5434 test DB (mirrors feed-backend.test.ts) BEFORE importing the engine
// so the singleton + the container hit the same database.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Hatchet is module-mocked: a successful POST /v1/events still stores the event
// + upserts the contact synchronously (what we assert), and the feed mark route
// pushes its `inapp.*` emit through `ingestEvent` → Hatchet too — neither ever
// reaches a live gRPC engine. Journey EXECUTION is a worker concern; here we
// prove the SDK ↔ engine feed WIRING end to end.
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
const { eq, sql } = await import("drizzle-orm");
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

// Same construction `verifyUserToken` expects, keyed by the vitest-injected
// BETTER_AUTH_SECRET: a server-signed token lets the browser-direct pk_ key act
// as the bound userId, which is how `feed()` reads/marks an identified recipient.
const AUTH_SECRET = "test-secret-for-vitest-minimum-32-characters-long";
function mintUserToken(userId: string): string {
  const payload = { userId, exp: Math.floor(Date.now() / 1000) + 3600 };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", AUTH_SECRET)
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}

const ORIGIN = "https://feed-sdk.example.com";
const PK_OK = "pk_feed_sdk_integration_allowed_origin_key";
// Arbitrary engine origin — app.request() routes by pathname; the browser-set
// Origin HEADER (not the URL) is what the publishable gate checks.
const API_BASE = "https://feed-sdk-engine.test";

// Recipient A — an identified contact (externalId). Its canonical recipientKey
// is its externalId, which is what `sendFeedItem` writes under and what a
// userToken for that userId resolves to.
const A_USER = "feed-sdk-recipient-a";
const A_EMAIL = "feed-sdk-recipient-a@example.com";
// Recipient B — a second identified contact; A's client must never see B's items.
const B_USER = "feed-sdk-recipient-b";
const B_EMAIL = "feed-sdk-recipient-b@example.com";

const FEED_ID = "in_app";

/**
 * A `fetch` that faithfully simulates a browser: routes the SDK's request into
 * the in-process Hono app and injects the `Origin` header the browser would add
 * (and which JS cannot set itself). This is the seam that makes the real SDK
 * testable against the real engine with zero network.
 */
function browserFetch(origin: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers(init?.headers);
    headers.set("Origin", origin);
    return app.request(url, { ...init, headers });
  }) as typeof fetch;
}

async function ensureFeedItemsTable() {
  // The feed migration (0034) is intentionally NOT applied via `db:migrate`.
  // Apply ONLY the feed_items DDL here, idempotently, so the suite is
  // self-contained without invoking the migration runner. SQL copied verbatim
  // from drizzle/0034_light_synch.sql (mirrors feed-backend.test.ts).
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
  for (const key of [A_USER, B_USER]) {
    await db.delete(feedItems).where(eq(feedItems.recipientKey, key));
  }
  for (const id of [A_USER, B_USER]) {
    await db.delete(userEvents).where(eq(userEvents.userId, id));
  }
  await db.delete(contacts).where(eq(contacts.externalId, A_USER));
  await db.delete(contacts).where(eq(contacts.externalId, B_USER));
  await db.delete(emailPreferences).where(eq(emailPreferences.userId, A_USER));
  await db.delete(emailPreferences).where(eq(emailPreferences.userId, B_USER));
}

let pkId = "";

beforeAll(async () => {
  await ensureFeedItemsTable();
  await cleanup();

  const [k] = await db
    .insert(apiKeys)
    .values({
      name: "feed sdk publishable",
      keyPrefix: PK_OK.slice(0, 8),
      keyHash: hashKey(PK_OK),
      scopes: ["ingest-public"],
      allowedOrigins: [ORIGIN],
    })
    .returning({ id: apiKeys.id });
  pkId = k?.id ?? "";

  // Identified-user fixtures: externalId + email so the recipient-key resolver
  // resolves A/B from the userToken-bound userId alone.
  await db.insert(contacts).values({ externalId: A_USER, email: A_EMAIL });
  await db.insert(contacts).values({ externalId: B_USER, email: B_EMAIL });
});

afterAll(async () => {
  await cleanup();
  if (pkId) await db.delete(apiKeys).where(eq(apiKeys.id, pkId));
});

function clientForA() {
  return createHogsend({
    apiUrl: API_BASE,
    publishableKey: PK_OK,
    userId: A_USER,
    userToken: mintUserToken(A_USER),
    fetch: browserFetch(ORIGIN),
    // Poll is the working realtime default; we drive fetch() explicitly and
    // never call connect(), so no interval timers leak into the test.
    realtime: "off",
  });
}

// ===========================================================================
// 1. Server send → SDK fetch round-trips the item with correct metadata.
// ===========================================================================
describe("@hogsend/js feed: server send → client fetch", () => {
  it("sendFeedItem({userId}) → feed().fetch() returns that item + correct counts", async () => {
    const sent = await sendFeedItem({
      recipient: { userId: A_USER },
      type: "welcome",
      title: "Welcome aboard",
      body: "Glad you're here",
      actionUrl: "https://app.example.com/start",
    });
    expect(sent.suppressed).toBe(false);
    const sentId = sent.feedItemId as string;
    expect(sentId).toBeTruthy();

    const client = clientForA();
    const res = await client.feed(FEED_ID).fetch();
    client.teardown();

    // The exact item the server sent comes back, fully serialized.
    const item = res.items.find((i) => i.id === sentId);
    expect(item).toBeTruthy();
    expect(item?.type).toBe("welcome");
    expect(item?.title).toBe("Welcome aboard");
    expect(item?.body).toBe("Glad you're here");
    expect(item?.actionUrl).toBe("https://app.example.com/start");
    expect(item?.status).toBe("unseen");

    // Metadata reflects exactly A's rows (one unseen item here).
    expect(res.metadata.total_count).toBe(res.items.length);
    expect(res.metadata.unseen_count).toBe(res.items.length);
    // unread = unseen + seen; all unseen → unread == total.
    expect(res.metadata.unread_count).toBe(res.items.length);
    expect(res.metadata.total_count).toBeGreaterThanOrEqual(1);
  });

  it("fetch() seeds the byId-backed store slice (same data the React hook selects)", async () => {
    const client = clientForA();
    const feed = client.feed(FEED_ID);
    await feed.fetch();
    const slice = client.getSnapshot().feeds?.[FEED_ID];
    client.teardown();

    expect(slice).toBeTruthy();
    // The store slice mirrors the fetched page: order ⊆ byId, counts derived.
    expect(slice?.order.length).toBe(Object.keys(slice?.byId ?? {}).length);
    expect(slice?.metadata.total_count).toBe(slice?.order.length);
    for (const id of slice?.order ?? []) {
      expect(slice?.byId[id]?.id).toBe(id);
    }
  });
});

// ===========================================================================
// 2. SDK markAsRead → status read + ONE inapp.item_read (client/server dedup).
// ===========================================================================
describe("@hogsend/js feed: markAsRead closed loop + dedup", () => {
  it("markAsRead sets status read AND emits exactly one inapp.item_read", async () => {
    // Fresh item for A to mark (deterministic idempotency key on the feed row).
    const sent = await sendFeedItem({
      recipient: { userId: A_USER },
      type: "to-read",
      title: "Read me",
      idempotencyKey: "feed-sdk-to-read-1",
    });
    const itemId = sent.feedItemId as string;
    expect(itemId).toBeTruthy();

    // The shared per-item event idempotency key the SDK AND the server both use.
    const eventIdem = `inapp:${FEED_ID}:${itemId}:inapp.item_read`;
    // Clear any prior emit for a deterministic count.
    await db.delete(userEvents).where(eq(userEvents.idempotencyKey, eventIdem));

    const client = clientForA();
    await client.feed(FEED_ID).markAsRead([itemId]);
    // markAsRead: optimistic patch → POST /v1/feed/mark (server emits) →
    // spine.capture(queued). flush() drains the queued client capture.
    await client.flush();
    client.teardown();

    // (a) the feed row is now read with readAt set.
    const [row] = await db
      .select()
      .from(feedItems)
      .where(eq(feedItems.id, itemId));
    expect(row?.status).toBe("read");
    expect(row?.readAt).not.toBeNull();

    // (b) EXACTLY ONE inapp.item_read user_events row for this item — the
    // server's mark-route emit and the SDK's optimistic capture share the key
    // `inapp:<feedId>:<itemId>:inapp.item_read`, so they collapse on
    // user_events.idempotencyKey (onConflictDoNothing). Never double-fires.
    const evs = await db
      .select()
      .from(userEvents)
      .where(eq(userEvents.idempotencyKey, eventIdem));
    expect(evs).toHaveLength(1);
    expect(evs[0]?.event).toBe("inapp.item_read");
    // Attributed to the recipient (userToken-bound), source "inapp".
    expect(evs[0]?.userId).toBe(A_USER);
    expect(evs[0]?.source).toBe("inapp");
    expect(evs[0]?.properties).toMatchObject({
      feedItemId: itemId,
      feedId: FEED_ID,
    });
  });

  it("the optimistic store patch flips the slice to read BEFORE the network settles", async () => {
    const sent = await sendFeedItem({
      recipient: { userId: A_USER },
      type: "optimistic",
      title: "Optimistic",
      idempotencyKey: "feed-sdk-optimistic-1",
    });
    const itemId = sent.feedItemId as string;

    const client = clientForA();
    const feed = client.feed(FEED_ID);
    await feed.fetch();
    expect(client.getSnapshot().feeds?.[FEED_ID]?.byId[itemId]?.status).toBe(
      "unseen",
    );

    await feed.markAsRead([itemId]);
    await client.flush();
    // Store reflects the optimistic patch (status read, derived unread dropped).
    const slice = client.getSnapshot().feeds?.[FEED_ID];
    client.teardown();
    expect(slice?.byId[itemId]?.status).toBe("read");
    expect(slice?.byId[itemId]?.readAt).not.toBeNull();
  });
});

// ===========================================================================
// 3. Cross-recipient isolation: A's client cannot fetch B's items.
// ===========================================================================
describe("@hogsend/js feed: cross-recipient isolation", () => {
  it("client for A cannot fetch user B's items", async () => {
    // Seed an item for B only.
    const bItem = await sendFeedItem({
      recipient: { userId: B_USER },
      type: "b-secret",
      title: "B only",
    });
    const bItemId = bItem.feedItemId as string;
    expect(bItemId).toBeTruthy();

    // A's userToken-bound client fetches — its feed is scoped to A's recipientKey.
    const client = clientForA();
    const res = await client.feed(FEED_ID).fetch();
    client.teardown();

    expect(res.items.find((i) => i.id === bItemId)).toBeUndefined();
    expect(res.items.find((i) => i.type === "b-secret")).toBeUndefined();

    // B's row remains unseen — A's read never touched it.
    const [bRow] = await db
      .select()
      .from(feedItems)
      .where(eq(feedItems.id, bItemId));
    expect(bRow?.status).toBe("unseen");
  });

  it("a forged userToken is rejected — the SDK surfaces a 403", async () => {
    const valid = mintUserToken(A_USER);
    const [body] = valid.split(".");
    const forgedToken = `${body}.${"x".repeat(43)}`;
    const client = createHogsend({
      apiUrl: API_BASE,
      publishableKey: PK_OK,
      userId: A_USER,
      userToken: forgedToken,
      fetch: browserFetch(ORIGIN),
      realtime: "off",
    });

    const err = await client
      .feed(FEED_ID)
      .fetch()
      .catch((e: unknown) => e);
    client.teardown();
    expect(err).toBeInstanceOf(HogsendAPIError);
    expect((err as HogsendAPIError).status).toBe(403);
  });
});
