import { AccountLinkCallbackError } from "@hogsend/core";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { fakeAccountLink } from "./account-link-fakes.js";

// Same real test DB the engine singletons + the route container read.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// PRD 08 T4: the callback now emits through the fire-and-forget outbound
// spine, which enqueues the MODULE-LEVEL `deliverWebhookTask` built from the
// engine's `lib/hatchet.ts` singleton at import time — NOT a container
// hatchet. Mock the singleton itself (the account-link-merge idiom) so the
// delivery row lands without a live gRPC dial.
const { hatchetMock } = vi.hoisted(() => {
  const runNoWait = vi.fn(async (_input: { deliveryId: string }) => ({}));
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
        runNoWait,
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

const {
  contacts,
  createDatabase,
  linkedAccounts,
  webhookDeliveries,
  webhookEndpoints,
} = await import("@hogsend/db");
const { asc, eq, like, sql } = await import("drizzle-orm");
const engine = await import("@hogsend/engine");
const { createApp, createHogsendClient, signConnectorState } = engine;

const SECRET = "test-secret-for-vitest-minimum-32-characters-long";

/**
 * PRD 08 T4 — the callback's emit sites, asserted on the DELIVERY rows the
 * outbound spine actually wrote. Every count is `toHaveLength(n)`, never
 * `toBeGreaterThan(0)`: an emit that fires twice is exactly the bug the
 * dedupe key exists to prevent, and a `>0` assertion cannot see it.
 *
 * `account.link_failed` carries NO dedupeKey by design, so its rows cannot be
 * scoped by key — they are scoped by the PROVIDER id in the payload instead,
 * which is why this file registers its provider under a per-run unique id.
 */
const RUN = `alf-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
// Doubles as the provider id: `ACCOUNT_LINK_ID_RE` is /^[a-z][a-z0-9_-]{0,31}$/
// and this is 26 chars of lowercase hex + dashes.
const PROVIDER = RUN;
/**
 * A second provider, `multiple: false`, for the singleton-displacement case.
 * 27 chars, still inside `ACCOUNT_LINK_ID_RE`. It is a separate registration
 * rather than a flag on `PROVIDER` because `multiple` is read off the provider
 * definition at callback time and every other case here wants the default.
 */
const SINGLETON = `${RUN}s`;

let seq = 0;
const uid = (label: string) => `${RUN}-${label}-${seq++}`;

const { db, client } = createDatabase({
  url: process.env.DATABASE_URL as string,
});

const hooks: { before?: () => unknown } = {};
const provider = fakeAccountLink({ id: PROVIDER, name: "Fake Link" });
const single = fakeAccountLink({
  id: SINGLETON,
  name: "Fake Single Link",
  multiple: false,
  onConflict: "replace",
});

const container = createHogsendClient({
  accountLinks: {
    providers: [provider, single],
    hooks: {
      beforeLink() {
        return hooks.before?.() as never;
      },
    },
  },
  // The hatchet singleton is already mocked above; the override only pins the
  // same handle explicitly, so the route's container emit and the module-level
  // delivery task cannot end up on two different dials.
  overrides: { hatchet: engine.hatchet },
});
const app = createApp(container);

let ipSeq = 0;
const freshIp = () => `${RUN}-${ipSeq++}`;

/** The one endpoint subscribed to all three `account.*` events this run. */
let endpointId = "";

type Delivery = {
  eventType: string;
  dedupeKey: string | null;
  data: Record<string, unknown>;
};

/**
 * Delivery rows for THIS run's endpoint, oldest first.
 *
 * ORDER BY created_at is load-bearing for the relink case: the emit order is
 * the whole point of that test, and Postgres orders at full timestamp
 * precision (the emits are chained, so their inserts are a round trip apart).
 */
async function deliveries(): Promise<Delivery[]> {
  const rows = await db
    .select({
      eventType: webhookDeliveries.eventType,
      dedupeKey: webhookDeliveries.dedupeKey,
      payload: webhookDeliveries.payload,
    })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.endpointId, endpointId))
    .orderBy(asc(webhookDeliveries.createdAt));
  return rows.map((r) => ({
    eventType: r.eventType,
    dedupeKey: r.dedupeKey,
    data: (r.payload as { data: Record<string, unknown> }).data,
  }));
}

/** State-event rows for one platform account, scoped by the dedupe key. */
async function stateDeliveries(providerUserId: string): Promise<Delivery[]> {
  return pairDeliveries(PROVIDER, providerUserId);
}

/**
 * State-event rows for SEVERAL platform accounts at once, in emit order.
 *
 * The singleton-displacement case ENDS one pair and BINDS another inside one
 * mutation, so what has to be asserted is the interleaving of two DIFFERENT
 * pairs' keys — which a single-pair filter cannot see.
 */
async function pairDeliveries(
  providerId: string,
  ...providerUserIds: string[]
): Promise<Delivery[]> {
  const all = await deliveries();
  return all.filter((r) =>
    providerUserIds.some((puid) =>
      r.dedupeKey?.startsWith(`al:${providerId}:${puid}:`),
    ),
  );
}

/** `account.link_failed` rows, scoped by the payload (they carry no key). */
async function failedDeliveries(): Promise<Delivery[]> {
  const all = await deliveries();
  return all.filter(
    (r) =>
      r.eventType === "account.link_failed" && r.data.provider === PROVIDER,
  );
}

/**
 * The emits are fire-and-forget (`void emitOutbound(...)`), so the response
 * resolves before the emit's INSERT lands — poll until `expected` rows appear.
 */
async function waitFor<T>(
  read: () => Promise<T[]>,
  expected: number,
  timeoutMs = 5000,
): Promise<T[]> {
  const start = Date.now();
  let rows = await read();
  while (rows.length < expected && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 25));
    rows = await read();
  }
  return rows;
}

/** Absence cannot be polled for — give the emit a fixed window to not appear. */
const SETTLE_MS = 750;

/**
 * `over` is spread LAST, so a case that needs the singleton provider passes
 * `{ providerId: SINGLETON }` and gets a state sealed for it.
 */
function accountLinkState(over: Record<string, unknown> = {}): string {
  return signConnectorState(
    {
      purpose: "account_link",
      providerId: PROVIDER,
      nonce: uid("nonce"),
      ...over,
    },
    SECRET,
    900,
  );
}

function callback(state: string, providerId: string = PROVIDER) {
  return app.request(
    `/v1/accounts/${providerId}/callback?state=${encodeURIComponent(state)}`,
    { headers: { "x-forwarded-for": freshIp() } },
  );
}

/**
 * `externalId` DEFAULTS to a run-scoped id rather than NULL, and that is a
 * cleanup requirement, not a style choice: `afterAll` deletes by
 * `external_id LIKE '<RUN>%'` / `anonymous_id LIKE '<RUN>%'`, and neither
 * predicate can ever match a NULL column. A contact inserted with all three
 * identity columns NULL is orphaned in the shared test database FOREVER, and
 * every orphan makes the global contact-id sweep slower for every later run.
 */
async function makeContact(fields: {
  externalId?: string;
  email?: string;
}): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({
      externalId: fields.externalId ?? uid("ext"),
      email: fields.email ?? null,
    })
    .returning({ id: contacts.id });
  if (!row) throw new Error("contact insert failed");
  return row.id;
}

async function countContacts(): Promise<number> {
  const rows = (await db.execute(
    sql`SELECT count(*)::int AS n FROM contacts`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? -1;
}

beforeAll(async () => {
  const [row] = await db
    .insert(webhookEndpoints)
    .values({
      url: `https://example.com/${RUN}/account-sink`,
      secret: "whsec_dGVzdHNlY3JldGZvcmVtaXRwb2ludGNvdmVyYWdldGVzdA==",
      secretPrefix: "whsec_dGVzd",
      eventTypes: ["account.linked", "account.unlinked", "account.link_failed"],
      disabled: false,
    })
    .returning({ id: webhookEndpoints.id });
  endpointId = row?.id ?? "";
});

