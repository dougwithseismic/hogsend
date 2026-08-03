import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// DB-touching test. The DEFAULT below is the repo-wide one every file in this
// directory shares, and it is what CI's service container listens on. Point a
// worktree at its own stack by exporting HOGSEND_TEST_DATABASE_URL — never by
// editing the default.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// The mark routes AWAIT `ingestEvent`, whose Hatchet push failure triggers the
// compensating delete of the just-claimed `user_events` row — so the
// CONTAINER's hatchet has to be mocked, not just apps/api's module-level one.
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

const { apiKeys, contacts, userEvents } = await import("@hogsend/db");
const { and, eq, like, or } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");
type HogsendClient = ReturnType<typeof createHogsendClient>;

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

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const app = createApp(container);
const { db } = container;

// RUN-namespaced so the shared dev DB never collides across files (or across
// two consecutive runs of THIS file) and the afterAll cleanup is precise.
const RUN = `t3feed-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const PK_KEY = `pk_test_${RUN}_publishable`;
const ORIGIN = "https://app.example.com";
const PK_HEADERS = {
  Authorization: `Bearer ${PK_KEY}`,
  "Content-Type": "application/json",
  Origin: ORIGIN,
};

// The UNSEEN visitor: this anon id has never produced a feed item, an event,
// or a contact row anywhere in this database.
const ANON = `${RUN}-unseen-anon`;

// RUN-namespaced feedId. The mark-all-read emit's dedup key is
// `inapp:${feedId}:all:inapp.feed_cleared` — NO recipient component — against
// a GLOBALLY unique `user_events.idempotency_key` index, so on the shared
// default feedId ("in_app") "was the event stored?" is a race against every
// other suite in this database. Namespacing the feedId moves this file onto a
// dedup key nobody else can have claimed.
const FEED_ID = `${RUN}-bell`;

const hashKey = (raw: string) => createHash("sha256").update(raw).digest("hex");

let pkKeyId: string | undefined;

beforeAll(async () => {
  const [pkRow] = await db
    .insert(apiKeys)
    .values({
      name: `${RUN} publishable`,
      keyPrefix: PK_KEY.slice(0, 8),
      keyHash: hashKey(PK_KEY),
      scopes: ["ingest-public"],
      allowedOrigins: [ORIGIN],
    })
    .returning({ id: apiKeys.id });
  pkKeyId = pkRow?.id;
});

afterAll(async () => {
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  // All three identity columns: a regression that mints the ghost stamps
  // `external_id` (the re-ingest presents the anon id as a `userId`), a
  // different regression could mint under `anonymous_id`/`email`.
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.anonymousId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.email, `${RUN}-%`));
  if (pkKeyId) await db.delete(apiKeys).where(eq(apiKeys.id, pkKeyId));
});

/**
 * COUNT of live contact rows holding this run's anon id under ANY identity
 * column — namespace-scoped, never a whole-table count (a shared database
 * makes whole-table assertions certify other suites' leftovers, not this
 * code).
 */
async function anonContactRowCount(): Promise<number> {
  const rows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      or(
        eq(contacts.externalId, ANON),
        eq(contacts.anonymousId, ANON),
        eq(contacts.email, ANON),
      ),
    );
  return rows.length;
}

/** This run's stored `inapp.feed_cleared` rows for the anon visitor. */
async function clearedEventRows() {
  return db
    .select({ id: userEvents.id, idempotencyKey: userEvents.idempotencyKey })
    .from(userEvents)
    .where(
      and(
        eq(userEvents.userId, ANON),
        eq(userEvents.event, "inapp.feed_cleared"),
      ),
    );
}

// ===========================================================================
// PRD 06 T3 — the L4 trap made executable.
//
// `/v1/feed/mark-all` for a publishable anonymous visitor drives an
// ENGINE-INTERNAL re-ingest whose `userId` is the raw browser anon id (an
// `anonymous`-valued string under the `external` kind). The policy that
// re-ingest declares must describe the RESOLVER's caller (the engine, full
// trust) and inherit ONLY the D1 `create` refusal from the HTTP request —
// wiring `allowMerge`/`trustedKinds` to the pk_ HTTP caller instead breaks
// every anon bell mark/clear the moment T5 arms enforcement, in a way no
// resolver unit test can see. Asserted on ROW COUNTS so a "skip the ingest
// entirely" implementation (the route swallows a throwing resolve via
// `.catch(() => {})`, so a bare 200 proves nothing) cannot pass.
// ===========================================================================
describe("feed mark-all — unseen publishable anon visitor (PRD 06 L4)", () => {
  it("returns 200, stores inapp.feed_cleared, and mints zero contacts", async () => {
    // Preconditions as counts: this namespace starts empty on every table the
    // assertions below read, so the post-counts are attributable to THIS call.
    expect(await anonContactRowCount()).toBe(0);
    const priorEvents = await db
      .select({ id: userEvents.id })
      .from(userEvents)
      .where(eq(userEvents.userId, ANON));
    expect(priorEvents).toHaveLength(0);

    const res = await app.request("/v1/feed/mark-all", {
      method: "POST",
      headers: PK_HEADERS,
      body: JSON.stringify({
        state: "read",
        feedId: FEED_ID,
        anonymousId: ANON,
      }),
    });
    expect(res.status).toBe(200);
    // Truly UNSEEN: the visitor never held an item, so nothing matched — the
    // `inapp.feed_cleared` emit below fires UNCONDITIONALLY all the same.
    expect((await res.json()).updated).toBe(0);

    // The ingest was NOT skipped: exactly ONE namespaced `inapp.feed_cleared`
    // row stored for this visitor (D2 — a refused resolve loses no
    // observation), carrying this run's dedup key.
    const cleared = await clearedEventRows();
    expect(cleared).toHaveLength(1);
    expect(cleared[0]?.idempotencyKey).toBe(
      `inapp:${FEED_ID}:all:inapp.feed_cleared`,
    );

    // …and the inherited D1 refusal held: ZERO contact rows own this anon id
    // under any identity column. A re-ingest that stopped inheriting
    // `create: "refuse-on-miss"` mints `external_id = <anon id>` here — the
    // ghost that then trips `collidesWithIdentified` and 403-locks the
    // visitor out of their own bell.
    expect(await anonContactRowCount()).toBe(0);
  });

  it("a repeat clear dedups to the same single event and still mints nothing", async () => {
    const again = await app.request("/v1/feed/mark-all", {
      method: "POST",
      headers: PK_HEADERS,
      body: JSON.stringify({
        state: "read",
        feedId: FEED_ID,
        anonymousId: ANON,
      }),
    });
    expect(again.status).toBe(200);
    expect((await again.json()).updated).toBe(0);

    // Same dedup key ⇒ absorbed by the unique index: still exactly one row.
    expect(await clearedEventRows()).toHaveLength(1);
    expect(await anonContactRowCount()).toBe(0);
  });
});
