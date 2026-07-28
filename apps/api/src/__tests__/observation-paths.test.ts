import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// DB-touching test. The DEFAULT below is the repo-wide one every file in this
// directory shares, and it is what CI's service container listens on. Point a
// worktree at its own stack by exporting HOGSEND_TEST_DATABASE_URL — never by
// editing the default.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Both routes AWAIT `ingestEvent`, whose Hatchet push failure triggers the
// compensating delete of the just-claimed `user_events` row — so the CONTAINER's
// hatchet has to be mocked, not just apps/api's module-level one.
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

const {
  apiKeys,
  contacts,
  feedItems,
  groupMemberships,
  groups,
  linkClicks,
  links,
  trackedLinks,
  userEvents,
} = await import("@hogsend/db");
const { eq, like, or } = await import("drizzle-orm");
const { createApp, createHogsendClient, generateUserToken, sendFeedItem } =
  await import("@hogsend/engine");
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
const { db, env } = container;

// RUN-namespaced so the shared dev DB never collides across files and the
// afterAll cleanup is precise.
const RUN = `obs-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const uid = (label: string) => `${RUN}-${label}`;

const SECRET_KEY = `hsk_test_${RUN}_secret`;
const PK_KEY = `pk_test_${RUN}_publishable`;
const ORIGIN = "https://app.example.com";

const ADMIN_HEADERS = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};
const PK_HEADERS = {
  Authorization: `Bearer ${PK_KEY}`,
  "Content-Type": "application/json",
  Origin: ORIGIN,
};
const SECRET_HEADERS = {
  Authorization: `Bearer ${SECRET_KEY}`,
  "Content-Type": "application/json",
};

const hashKey = (raw: string) => createHash("sha256").update(raw).digest("hex");

const createdKeyIds: string[] = [];
const createdLinkIds: string[] = [];

beforeAll(async () => {
  // A publishable (pk_) browser key: `ingest-public` scope + an Origin
  // allowlist. This is the key class site 1 refuses creation for.
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
  if (pkRow) createdKeyIds.push(pkRow.id);

  // A secret server-side ingest key — never clamped, never refused.
  const [secretRow] = await db
    .insert(apiKeys)
    .values({
      name: `${RUN} secret ingest`,
      keyPrefix: SECRET_KEY.slice(0, 8),
      keyHash: hashKey(SECRET_KEY),
      scopes: ["ingest"],
    })
    .returning({ id: apiKeys.id });
  if (secretRow) createdKeyIds.push(secretRow.id);
});

afterAll(async () => {
  await db.delete(feedItems).where(like(feedItems.recipientKey, `${RUN}-%`));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}-%`));
  // Both legs: a regression that mints the ghost stamps `external_id`, while
  // the creating controls carry `anonymous_id`. Neither may be left behind.
  await db.delete(contacts).where(like(contacts.anonymousId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.email, `${RUN}-%`));
  // The D10 carve-out test mints a real `groups` row. Memberships cascade from
  // BOTH sides (`group_id` and `contact_id` are `onDelete: "cascade"`), so the
  // contact deletes above have already taken the join rows with them.
  await db.delete(groups).where(like(groups.groupKey, `${RUN}-%`));

  for (const id of createdLinkIds) {
    const tracked = await db
      .select({ id: trackedLinks.id })
      .from(trackedLinks)
      .where(eq(trackedLinks.linkId, id));
    for (const t of tracked) {
      await db.delete(linkClicks).where(eq(linkClicks.trackedLinkId, t.id));
    }
    await db.delete(trackedLinks).where(eq(trackedLinks.linkId, id));
    await db.delete(links).where(eq(links.id, id));
  }

  for (const id of createdKeyIds) {
    await db.delete(apiKeys).where(eq(apiKeys.id, id));
  }
});

/** Every live contact row owning `key` as EITHER identity key. */
async function contactsForKey(key: string) {
  return db
    .select({
      id: contacts.id,
      externalId: contacts.externalId,
      anonymousId: contacts.anonymousId,
    })
    .from(contacts)
    .where(or(eq(contacts.externalId, key), eq(contacts.anonymousId, key)));
}

