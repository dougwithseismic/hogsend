import { createHash } from "node:crypto";
import {
  createHogsend,
  createToastClient,
  type ToastClientOptions,
} from "@hogsend/js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The feed/banner service (`sendBanner` → `sendFeedItem`) reads its OWN db
// singleton off `DATABASE_URL`, and the route container reads the same env.
// Point BOTH at the real 5434 test DB BEFORE importing the engine so the
// singleton + the container hit the same database (mirrors
// feed-client-integration.test.ts).
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Hatchet is module-mocked: a successful POST /v1/events still stores the event
// + upserts the contact synchronously (what we assert), and the feed mark route
// pushes its `inapp.*` emit through `ingestEvent` → Hatchet too — neither ever
// reaches a live gRPC engine. We prove the SDK ↔ engine banner WIRING end to end.
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
const { createApp, createHogsendClient, generateUserToken, sendBanner } =
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

const container = createHogsendClient({
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db } = container;

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// The vitest-injected secret. This is the SAME secret `verifyUserToken` checks
// against, and the SAME one `generateUserToken` must sign with — proving the
// now-exported mint helper produces a token the engine accepts (replacing the
// earlier suite's hand-rolled HMAC re-implementation).
const AUTH_SECRET = "test-secret-for-vitest-minimum-32-characters-long";

const ORIGIN = "https://banner-sdk.example.com";
const PK_OK = "pk_banner_sdk_integration_allowed_origin_key";
// Arbitrary engine origin — app.request() routes by pathname; the browser-set
// Origin HEADER (not the URL) is what the publishable gate checks.
const API_BASE = "https://banner-sdk-engine.test";

// Recipient A — an identified contact (externalId). Its canonical recipientKey
// is its externalId, which is what `sendBanner` writes under and what a
// userToken for that userId resolves to.
const A_USER = "banner-sdk-recipient-a";
const A_EMAIL = "banner-sdk-recipient-a@example.com";
// Recipient B — a second identified contact; A's client must never see B's items.
const B_USER = "banner-sdk-recipient-b";
const B_EMAIL = "banner-sdk-recipient-b@example.com";

const SLOT = "top";

/**
 * A `fetch` that faithfully simulates a browser: routes the SDK's request into
 * the in-process Hono app and injects the `Origin` header the browser would add
 * (and which JS cannot set itself). The seam that makes the real SDK testable
 * against the real engine with zero network.
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
      name: "banner sdk publishable",
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

/**
 * Build a client for recipient A whose `userToken` is minted by the
 * NOW-EXPORTED `generateUserToken` server helper (not a hand-rolled HMAC). If
 * the engine accepts the resulting feed reads/marks, the mint↔verify roundtrip
 * is proven end to end.
 */
function clientForA() {
  return createHogsend({
    apiUrl: API_BASE,
    publishableKey: PK_OK,
    userId: A_USER,
    userToken: generateUserToken({ secret: AUTH_SECRET, userId: A_USER }),
    fetch: browserFetch(ORIGIN),
    // Poll is the working realtime default; we drive fetch() explicitly and
    // never call connect(), so no interval timers leak into the test.
    realtime: "off",
  });
}

// ===========================================================================
// 1. userToken mint roundtrip — the exported `generateUserToken` produces a
//    token the engine's verify path ACCEPTS, authorizing an identified read.
// ===========================================================================
describe("@hogsend/engine generateUserToken: mint ↔ verify roundtrip", () => {
  it("a generateUserToken-minted token authorizes an identified feed read (gate passes)", async () => {
    // A banner for A, read back through a client driven by a minted token.
    const sent = await sendBanner({
      recipient: { userId: A_USER },
      slot: SLOT,
      title: "Minted-token banner",
    });
    expect(sent.suppressed).toBe(false);
    const sentId = sent.feedItemId as string;
    expect(sentId).toBeTruthy();

    const client = clientForA();
    // A feed read on the banner category — the publishable key alone is
    // anon-only; only a VALID userToken scopes this to A's recipientKey. If the
    // mint helper's signature didn't verify, this would 403.
    const res = await client.feed(`banner:${SLOT}`).fetch();
    client.teardown();

    const item = res.items.find((i) => i.id === sentId);
    expect(item).toBeTruthy();
    expect(item?.title).toBe("Minted-token banner");
    expect(item?.type).toBe("banner");
  });

  it("a token minted for B does NOT authorize reading A's recipientKey (scoping holds, not just signature)", async () => {
    // A's banner exists; a client identified as B (B's own minted token) must
    // not see it — proves the token binds a SPECIFIC userId, not just "any
    // valid signature unlocks any recipient".
    const aBanner = await sendBanner({
      recipient: { userId: A_USER },
      slot: SLOT,
      title: "A's private banner",
    });
    const aId = aBanner.feedItemId as string;

    const clientB = createHogsend({
      apiUrl: API_BASE,
      publishableKey: PK_OK,
      userId: B_USER,
      userToken: generateUserToken({ secret: AUTH_SECRET, userId: B_USER }),
      fetch: browserFetch(ORIGIN),
      realtime: "off",
    });
    const res = await clientB.feed(`banner:${SLOT}`).fetch();
    clientB.teardown();

    expect(res.items.find((i) => i.id === aId)).toBeUndefined();
  });
});

// ===========================================================================
// 2. Banner loop — server sendBanner → client.banners(slot).list()/current()
//    returns it → dismiss persists (archived) + emits banner.dismissed →
//    re-list/current no longer surfaces it. Plus cross-recipient isolation.
// ===========================================================================
describe("@hogsend/js banners: server send → list/current → dismiss loop", () => {
  it("sendBanner({userId,slot}) → banners(slot).list()/current() returns it", async () => {
    const sent = await sendBanner({
      recipient: { userId: A_USER },
      slot: SLOT,
      title: "List me",
      body: "Visible banner body",
      actionUrl: "https://app.example.com/cta",
    });
    const sentId = sent.feedItemId as string;
    expect(sentId).toBeTruthy();

    const client = clientForA();
    const banner = client.banners(SLOT);

    const listed = await banner.list();
    const fromList = listed.find((b) => b.id === sentId);
    expect(fromList).toBeTruthy();
    expect(fromList?.slot).toBe(SLOT);
    expect(fromList?.title).toBe("List me");
    expect(fromList?.body).toBe("Visible banner body");
    expect(fromList?.actionUrl).toBe("https://app.example.com/cta");
    expect(fromList?.dismissed).toBe(false);

    // `current()` surfaces a non-dismissed banner (this id is present + live).
    const cur = await banner.current();
    client.teardown();
    expect(cur).toBeTruthy();
    expect([sentId]).toContain(cur?.id);
    expect(cur?.dismissed).toBe(false);
  });

  it("dismiss(id) archives the feed row, emits banner.dismissed, and current() stops surfacing it", async () => {
    // Fresh banner with a deterministic feed idempotency key.
    const sent = await sendBanner({
      recipient: { userId: A_USER },
      slot: SLOT,
      title: "Dismiss me",
      idempotencyKey: "banner-sdk-dismiss-1",
    });
    const bannerId = sent.feedItemId as string;
    expect(bannerId).toBeTruthy();

    // Clean any prior banner.dismissed rows for a deterministic assertion.
    await db.delete(userEvents).where(eq(userEvents.event, "banner.dismissed"));

    const client = clientForA();
    const banner = client.banners(SLOT);

    // Confirm it's live before dismissing.
    const beforeCur = await banner.current();
    expect(beforeCur?.id ?? (await banner.list())[0]?.id).toBeTruthy();

    await banner.dismiss(bannerId);
    // dismiss(): optimistic patch → POST /v1/feed/mark (archived) →
    // spine.capture("banner.dismissed") queued. flush() drains the queue.
    await client.flush();

    // (a) the feed row is now archived with archivedAt set.
    const [row] = await db
      .select()
      .from(feedItems)
      .where(eq(feedItems.id, bannerId));
    expect(row?.status).toBe("archived");
    expect(row?.archivedAt).not.toBeNull();

    // (b) a banner.dismissed user_events row exists — the DISTINCT-namespace
    // consumer-facing journey trigger (NOT inapp.item_archived).
    const dismissedEvents = await db
      .select()
      .from(userEvents)
      .where(eq(userEvents.event, "banner.dismissed"));
    const ours = dismissedEvents.find(
      (e) =>
        (e.properties as Record<string, unknown> | null)?.bannerId === bannerId,
    );
    expect(ours).toBeTruthy();
    expect(ours?.userId).toBe(A_USER);
    expect(ours?.source).toBe("inapp");
    expect(ours?.properties).toMatchObject({ slot: SLOT, bannerId });

    // (c) the internal feed-state emit (inapp.item_archived) is a SEPARATE
    // event under a SEPARATE name — the two never collapse into each other.
    const archiveEvents = await db
      .select()
      .from(userEvents)
      .where(eq(userEvents.event, "inapp.item_archived"));
    expect(
      archiveEvents.some(
        (e) =>
          (e.properties as Record<string, unknown> | null)?.feedItemId ===
          bannerId,
      ),
    ).toBe(true);

    // (d) a re-list reflects the dismissal (status archived → dismissed:true)
    // and `current()` no longer surfaces it.
    const relisted = await banner.list();
    const stillThere = relisted.find((b) => b.id === bannerId);
    expect(stillThere?.dismissed).toBe(true);
    const curAfter = await banner.current();
    client.teardown();
    expect(curAfter?.id).not.toBe(bannerId);
  });

  it("client for A cannot list user B's banners (cross-recipient isolation)", async () => {
    const bBanner = await sendBanner({
      recipient: { userId: B_USER },
      slot: SLOT,
      title: "B-only banner",
    });
    const bId = bBanner.feedItemId as string;
    expect(bId).toBeTruthy();

    const client = clientForA();
    const listed = await client.banners(SLOT).list();
    client.teardown();

    expect(listed.find((b) => b.id === bId)).toBeUndefined();
    expect(listed.find((b) => b.title === "B-only banner")).toBeUndefined();

    // B's row remains unseen — A's reads/dismisses never touched it.
    const [bRow] = await db
      .select()
      .from(feedItems)
      .where(eq(feedItems.id, bId));
    expect(bRow?.status).toBe("unseen");
  });
});

// ===========================================================================
// 3. Toast store — ephemeral, client-side only. A focused unit test over the
//    exported `createToastClient` (no network): show/dismiss/click mutate the
//    subscribable snapshot + fire inapp.toast_* through the spine.
// ===========================================================================
describe("@hogsend/js toasts: ephemeral store unit", () => {
  function stubSpine() {
    const captured: Array<{
      event: string;
      properties?: Record<string, unknown>;
    }> = [];
    const spine: ToastClientOptions["spine"] = {
      capture: async (event, properties) => {
        captured.push({ event, properties });
        return { stored: true, contactKey: "stub" };
      },
      flush: async () => {},
      teardown: () => {},
    };
    return { spine, captured };
  }

  it("show() adds a toast, snapshot is stable, and emits inapp.toast_shown", () => {
    const { spine, captured } = stubSpine();
    const toasts = createToastClient({ spine });

    const before = toasts.getSnapshot();
    const id = toasts.show({
      type: "toast",
      title: "Saved",
      body: "Your changes are saved",
      actionUrl: null,
      metadata: null,
    });

    const after = toasts.getSnapshot();
    // Snapshot ref changed on mutation; the new one carries the toast.
    expect(after).not.toBe(before);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(id);
    expect(after[0]?.title).toBe("Saved");

    // A no-op read returns the SAME ref (useSyncExternalStore correctness).
    expect(toasts.getSnapshot()).toBe(after);

    expect(captured).toContainEqual({
      event: "inapp.toast_shown",
      properties: { toastId: id, type: "toast" },
    });
    toasts.teardown();
  });

  it("subscribe fires on change; dismiss removes the toast + emits inapp.toast_dismissed", () => {
    const { spine, captured } = stubSpine();
    const toasts = createToastClient({ spine });

    let notifications = 0;
    const unsub = toasts.subscribe(() => {
      notifications += 1;
    });

    const id = toasts.show({
      type: "toast",
      title: "Hi",
      body: null,
      actionUrl: null,
      metadata: null,
    });
    expect(notifications).toBe(1);
    expect(toasts.getSnapshot()).toHaveLength(1);

    toasts.dismiss(id);
    expect(notifications).toBe(2);
    expect(toasts.getSnapshot()).toHaveLength(0);
    expect(captured.map((c) => c.event)).toContain("inapp.toast_dismissed");

    unsub();
    toasts.teardown();
  });

  it("click() emits inapp.toast_clicked with the actionUrl but leaves the toast in place", () => {
    const { spine, captured } = stubSpine();
    const toasts = createToastClient({ spine });

    const id = toasts.show({
      type: "toast",
      title: "Clickable",
      body: null,
      actionUrl: "https://app.example.com/go",
      metadata: null,
    });
    toasts.click(id);

    expect(toasts.getSnapshot()).toHaveLength(1);
    expect(captured).toContainEqual({
      event: "inapp.toast_clicked",
      properties: { toastId: id, actionUrl: "https://app.example.com/go" },
    });
    toasts.teardown();
  });

  it("a duration auto-dismisses the toast via the timer", () => {
    vi.useFakeTimers();
    try {
      const { spine, captured } = stubSpine();
      const toasts = createToastClient({ spine });

      toasts.show({
        type: "toast",
        title: "Transient",
        body: null,
        actionUrl: null,
        metadata: null,
        duration: 1000,
      });
      expect(toasts.getSnapshot()).toHaveLength(1);

      vi.advanceTimersByTime(1001);
      // The auto-dismiss timer removed it (no inapp.toast_dismissed — it was a
      // silent timer expiry, not a user dismiss).
      expect(toasts.getSnapshot()).toHaveLength(0);
      expect(captured.map((c) => c.event)).not.toContain(
        "inapp.toast_dismissed",
      );
      toasts.teardown();
    } finally {
      vi.useRealTimers();
    }
  });
});