beforeEach(() => {
  hooks.before = undefined;
  provider.fails(null);
  provider.calls.handleCallback.length = 0;
  single.fails(null);
  single.calls.handleCallback.length = 0;
});

afterAll(async () => {
  // Deliveries cascade with the endpoint (FK onDelete: "cascade").
  if (endpointId) {
    await db
      .delete(webhookEndpoints)
      .where(eq(webhookEndpoints.id, endpointId));
  }
  await db.delete(linkedAccounts).where(eq(linkedAccounts.provider, PROVIDER));
  await db.delete(linkedAccounts).where(eq(linkedAccounts.provider, SINGLETON));
  // Both predicates are LIKE on a NOT-NULL-only match — see `makeContact`.
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}%`));
  await db.delete(contacts).where(like(contacts.anonymousId, `${RUN}%`));
  await client.end();
});

// ---------------------------------------------------------------------------
// account.link_failed
// ---------------------------------------------------------------------------

describe("account.link_failed", () => {
  it("state_invalid emits with contactId null", async () => {
    // A signature-valid state re-pointed at this provider would verify; this
    // one is forged, so nothing about it is trustworthy — including any
    // contact id it claims to carry.
    const token = accountLinkState({ contactId: await makeContact({}) });
    const [payload] = token.split(".");
    const forged = `${payload}.${Buffer.from("not-the-signature").toString("base64url")}`;

    const res = await callback(forged);
    expect(res.status).toBe(400);

    const rows = await waitFor(failedDeliveries, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toMatchObject({
      provider: PROVIDER,
      reason: "state_invalid",
      contactId: null,
    });
    // No version, no state: nothing mutated (DECISIONS §8).
    expect(rows[0]?.data.version).toBeUndefined();
    expect(rows[0]?.data.state).toBeUndefined();
    // And no dedupeKey — two genuine failures are two genuine facts.
    expect(rows[0]?.dedupeKey).toBeNull();
  });

  it("vetoed emits with the sealed contactId", async () => {
    const contactId = await makeContact({
      externalId: uid("ext"),
      email: `${uid("veto")}@example.test`,
    });
    hooks.before = () => ({ allow: false, reason: "not-eligible" });
    provider.proves({ providerUserId: uid("puid") });

    const before = await failedDeliveries();
    const res = await callback(accountLinkState({ contactId }));
    expect(res.status).toBe(400);

    const rows = await waitFor(failedDeliveries, before.length + 1);
    expect(rows).toHaveLength(before.length + 1);
    expect(rows.at(-1)?.data).toMatchObject({
      provider: PROVIDER,
      reason: "vetoed",
      contactId,
    });
  });

  it("a link_failed emit creates no contacts row", async () => {
    // The COLD path is the one that could plausibly mint: it carries an
    // anonymous id and no contact. The provider refuses AFTER the state
    // verified, which is the latest a failure can happen with no contact in
    // hand — so if any path mints on failure, this is the path.
    const anonymousId = uid("anon");
    provider.fails(
      new AccountLinkCallbackError("denied", "player pressed cancel"),
    );

    const before = await countContacts();
    const beforeFailed = await failedDeliveries();

    const res = await callback(accountLinkState({ anonymousId }));
    expect(res.status).toBe(400);

    const rows = await waitFor(failedDeliveries, beforeFailed.length + 1);
    expect(rows.at(-1)?.data).toMatchObject({
      provider: PROVIDER,
      reason: "denied",
      contactId: null,
    });

    // COUNTED, not sampled: this is the DECISIONS §8 "never mints a contact"
    // guard, and only a before/after count of the whole table can see a row
    // minted under a key the test did not predict.
    expect(await countContacts()).toBe(before);
    const anon = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.anonymousId, anonymousId));
    expect(anon).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// account.linked / account.unlinked
// ---------------------------------------------------------------------------

describe("account.linked", () => {
  it("a successful callback emits exactly one account.linked", async () => {
    const externalId = uid("ext");
    const email = `${uid("owner")}@example.test`;
    const contactId = await makeContact({ externalId, email });
    const providerUserId = uid("puid");
    provider.proves({ providerUserId, username: "player-one" });

    const res = await callback(accountLinkState({ contactId }));
    expect(res.status).toBe(200);

    const rows = await waitFor(() => stateDeliveries(providerUserId), 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("account.linked");
    expect(rows[0]?.dedupeKey).toBe(`al:${PROVIDER}:${providerUserId}:v1`);
    expect(rows[0]?.data).toMatchObject({
      state: "linked",
      provider: PROVIDER,
      providerUserId,
      contactId,
      // The store's `owner` block: contactKey() and the CONTACT's email,
      // never the provider-reported one.
      userId: externalId,
      email,
      username: "player-one",
      method: "oauth",
      relink: false,
      version: "1",
    });

    // Still exactly one after the fire-and-forget window has fully settled.
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    expect(await stateDeliveries(providerUserId)).toHaveLength(1);
  });

  it("a relink emits unlinked at the lower version before linked at the higher one", async () => {
    const firstExternalId = uid("ext");
    const first = await makeContact({
      externalId: firstExternalId,
      email: `${uid("first")}@example.test`,
    });
    const second = await makeContact({
      externalId: uid("ext"),
      email: `${uid("second")}@example.test`,
    });
    const providerUserId = uid("puid");
    provider.proves({ providerUserId });

    expect(
      (await callback(accountLinkState({ contactId: first }))).status,
    ).toBe(200);
    await waitFor(() => stateDeliveries(providerUserId), 1);

    expect(
      (await callback(accountLinkState({ contactId: second }))).status,
    ).toBe(200);
    const rows = await waitFor(() => stateDeliveries(providerUserId), 3);

    // THE ORDER IS THE ASSERTION. A consumer's guard is
    // `incoming.version > stored.version`, so a late unlink at v2 must arrive
    // (and be discarded) against a stored v3 — never the other way round.
    expect(rows.map((r) => r.eventType)).toEqual([
      "account.linked",
      "account.unlinked",
      "account.linked",
    ]);
    expect(rows.map((r) => r.data.version)).toEqual(["1", "2", "3"]);
    expect(rows[1]?.data).toMatchObject({
      state: "unlinked",
      provider: PROVIDER,
      providerUserId,
      // The DISPLACED owner, with its own facts — not the new one.
      contactId: first,
      userId: firstExternalId,
      reason: "relinked",
      version: "2",
    });
    expect(rows[2]?.data).toMatchObject({
      state: "linked",
      contactId: second,
      relink: true,
      version: "3",
    });
    expect(rows[1]?.dedupeKey).toBe(`al:${PROVIDER}:${providerUserId}:v2`);
    expect(rows[2]?.dedupeKey).toBe(`al:${PROVIDER}:${providerUserId}:v3`);
  });
});

// ---------------------------------------------------------------------------
// account.unlinked — the singleton displacement (PRD 08, RULING 2026-08-14)
// ---------------------------------------------------------------------------

describe("account.unlinked (singleton displacement)", () => {
  it("emits one unlinked on the DISPLACED pair, reason relinked, before the linked", async () => {
    const externalId = uid("ext");
    const email = `${uid("single")}@example.test`;
    const contactId = await makeContact({ externalId, email });
    const displaced = uid("puid");
    const arriving = uid("puid");

    single.proves({ providerUserId: displaced, username: "old-handle" });
    expect(
      (
        await callback(
          accountLinkState({ providerId: SINGLETON, contactId }),
          SINGLETON,
        )
      ).status,
    ).toBe(200);
    await waitFor(() => pairDeliveries(SINGLETON, displaced), 1);

    // Same contact, DIFFERENT platform account, on a `multiple: false`
    // provider: the store soft-unlinks the first pair to make room.
    single.proves({ providerUserId: arriving, username: "new-handle" });
    expect(
      (
        await callback(
          accountLinkState({ providerId: SINGLETON, contactId }),
          SINGLETON,
        )
      ).status,
    ).toBe(200);

    const rows = await waitFor(
      () => pairDeliveries(SINGLETON, displaced, arriving),
      3,
    );
    expect(rows.map((r) => r.eventType)).toEqual([
      "account.linked",
      "account.unlinked",
      "account.linked",
    ]);

    // The displacement is announced on the push plane, which is what makes it
    // agree with the `afterUnlink{relinked}` the store already fires on the
    // in-process plane. Without it no later event ever fires for this pair, so
    // a subscriber records the wrong owner permanently.
    expect(rows[1]?.data).toMatchObject({
      state: "unlinked",
      provider: SINGLETON,
      providerUserId: displaced,
      contactId,
      userId: externalId,
      email,
      reason: "relinked",
      // The DISPLACED pair's own sequence: it was bound at v1, released at v2.
      version: "2",
    });
    // ...and the arriving pair starts its OWN sequence at v1.
    expect(rows[2]?.data).toMatchObject({
      state: "linked",
      providerUserId: arriving,
      relink: false,
      version: "1",
    });

    // THE POINT OF THIS TEST. The two keys name DIFFERENT PAIRS. Building the
    // unlink's key from the NEW pair yields `al:<p>:<arriving>:v1` — exactly
    // the `account.linked` key below it — so the row is swallowed by
    // `onConflictDoNothing` with no error and no missing-row signal anywhere.
    expect(rows[1]?.dedupeKey).toBe(`al:${SINGLETON}:${displaced}:v2`);
    expect(rows[2]?.dedupeKey).toBe(`al:${SINGLETON}:${arriving}:v1`);
    expect(rows[1]?.dedupeKey).not.toBe(rows[2]?.dedupeKey);
    expect(rows[1]?.data.providerUserId).not.toBe(rows[2]?.data.providerUserId);

    // Exactly three once the fire-and-forget window has fully settled.
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    expect(await pairDeliveries(SINGLETON, displaced, arriving)).toHaveLength(
      3,
    );
  });
});