async function eventsForKey(key: string) {
  return db
    .select({
      id: userEvents.id,
      event: userEvents.event,
      // Selected so the feed tests can pin that their `inapp.feed_cleared`
      // carries a RUN-namespaced dedup key — see `bellFeedId` below.
      idempotencyKey: userEvents.idempotencyKey,
    })
    .from(userEvents)
    .where(eq(userEvents.userId, key));
}

// ---------------------------------------------------------------------------
// Feed-id namespacing — why these tests never pass `feedId: "in_app"`.
//
// `routes/feed/index.ts` keys the mark-all-read emit
// `inapp:${feedId}:all:inapp.feed_cleared` — note there is NO recipient
// component — and `user_events_idempotency_key_idx` is a plain GLOBAL unique
// index on `idempotency_key` alone, on which `ingestEvent` returns
// `{ stored: false }`. So for a given `feedId` the FIRST caller anywhere to
// clear a bell wins and every later one stores nothing. With the default
// `feedId` ("in_app") that makes "was `inapp.feed_cleared` stored?" a race
// against every other file in the parallel `main` project that clears a bell
// (`identity-provenance.test.ts` does), each holding its row until its own
// `afterAll`.
//
// Passing a RUN-namespaced `feedId` moves this file onto a dedup key nobody
// else can mint, so the D2 assertion below is about the refusal keeping the
// event — not about who got to the shared row first. `sendFeedItem`'s
// `category` is set to the same value because `/v1/feed/mark-all` filters
// `feed_items.category` by `feedId` when one is supplied; without it the
// mark-all would match zero rows and the round trip would go hollow.
//
// The global key is a REAL production bug, not just a test nuisance — it is
// recorded as a follow-up (its fix needs `packages/js`, out of boundary here).
// ---------------------------------------------------------------------------
const bellFeedId = (label: string) => uid(`feed-${label}`);

// ===========================================================================
// Site 1 — POST /v1/events. A publishable key with no asserted identity and no
// `value` is pure OBSERVATION: the event is kept, the contact is not minted.
// ===========================================================================
describe("site 1 — POST /v1/events observation guard", () => {
  it("pk_ + unseen anonymousId + no value ⇒ 202, event stored, ZERO contacts", async () => {
    const anon = uid("pk-anon");

    const res = await app.request("/v1/events", {
      method: "POST",
      headers: PK_HEADERS,
      body: JSON.stringify({ name: `${RUN}.observed`, anonymousId: anon }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    // PRD 01 pins `resolvedKey` non-null on a refusal, so the response shape is
    // unchanged — no OpenAPI/schema change anywhere.
    expect(body.contactKey).toBe(anon);
    expect(body.stored).toBe(true);

    // Observation is never lost (D2).
    const events = await eventsForKey(anon);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe(`${RUN}.observed`);

    // The load-bearing assertion: ZERO rows, not merely a null id.
    expect(await contactsForKey(anon)).toHaveLength(0);
  });

  it("pk_ + unseen anonymousId + value ⇒ contact created (D9 escape hatch)", async () => {
    const anon = uid("pk-value-anon");

    const res = await app.request("/v1/events", {
      method: "POST",
      headers: PK_HEADERS,
      body: JSON.stringify({
        name: `${RUN}.purchased`,
        anonymousId: anon,
        value: 4200,
        currency: "GBP",
      }),
    });

    expect(res.status).toBe(202);
    // A money-bearing browser event is an identity assertion for creation
    // purposes: `conversions.contact_id` / `funnel_progress.contact_id` /
    // `deals.contact_id` are NOT NULL FKs, so refusing here would silently stop
    // revenue conversions and attribution credits from firing.
    const rows = await contactsForKey(anon);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.anonymousId).toBe(anon);
  });

  it("pk_ + unseen anonymousId + groups ⇒ group AND membership exist (D10)", async () => {
    // D10's carve-out. Browser group ASSOCIATION is a documented first-class
    // capability (root CLAUDE.md: "Publishable/browser keys may ONLY associate
    // — attach a `groups` map to an event via `hogsend.group()` → /v1/events"),
    // and `@hogsend/js` attaches the map to EVERY capture regardless of
    // identification, so this is the exact shape a pre-login `hogsend.group()`
    // puts on the wire. `group_memberships.contact_id` is a fourth `.notNull()`
    // FK to `contacts.id`, so a refusal here writes NEITHER the `groups` row
    // (minted by `associateGroups` → `resolveGroupId`) NOR the membership —
    // silently deleting the capability. Calling `hogsend.group()` is an
    // association INTENT, i.e. more than pure observation, so it keeps creating.
    const anon = uid("pk-groups-anon");
    const groupKey = uid("acme.example");

    const res = await app.request("/v1/events", {
      method: "POST",
      headers: PK_HEADERS,
      body: JSON.stringify({
        name: `${RUN}.grouped`,
        anonymousId: anon,
        groups: { company: groupKey },
      }),
    });

    expect(res.status).toBe(202);

    const rows = await contactsForKey(anon);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.anonymousId).toBe(anon);

    // Both halves of the association, not merely the contact: the `groups` row
    // is minted by the same call that writes the join, so asserting only the
    // contact would leave a half-broken carve-out shipping green.
    const groupRows = await db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.groupKey, groupKey));
    expect(groupRows).toHaveLength(1);

    const memberships = await db
      .select({ contactId: groupMemberships.contactId })
      .from(groupMemberships)
      .where(eq(groupMemberships.groupId, groupRows[0]?.id ?? ""));
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.contactId).toBe(rows[0]?.id);
  });

  it("pk_ + unseen anonymousId + NO groups ⇒ still ZERO contacts", async () => {
    // The control for the case above: byte-identical request minus the `groups`
    // map. Pins that D10 carved out exactly one field and did not reopen the
    // site-1 guard for ordinary browser traffic.
    const anon = uid("pk-nogroups-anon");

    const res = await app.request("/v1/events", {
      method: "POST",
      headers: PK_HEADERS,
      body: JSON.stringify({ name: `${RUN}.grouped`, anonymousId: anon }),
    });

    expect(res.status).toBe(202);
    expect(await contactsForKey(anon)).toHaveLength(0);
  });

  it("pk_ + token-asserted userId ⇒ contact created", async () => {
    const userId = uid("pk-token-user");
    const userToken = generateUserToken({
      userId,
      secret: env.BETTER_AUTH_SECRET,
    });

    const res = await app.request("/v1/events", {
      method: "POST",
      headers: PK_HEADERS,
      body: JSON.stringify({
        name: `${RUN}.identified`,
        userId,
        userToken,
      }),
    });

    expect(res.status).toBe(202);
    const rows = await contactsForKey(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.externalId).toBe(userId);
  });

  it("pk_ + anonymousId + token-asserted userId ⇒ ONE contact, no anon twin", async () => {
    // THE production default for an identified browser user, and the only shape
    // that reaches the `!body.userId` conjunct: `@hogsend/js` enqueues
    // `anonymousId: identity.getAnonymousId()` on EVERY capture and layers
    // `userId`/`userToken` on top once identified
    // (`packages/js/src/spine/event-spine.ts:63-71`). The case above sends a
    // userId with NO anonymousId — a raw-HTTP shape the SDK never emits — so it
    // short-circuits on the trailing `!!body.anonymousId` conjunct and leaves
    // `!body.userId` completely unevaluated. Without this case, deleting
    // `!body.userId &&` from the guard ships green.
    const anon = uid("pk-sdk-anon");
    const userId = uid("pk-sdk-user");
    const userToken = generateUserToken({
      userId,
      secret: env.BETTER_AUTH_SECRET,
    });

    const res = await app.request("/v1/events", {
      method: "POST",
      headers: PK_HEADERS,
      body: JSON.stringify({
        name: `${RUN}.sdk_identified`,
        anonymousId: anon,
        userId,
        userToken,
      }),
    });

    expect(res.status).toBe(202);

    // A token-proven userId is a server-authorized identity assertion (D1), so
    // it keeps creating — exactly one row, carrying BOTH keys.
    const byUser = await contactsForKey(userId);
    expect(byUser).toHaveLength(1);
    expect(byUser[0]?.externalId).toBe(userId);

    // …and the anon key resolves to that SAME row, not a second anon-only twin
    // beside it. `contactKey` = `external_id ?? anonymous_id`, so the canonical
    // key flips to the userId and the anon key's history is repointed onto it.
    const byAnon = await contactsForKey(anon);
    expect(byAnon).toHaveLength(1);
    expect(byAnon[0]?.id).toBe(byUser[0]?.id);
    expect((await res.json()).contactKey).toBe(userId);
  });

  it("secret key + unseen anonymousId ⇒ contact created", async () => {
    // A secret-key ingest still runs `requireIdentity`, so an anon-ONLY body is
    // a 400 on this key class — the reachable shape carries an email alongside
    // the unseen anon id. What this pins is that the guard keys on the
    // publishable key CLASS, never on the anon arm being present.
    const anon = uid("secret-anon");
    const email = `${uid("secret")}@example.test`;

    const res = await app.request("/v1/events", {
      method: "POST",
      headers: SECRET_HEADERS,
      body: JSON.stringify({
        name: `${RUN}.server`,
        email,
        anonymousId: anon,
      }),
    });

    expect(res.status).toBe(202);
    const rows = await contactsForKey(anon);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.anonymousId).toBe(anon);
  });
});

// ===========================================================================
// Site 2 — POST /v1/t/arrive. `allowCreate` is the exact COMPLEMENT of the
// adjacent `restrictToAnonymous: !isToken`, so BOTH legs need a test: without
// the token POSITIVE below, a blanket `allowCreate: false` ships green.
// ===========================================================================

/** Mint an `appendRef` link, hit its redirect, return the `hs_ref` click id. */
async function refForNewClick(label: string): Promise<string> {
  const minted = await app.request("/v1/admin/links", {
    method: "POST",
    headers: ADMIN_HEADERS,
    body: JSON.stringify({
      url: "https://example.com/arrive",
      label: uid(label),
      appendRef: true,
    }),
  });
  const link = await minted.json();
  createdLinkIds.push(link.id);

  const hit = await app.request(`/v1/t/c/${link.trackedLinkId}`, {
    redirect: "manual",
  });
  const location = hit.headers.get("location");
  const ref = location && new URL(location).searchParams.get("hs_ref");
  if (!ref) throw new Error("expected hs_ref on the redirect");
  return ref;
}

async function arrive(body: Record<string, unknown>) {
  return app.request("/v1/t/arrive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("site 2 — POST /v1/t/arrive observation guard", () => {
  it("anon arrival ⇒ 200, arrival recorded, ZERO contacts", async () => {
    const ref = await refForNewClick("arrive-anon-link");
    const anon = uid("arrive-anon");

    const res = await arrive({ ref, anonymousId: anon });
    expect(res.status).toBe(200);

    // The arrival is still fully observed: the click row is stamped and the
    // journey-triggerable `link.arrived` event is stored under the anon key.
    const [stamp] = await db
      .select({ visitorDistinctId: linkClicks.visitorDistinctId })
      .from(linkClicks)
      .where(eq(linkClicks.id, ref));
    expect(stamp?.visitorDistinctId).toBe(anon);
    const events = await eventsForKey(anon);
    expect(events.map((e) => e.event)).toContain("link.arrived");

    expect(await contactsForKey(anon)).toHaveLength(0);
  });

  it("token arrival ⇒ contact created (the mandatory positive case)", async () => {
    const ref = await refForNewClick("arrive-token-link");
    const userId = uid("arrive-token-user");
    const userToken = generateUserToken({
      userId,
      secret: env.BETTER_AUTH_SECRET,
    });

    const res = await arrive({ ref, userToken });
    expect(res.status).toBe(200);

    const events = await eventsForKey(userId);
    expect(events.map((e) => e.event)).toContain("link.arrived");

    const rows = await contactsForKey(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.externalId).toBe(userId);
  });
});

// ===========================================================================
// Site 3 — `sendFeedItem`. A feed recipient is USUALLY a key the engine itself
// minted and handed to a journey. On the PURE-`anonymousId` arm that key is a
// browser identifier and re-resolving it is observation: left creating it mints
// an `external_id = <anonId>` row for every anonymous visitor — the ghost that
// then trips `collidesWithIdentified` and 403-LOCKS the visitor out of their own
// bell.
//
// The `userId` arm is the exact opposite and MUST keep minting: that row is the
// only thing `collidesWithIdentified` can see, so refusing it makes a private
// recipient's key addressable by any pk_ caller passing it as `anonymousId`.
// (A consumer journey that passes a browser anon id on the `userId` arm is
// therefore fixed consumer-side, by passing `{ anonymousId }` — not by widening
// the refusal.) Both directions are pinned below.
// ===========================================================================

/** Every feed row written under `key`. */
async function feedItemsForKey(key: string) {
  return db
    .select({
      id: feedItems.id,
      type: feedItems.type,
      contactId: feedItems.contactId,
    })
    .from(feedItems)
    .where(eq(feedItems.recipientKey, key));
}

/** Read the bell exactly as an unidentified browser does: pk_ key + anon id. */
function readBell(anonymousId: string) {
  return app.request(
    `/v1/feed?anonymousId=${encodeURIComponent(anonymousId)}`,
    { method: "GET", headers: PK_HEADERS },
  );
}

describe("site 3 — sendFeedItem observation guard", () => {
  it("anon feed item ⇒ the bell reads it back (the whole-stack regression)", async () => {
    // The anonymous in-app shape: a journey holds a browser anon id and passes
    // it on the arm that says so (`{ anonymousId: user.id }`), which is the one
    // and only arm the refusal covers.
    const anon = uid("feed-bell-anon");

    const sent = await sendFeedItem({
      recipient: { anonymousId: anon },
      type: `${RUN}.bell`,
      title: "Anonymous bell item",
    });
    expect(sent.suppressed).toBe(false);
    expect(sent.feedItemId).toBeTruthy();
    // The refusal key is byte-identical to the key the bell polls, so the send
    // side and the read side still agree (D8's whole point).
    expect(sent.recipientKey).toBe(anon);

    const res = await readBell(anon);
    // Before the guard this is a 403: the send minted `external_id = <anon>`,
    // and `resolveFeedRecipient` refuses a publishable `anonymousId` that
    // collides with an identified contact's canonical key.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: { type: string }) => i.type)).toContain(
      `${RUN}.bell`,
    );
    expect(body.metadata.unseen_count).toBe(1);

    // …and no ghost was minted to lock them out in the first place.
    expect(await contactsForKey(anon)).toHaveLength(0);
  });

  it("a userId recipient is NOT addressable as an anonymousId", async () => {
    // The OPPOSITE direction, and the reason the refusal stops at the
    // `anonymousId` arm. `sendFeedItem` keys an identified recipient's rows on
    // their canonical key, and the contact it mints is the ONLY signal
    // `collidesWithIdentified` has that the string belongs to somebody. Widen
    // `refusable` back over the `userId` arm and nothing collides — so the
    // publishable anon arm of `resolveFeedRecipient` accepts that key as a
    // self-addressing anon id, and both 403s below become a successful read of
    // the item body and a successful mutation of the row.
    const userId = uid("feed-private-user");

    const sent = await sendFeedItem({
      recipient: { userId },
      type: `${RUN}.private`,
      title: "Private to an identified recipient",
    });
    const itemId = sent.feedItemId;
    expect(itemId).toBeTruthy();
    expect(sent.recipientKey).toBe(userId);

    // Pin the guard's INPUT, not just its output: the mint must have happened.
    const owner = await contactsForKey(userId);
    expect(owner).toHaveLength(1);
    expect(owner[0]?.externalId).toBe(userId);

    const leakRead = await readBell(userId);
    expect(leakRead.status).toBe(403);

    const leakMarkAll = await app.request("/v1/feed/mark-all", {
      method: "POST",
      headers: PK_HEADERS,
      body: JSON.stringify({ state: "read", anonymousId: userId }),
    });
    expect(leakMarkAll.status).toBe(403);

    // …and zero rows moved: the item is still unseen for its real owner.
    const [row] = await db
      .select({ status: feedItems.status })
      .from(feedItems)
      .where(eq(feedItems.id, itemId as string));
    expect(row?.status).toBe("unseen");
  });

  it("anon bell survives its OWN mark/clear round trip", async () => {
    // The send side refusing is only half the loop. Every mark/clear the bell
    // performs RE-INGESTS under `userId: <recipientKey>` — the raw anon id — and
    // those re-ingests default to creating. Left creating they mint the exact
    // ghost the send side just refused (`external_id = <anonId>`), which then
    // trips `collidesWithIdentified` and 403-locks the visitor out of the bell
    // they were reading a moment ago. All three emit sites are driven here:
    // `/mark` (per-item), `/mark-all` non-read (per-item), `/mark-all` read
    // (the single `inapp.feed_cleared`).
    const anon = uid("feed-mark-anon");
    const feedId = bellFeedId("mark");

    const sent = await sendFeedItem({
      recipient: { anonymousId: anon },
      category: feedId,
      type: `${RUN}.markable`,
      title: "Anonymous bell item",
    });
    expect(sent.recipientKey).toBe(anon);
    const itemId = sent.feedItemId;
    expect(itemId).toBeTruthy();

    expect((await readBell(anon)).status).toBe(200);

    const markOne = await app.request("/v1/feed/mark", {
      method: "POST",
      headers: PK_HEADERS,
      body: JSON.stringify({
        ids: [itemId],
        state: "seen",
        feedId,
        anonymousId: anon,
      }),
    });
    expect(markOne.status).toBe(200);

    const markAllSeen = await app.request("/v1/feed/mark-all", {
      method: "POST",
      headers: PK_HEADERS,
      body: JSON.stringify({ state: "seen", feedId, anonymousId: anon }),
    });
    expect(markAllSeen.status).toBe(200);
    // The round trip is real, not hollow: `mark-all` scoped to this feed still
    // matched the item it was supposed to mark.
    expect((await markAllSeen.json()).updated).toBe(1);

    const markAllRead = await app.request("/v1/feed/mark-all", {
      method: "POST",
      headers: PK_HEADERS,
      body: JSON.stringify({ state: "read", feedId, anonymousId: anon }),
    });
    expect(markAllRead.status).toBe(200);
    expect((await markAllRead.json()).updated).toBe(1);

    // The load-bearing assertion: the mark path minted NOTHING. Before the
    // guard this is one row with `external_id = <anon>`.
    expect(await contactsForKey(anon)).toHaveLength(0);

    // …so the visitor can still read their own bell. Before the guard this GET
    // is a 403 ("anonymousId is not addressable").
    const after = await readBell(anon);
    expect(after.status).toBe(200);
    const body = await after.json();
    expect(body.items.map((i: { type: string }) => i.type)).toContain(
      `${RUN}.markable`,
    );

    // Observation is never lost (D2) — the `inapp.*` re-ingests still stored.
    // This is the assertion the refusal has to survive: a refused ingest keeps
    // its event. The no-mint claim is the `contactsForKey` line above; THIS
    // line is its complement — make the refusal drop the event instead of
    // storing it (early-return in `ingestEvent` when the resolve refuses) and
    // it goes red.
    const events = await eventsForKey(anon);
    const cleared = events.find((e) => e.event === "inapp.feed_cleared");
    expect(cleared).toBeTruthy();
    // …and it is genuinely THIS run's clear, not a row some other file left in
    // the shared DB. The dedup key is global (no recipient component), so
    // asserting the namespace is what keeps the line above honest: drop the
    // `feedId` from the mark-all call and this reads
    // `inapp:in_app:all:inapp.feed_cleared`, i.e. the contended key, and fails
    // here instead of flaking there.
    expect(cleared?.idempotencyKey).toBe(
      `inapp:${feedId}:all:inapp.feed_cleared`,
    );
  });

  it("clearing an EMPTY bell mints nothing", async () => {
    // `mark-all` with `state: "read"` emits `inapp.feed_cleared`
    // UNCONDITIONALLY — a first-time visitor whose bell has never held an item
    // still drives one re-ingest. That alone used to mint the ghost.
    const anon = uid("feed-empty-anon");
    const feedId = bellFeedId("empty");

    const res = await app.request("/v1/feed/mark-all", {
      method: "POST",
      headers: PK_HEADERS,
      body: JSON.stringify({ state: "read", feedId, anonymousId: anon }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).updated).toBe(0);

    expect(await contactsForKey(anon)).toHaveLength(0);
    expect((await readBell(anon)).status).toBe(200);

    // The emit really fired for this empty bell — with the shared `in_app`
    // dedup key it could have been absorbed by another file's row, which would
    // have left "mints nothing" true for the wrong reason. (Resolution runs
    // BEFORE the idempotency insert in `ingestEvent`, so a stolen key does not
    // itself hide a mint — but the premise is pinned rather than assumed.)
    const events = await eventsForKey(anon);
    expect(events.map((e) => e.idempotencyKey)).toContain(
      `inapp:${feedId}:all:inapp.feed_cleared`,
    );
  });

  it("sendFeedItem to an unseen key ⇒ row lands with contact_id NULL", async () => {
    const anon = uid("feed-anon");

    const sent = await sendFeedItem({
      recipient: { anonymousId: anon },
      type: `${RUN}.nudge`,
      body: "still delivered",
    });
    expect(sent.suppressed).toBe(false);
    expect(sent.recipientKey).toBe(anon);

    // Observation is never lost (D2): the item is inserted, just unattached.
    // `feed_items.contact_id` is nullable and carries NO foreign key (0034).
    const rows = await feedItemsForKey(anon);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBeNull();

    expect(await contactsForKey(anon)).toHaveLength(0);
  });

  it("email recipient ⇒ contact created, and no D8 misuse throw", async () => {
    // An email is a durable identity the caller is ASSERTING (D1) — and it is
    // never a canonical key, so refusing it would ALSO violate D8
    // (`resolveContactNoCreate` throws on that shape). Both reasons point the
    // same way: keep creating.
    const email = `${uid("feed-email")}@example.test`;

    const sent = await sendFeedItem({
      recipient: { email },
      type: `${RUN}.emailed`,
    });
    expect(sent.suppressed).toBe(false);

    const rows = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.email, email));
    expect(rows).toHaveLength(1);
    const items = await feedItemsForKey(sent.recipientKey ?? "");
    expect(items[0]?.contactId).toBe(rows[0]?.id);
  });

  it("anonymousId + email recipient ⇒ contact created (the email asserts)", async () => {
    // Guards the `!email` conjunct SPECIFICALLY: this recipient carries a legal
    // refusal key (`anonymousId`), so the email assertion is the only thing
    // keeping it creating. Drop that conjunct and this test goes red.
    const anon = uid("feed-mixed-anon");
    const email = `${uid("feed-mixed")}@example.test`;

    await sendFeedItem({
      recipient: { anonymousId: anon, email },
      type: `${RUN}.mixed`,
    });

    const rows = await contactsForKey(anon);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.anonymousId).toBe(anon);
  });

  it("existing contact ⇒ contact_id still attaches (refusal is miss-only)", async () => {
    // The refusal arm fires ONLY when no live row owns any supplied key. A hit
    // on the refusable (anon) arm must still link exactly as before — this is
    // what stops a blanket `contactId: null` shipping green.
    const anon = uid("feed-known-anon");
    const [row] = await db
      .insert(contacts)
      .values({ anonymousId: anon })
      .returning({ id: contacts.id });

    await sendFeedItem({
      recipient: { anonymousId: anon },
      type: `${RUN}.known`,
    });

    const items = await feedItemsForKey(anon);
    expect(items).toHaveLength(1);
    expect(items[0]?.contactId).toBe(row?.id);
  });
});
