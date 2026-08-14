import { createHash } from "node:crypto";
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

/**
 * PRD 08 T5 — THE JOURNEY PLANE.
 *
 * The outbound spine already carried `account.linked` / `account.unlinked` /
 * `account.link_failed` to a customer's subscriber. This file is about the
 * OTHER plane: the same facts re-ingested through `ingestEvent` so
 * `defineJourney({ trigger: { event: "account.linked" } })` fires inside
 * Hogsend. The two are independent — an outbound-only build leaves every
 * account-link journey dead and nothing fails — so these assertions are the
 * only thing standing between "supported" and "silently never fires".
 *
 * Registered in `vitest.config.ts`'s `WEBHOOK_FANOUT`, but NOT on the webhook
 * criterion: this file seeds no endpoint and asserts on no delivery row, and
 * emitting alone is never the criterion (the config's own comment names
 * several deliberately-absent emitters). It is there for the reason
 * `admin-impact-global-control.test.ts` and `contact-id-backfill.test.ts` are
 * — the no-mint guard below is a before/after count of the WHOLE contacts
 * table, the only oracle that can see a row minted under a key this file did
 * not predict, and RUN-namespacing cannot scope it. Measured file-parallel:
 * the two reads drifted by 7 rows because other files create and delete
 * contacts in the window.
 */

// The account-link emit AND the journey re-ingest both reach the engine's
// MODULE-LEVEL `lib/hatchet.ts` singleton (the outbound delivery task is built
// from it at import time). Mocking the singleton keeps the whole flow off a
// live gRPC dial AND gives this file the `events.push` spy that IS the journey
// wire under test.
const { hatchetSingleton } = vi.hoisted(() => {
  const hatchet = {
    durableTask: vi.fn((config: Record<string, unknown>) => ({
      ...config,
      run: vi.fn(),
      runNoWait: vi.fn(),
      runAndWait: vi.fn(),
    })),
    task: vi.fn((config: Record<string, unknown>) => ({
      ...config,
      run: vi.fn(),
      runNoWait: vi.fn(async () => ({})),
    })),
    events: { push: vi.fn(async () => {}) },
    runs: { cancel: vi.fn(), get: vi.fn() },
    worker: vi.fn(),
  };
  return { hatchetSingleton: { hatchet } };
});
vi.mock(
  "../../../../packages/engine/src/lib/hatchet.ts",
  () => hatchetSingleton,
);
vi.mock(
  "../../../../packages/engine/src/lib/hatchet.js",
  () => hatchetSingleton,
);
vi.mock("../lib/hatchet.js", () => hatchetSingleton);

const {
  apiKeys,
  contacts,
  createDatabase,
  journeyStates,
  linkedAccounts,
  userEvents,
} = await import("@hogsend/db");
const { and, eq, like, sql } = await import("drizzle-orm");
const engine = await import("@hogsend/engine");
const {
  createApp,
  createHogsendClient,
  defineJourney,
  executeJourneyRun,
  signConnectorState,
} = engine;

type JourneyMeta = import("@hogsend/core/types").JourneyMeta;

const SECRET = "test-secret-for-vitest-minimum-32-characters-long";

/**
 * Short by necessity: the two provider ids below are `${RUN}steam` /
 * `${RUN}twitch` and `ACCOUNT_LINK_ID_RE` is /^[a-z][a-z0-9_-]{0,31}$/.
 */
const RUN = `ajt${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const STEAM = `${RUN}steam`;
const TWITCH = `${RUN}twitch`;

let seq = 0;
const uid = (label: string) => `${RUN}-${label}-${seq++}`;

const { db, client } = createDatabase({
  url: process.env.DATABASE_URL as string,
});

const steam = fakeAccountLink({ id: STEAM, name: "Fake Steam" });
const twitch = fakeAccountLink({ id: TWITCH, name: "Fake Twitch" });

const container = createHogsendClient({
  accountLinks: { providers: [steam, twitch] },
  // The singleton is already mocked above; the override pins the SAME handle
  // so the container's ingest and the module-level delivery task cannot end up
  // on two different dials.
  overrides: { hatchet: engine.hatchet },
});
const app = createApp(container);

const pushes = (
  engine.hatchet as unknown as {
    events: { push: ReturnType<typeof vi.fn> };
  }
).events.push;

let ipSeq = 0;
const freshIp = () => `${RUN}-${ipSeq++}`;

const journeyIds: string[] = [];

/** The `hatchet.events.push` payload `ingestEvent` sends for one event name. */
type PushInput = {
  userId: string;
  userEmail: string;
  /** SCALARS ONLY — `ingestEvent` filters the push payload to exactly this. */
  properties: Record<string, string | number | boolean | null>;
  contactId?: string;
  groups?: Record<string, string>;
};

/** Every push of `event` this file has seen, in call order. */
function pushedInputs(event: string): PushInput[] {
  return pushes.mock.calls
    .filter((call: unknown[]) => call[0] === event)
    .map((call: unknown[]) => call[1] as PushInput);
}

/** The stored `user_events` row for one account-link fact. */
async function storedEvent(event: string, userId: string) {
  const rows = await db
    .select({
      id: userEvents.id,
      event: userEvents.event,
      userId: userEvents.userId,
      properties: userEvents.properties,
      source: userEvents.source,
      idempotencyKey: userEvents.idempotencyKey,
      contactId: userEvents.contactId,
    })
    .from(userEvents)
    .where(and(eq(userEvents.event, event), eq(userEvents.userId, userId)));
  return rows;
}

/**
 * The re-ingest is fire-and-forget (the callback answers before it lands), so
 * absence has to be polled through rather than asserted immediately.
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

/** Absence cannot be polled for — give the re-ingest a window to not appear. */
const SETTLE_MS = 750;

function accountLinkState(over: Record<string, unknown> = {}): string {
  return signConnectorState(
    {
      purpose: "account_link",
      providerId: STEAM,
      nonce: uid("nonce"),
      ...over,
    },
    SECRET,
    900,
  );
}

function callback(state: string, providerId: string = STEAM) {
  return app.request(
    `/v1/accounts/${providerId}/callback?state=${encodeURIComponent(state)}`,
    { headers: { "x-forwarded-for": freshIp() } },
  );
}

/**
 * `externalId` DEFAULTS to a run-scoped id rather than NULL, and that is a
 * cleanup requirement: `afterAll` deletes by `external_id LIKE '<RUN>%'` /
 * `anonymous_id LIKE '<RUN>%'`, and neither predicate can match a NULL column.
 * A contact with all identity columns NULL is orphaned in the shared test
 * database forever.
 */
async function makeContact(fields: { externalId?: string; email?: string }) {
  const externalId = fields.externalId ?? uid("ext");
  const [row] = await db
    .insert(contacts)
    .values({ externalId, email: fields.email ?? null })
    .returning({ id: contacts.id });
  if (!row) throw new Error("contact insert failed");
  return { id: row.id, externalId };
}

async function countContacts(): Promise<number> {
  const rows = (await db.execute(
    sql`SELECT count(*)::int AS n FROM contacts`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? -1;
}

/**
 * Contacts carrying ONE value on ANY identity column.
 *
 * The precise, RUN-scoped form of the no-mint oracle, used by the cases that
 * know exactly which key a mint would land under. Deliberately NOT
 * {@link countContacts}: this file is already in the serial `WEBHOOK_FANOUT`
 * project for the ONE whole-table scan it has, and a second one would widen
 * that debt for no extra reach.
 */
async function countContactsKeyed(value: string): Promise<number> {
  const rows = (await db.execute(
    sql`SELECT count(*)::int AS n FROM contacts
        WHERE external_id = ${value}
           OR anonymous_id = ${value}
           OR email = ${value}`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? -1;
}

/** Contacts this RUN owns, on any identity column. The teardown oracle. */
async function countRunContacts(): Promise<number> {
  const rows = (await db.execute(
    sql`SELECT count(*)::int AS n FROM contacts
        WHERE external_id LIKE ${`${RUN}%`}
           OR anonymous_id LIKE ${`${RUN}%`}
           OR email LIKE ${`${RUN}%`}`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? -1;
}

/** Durable ctx stub: the run bodies below issue nothing durable. */
function makeCtx(workflowRunId: string) {
  return {
    workflowRunId: () => workflowRunId,
    sleepFor: async () => ({}),
    waitFor: async () => ({}),
    now: async () => new Date(),
  };
}

/**
 * Drive one hosted link end to end and hand back the fact BOTH planes saw:
 * the Hatchet push payload (the journey wire) and the pair it bound.
 */
async function link(opts: {
  provider: typeof steam;
  providerId: string;
  contactId: string;
  providerUserId: string;
  username?: string;
  contactKey: string;
}): Promise<PushInput> {
  opts.provider.proves({
    providerUserId: opts.providerUserId,
    ...(opts.username ? { username: opts.username } : {}),
  });
  const before = pushedInputs("account.linked").length;
  const res = await callback(
    accountLinkState({
      providerId: opts.providerId,
      contactId: opts.contactId,
    }),
    opts.providerId,
  );
  expect(res.status).toBe(200);
  // Poll the PUSH, not the `user_events` row: `ingestEvent` inserts the row
  // BEFORE it pushes, so a row-shaped wait races the wire this file is about.
  const seen = await waitFor(
    async () => pushedInputs("account.linked"),
    before + 1,
  );
  expect(seen.length).toBe(before + 1);
  const input = seen[before];
  if (!input) throw new Error("no account.linked push");
  // …and the durable row is there too, which is what the scalar guard reads.
  await waitFor(() => storedEvent("account.linked", opts.contactKey), 1);
  return input;
}

let contactsBaseline = 0;

/**
 * The `accounts`-scoped operator key, for the DELETE that is the cheapest
 * intent-layer entry to `noteUnlinked` (`routes/accounts/unlink.ts` →
 * `emit.ts`). Seeded here rather than reaching into the store directly on
 * purpose: DECISIONS §15.7 puts the emit in the INTENT layer, so a test that
 * called `unlinkAccount` would assert nothing about the wire under test.
 */
const ACCOUNTS_KEY = `hsk_test_${RUN}_accounts`;
const keyIds: string[] = [];
const authed = () => ({ Authorization: `Bearer ${ACCOUNTS_KEY}` });

beforeAll(async () => {
  contactsBaseline = await countRunContacts();
  expect(contactsBaseline).toBe(0);

  const [key] = await db
    .insert(apiKeys)
    .values({
      name: `${RUN} accounts`,
      keyPrefix: ACCOUNTS_KEY.slice(0, 8),
      keyHash: createHash("sha256").update(ACCOUNTS_KEY).digest("hex"),
      scopes: ["accounts"],
    })
    .returning({ id: apiKeys.id });
  if (key) keyIds.push(key.id);
});

beforeEach(() => {
  steam.fails(null);
  twitch.fails(null);
});

afterAll(async () => {
  if (journeyIds.length > 0) {
    for (const id of journeyIds) {
      await db.delete(journeyStates).where(eq(journeyStates.journeyId, id));
    }
  }
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}%`));
  for (const id of keyIds) await db.delete(apiKeys).where(eq(apiKeys.id, id));
  await db.delete(linkedAccounts).where(eq(linkedAccounts.provider, STEAM));
  await db.delete(linkedAccounts).where(eq(linkedAccounts.provider, TWITCH));
  // Both predicates are LIKE on a NOT-NULL-only match — see `makeContact`.
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}%`));
  await db.delete(contacts).where(like(contacts.anonymousId, `${RUN}%`));

  // THE TEARDOWN ORACLE. A global before/after count cannot be asserted in a
  // file-parallel suite (other files mint contacts throughout), so the exact
  // form is asserted instead: zero contacts owning ANY `<RUN>%` identity
  // column survive this file. A ghost minted under an id this file never
  // predicted still carries the run prefix, because every key this file feeds
  // the resolver carries it.
  const leaked = await countRunContacts();
  await client.end();
  if (leaked !== 0) {
    throw new Error(
      `accounts-journey-trigger leaked ${leaked} contacts into the shared ` +
        `test database (baseline ${contactsBaseline})`,
    );
  }
});

// ---------------------------------------------------------------------------

describe("account.linked reaches the journey plane", () => {
  it("enrolls a journey triggered on account.linked", async () => {
    const owner = await makeContact({ email: `${uid("owner")}@example.test` });
    const providerUserId = uid("puid");

    const input = await link({
      provider: steam,
      providerId: STEAM,
      contactId: owner.id,
      providerUserId,
      username: "player-one",
      contactKey: owner.externalId,
    });

    // The wire the journey actually receives.
    expect(input.userId).toBe(owner.externalId);
    expect(input.contactId).toBe(owner.id);
    expect(input.properties).toMatchObject({
      state: "linked",
      provider: STEAM,
      providerUserId,
      username: "player-one",
      method: "oauth",
      relink: false,
      version: "1",
    });

    const journeyId = uid("j-enroll");
    journeyIds.push(journeyId);
    const journey = defineJourney({
      meta: {
        id: journeyId,
        name: "Account linked welcome",
        enabled: true,
        trigger: { event: "account.linked" },
        entryLimit: "once",
        suppress: {},
      },
      run: async () => {},
    });

    const result = await executeJourneyRun({
      meta: journey.meta as JourneyMeta,
      run: async () => {},
      input,
      hatchetCtx: makeCtx(`${RUN}-wfr-enroll`),
    });
    expect(result).toMatchObject({ status: "completed" });

    const states = await db
      .select({ id: journeyStates.id, contactId: journeyStates.contactId })
      .from(journeyStates)
      .where(eq(journeyStates.journeyId, journeyId));
    expect(states).toHaveLength(1);
    expect(states[0]?.contactId).toBe(owner.id);
  });

  it("pins a COLD link to the contact it minted, never a second external-keyed row", async () => {
    // THE PROVENANCE PIN (`lib/account-link-ingest.ts`, `contactId:
    // facts.owner.contactId`). Every OTHER case in this file drives the WARM
    // callback, where `owner.userId` is already the contact's own external key
    // and the pin is redundant — so none of them can see it go missing.
    //
    // Cold is the case this feature creates the MOST of, and the one the pin
    // exists for: `owner.userId` is `contactKey()` = `external_id ??
    // anonymous_id ?? id`, which for a cold link is the ANONYMOUS id. Passed
    // bare, `findByKey` reads it as kind `external` and mints a SECOND row with
    // `external_id = <anonId>` — which then trips `collidesWithIdentified` and
    // locks that visitor out of their own feed. Strictly worse than a ghost.
    const anonymousId = uid("cold-anon");
    const providerUserId = uid("cold-puid");
    steam.proves({ providerUserId, username: "cold-player" });

    const before = pushedInputs("account.linked").length;
    const res = await callback(accountLinkState({ anonymousId }));
    expect(res.status).toBe(200);

    // The contact the COLD callback itself minted (`resolveOrCreateContact`
    // with `create: "on-miss"`), keyed on the anon id. This is the ONE row the
    // whole flow is allowed to have created.
    const [minted] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.anonymousId, anonymousId));
    expect(minted).toBeDefined();

    const seen = await waitFor(
      async () => pushedInputs("account.linked"),
      before + 1,
    );
    expect(seen.length).toBe(before + 1);
    const input = seen[before];
    // The wire: the anon id is the value key, and the pin rides beside it.
    expect(input?.userId).toBe(anonymousId);
    expect(input?.contactId).toBe(minted?.id);

    const rows = await waitFor(
      () => storedEvent("account.linked", anonymousId),
      1,
    );
    expect(rows).toHaveLength(1);
    // The durable proof: the observation is attributed to the contact the link
    // actually bound, not to a row re-derived from the bare key.
    expect(rows[0]?.contactId).toBe(minted?.id);

    // THE GHOST-CONTACT LAW, named as the exact row it forbids rather than as a
    // total. A bare count would also pass if the doppelganger were minted and
    // the real contact were somehow absent; this cannot.
    expect(
      await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(eq(contacts.externalId, anonymousId)),
    ).toHaveLength(0);
    // …and exactly ONE contact carries that value on ANY identity column.
    expect(await countContactsKeyed(anonymousId)).toBe(1);
  });

  it("selects steam and skips twitch on a `where` clause over `provider`", async () => {
    // THE DECISIONS §8 HEADLINE CASE. A publisher's Steam journey must not
    // fire for a Twitch link, and the ONLY thing that can make that true is
    // `provider` arriving as a scalar `eventProperties` entry: a `where`
    // clause reads `properties` off the push payload, and `ingestEvent`
    // filters that payload to scalars.
    const player = await makeContact({});
    const steamPush = await link({
      provider: steam,
      providerId: STEAM,
      contactId: player.id,
      providerUserId: uid("steam-puid"),
      contactKey: player.externalId,
    });
    const twitchPush = await link({
      provider: twitch,
      providerId: TWITCH,
      contactId: player.id,
      providerUserId: uid("twitch-puid"),
      contactKey: player.externalId,
    });

    const journeyId = uid("j-where");
    journeyIds.push(journeyId);
    const journey = defineJourney({
      meta: {
        id: journeyId,
        name: "Steam linked only",
        enabled: true,
        trigger: {
          event: "account.linked",
          where: (b) => b.prop("provider").eq(STEAM),
        },
        entryLimit: "once",
        suppress: {},
      },
      run: async () => {},
    });

    const twitchResult = await executeJourneyRun({
      meta: journey.meta as JourneyMeta,
      run: async () => {},
      input: twitchPush,
      hatchetCtx: makeCtx(`${RUN}-wfr-twitch`),
    });
    expect(twitchResult).toEqual({
      status: "skipped",
      reason: "trigger_conditions_not_met",
    });
    expect(
      await db
        .select({ id: journeyStates.id })
        .from(journeyStates)
        .where(eq(journeyStates.journeyId, journeyId)),
    ).toHaveLength(0);

    const steamResult = await executeJourneyRun({
      meta: journey.meta as JourneyMeta,
      run: async () => {},
      input: steamPush,
      hatchetCtx: makeCtx(`${RUN}-wfr-steam`),
    });
    expect(steamResult).toMatchObject({ status: "completed" });
    expect(
      await db
        .select({ id: journeyStates.id })
        .from(journeyStates)
        .where(eq(journeyStates.journeyId, journeyId)),
    ).toHaveLength(1);
  });

  it("carries only scalar event properties", async () => {
    const owner = await makeContact({});
    const providerUserId = uid("puid");
    await link({
      provider: steam,
      providerId: STEAM,
      contactId: owner.id,
      providerUserId,
      username: "scalar-check",
      contactKey: owner.externalId,
    });

    const [row] = await storedEvent("account.linked", owner.externalId);
    expect(row).toBeDefined();
    const properties = row?.properties as Record<string, unknown>;

    // ITERATED, never a hardcoded list: a field added later as an object (a
    // provider profile, a raw payload, a tokens blob) or as an array must fail
    // HERE. It would NOT fail in a journey — `ingestEvent` silently drops
    // non-scalars from the Hatchet payload, so a `where` clause on it just
    // never matches, forever, with no error anywhere.
    const keys = Object.keys(properties);
    expect(keys.length).toBeGreaterThan(0);
    for (const [key, value] of Object.entries(properties)) {
      const scalar =
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean";
      expect(
        scalar,
        `account.linked eventProperty "${key}" is ${
          Array.isArray(value) ? "an array" : typeof value
        }; DECISIONS §8 allows string | number | boolean | null only`,
      ).toBe(true);
    }

    expect(row?.source).toBe("account_link");
    // Rule 5: the SAME string the outbound plane uses as its `dedupeKey`, so a
    // retried callback routes at most one enrollment.
    expect(row?.idempotencyKey).toBe(`al:${STEAM}:${providerUserId}:v1`);
    expect(row?.contactId).toBe(owner.id);
  });

  it("stores one event per version, so a repeat at the same version enrolls once", async () => {
    const owner = await makeContact({});
    const providerUserId = uid("puid");
    await link({
      provider: steam,
      providerId: STEAM,
      contactId: owner.id,
      providerUserId,
      contactKey: owner.externalId,
    });

    const key = `al:${STEAM}:${providerUserId}:v1`;
    expect(await storedEvent("account.linked", owner.externalId)).toHaveLength(
      1,
    );

    // Re-drive the SAME fact through the SAME public entry point the re-ingest
    // uses, with the same key. `user_events.idempotency_key` is unique, so the
    // second call stores nothing — which is what makes a retried callback at
    // most one enrollment rather than two.
    const repeat = await engine.ingestEvent({
      db,
      registry: container.registry,
      hatchet: container.hatchet,
      logger: container.logger,
      event: {
        event: "account.linked",
        userId: owner.externalId,
        contactId: owner.id,
        eventProperties: {
          state: "linked",
          provider: STEAM,
          providerUserId,
          username: null,
          method: "oauth",
          relink: false,
          version: "1",
        },
        source: "account_link",
        idempotencyKey: key,
      },
    });
    expect(repeat.stored).toBe(false);
    expect(await storedEvent("account.linked", owner.externalId)).toHaveLength(
      1,
    );
  });
});

describe("account.unlinked reaches the journey plane", () => {
  it("enrolls a journey triggered on account.unlinked, attributed to the owner", async () => {
    // The `noteUnlinked` chokepoint (`routes/accounts/emit.ts`), reached
    // through the INTENT layer the way production reaches it — the operator
    // `DELETE`, via `routes/accounts/unlink.ts`. Calling `unlinkAccount`
    // directly would assert nothing: DECISIONS §15.7 says the STORE never
    // emits, so the re-ingest lives entirely in the layer above it.
    const owner = await makeContact({});
    const providerUserId = uid("unlink-puid");
    await link({
      provider: steam,
      providerId: STEAM,
      contactId: owner.id,
      providerUserId,
      contactKey: owner.externalId,
    });

    const before = pushedInputs("account.unlinked").length;
    const res = await app.request(`/v1/accounts/${STEAM}/${providerUserId}`, {
      method: "DELETE",
      headers: authed(),
    });
    expect(res.status).toBe(200);
    // v1 was the link; the unlink consumes the next version in the pair's own
    // sequence, and that version is what both planes key on.
    expect(await res.json()).toEqual({ unlinked: true, version: "2" });

    const seen = await waitFor(
      async () => pushedInputs("account.unlinked"),
      before + 1,
    );
    expect(seen.length).toBe(before + 1);
    const input = seen[before];
    if (!input) throw new Error("no account.unlinked push");
    expect(input.userId).toBe(owner.externalId);
    expect(input.contactId).toBe(owner.id);
    expect(input.properties).toMatchObject({
      state: "unlinked",
      provider: STEAM,
      providerUserId,
      reason: "api",
      version: "2",
    });

    const rows = await waitFor(
      () => storedEvent("account.unlinked", owner.externalId),
      1,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBe(owner.id);
    expect(rows[0]?.source).toBe("account_link");
    // Keyed on the pair's OWN version, so it cannot collide with the
    // `account.linked` at v1 and be silently swallowed by the unique index.
    expect(rows[0]?.idempotencyKey).toBe(`al:${STEAM}:${providerUserId}:v2`);

    const journeyId = uid("j-unlinked");
    journeyIds.push(journeyId);
    const journey = defineJourney({
      meta: {
        id: journeyId,
        name: "Account unlinked winback",
        enabled: true,
        trigger: { event: "account.unlinked" },
        entryLimit: "once",
        suppress: {},
      },
      run: async () => {},
    });

    const result = await executeJourneyRun({
      meta: journey.meta as JourneyMeta,
      run: async () => {},
      input,
      hatchetCtx: makeCtx(`${RUN}-wfr-unlinked`),
    });
    expect(result).toMatchObject({ status: "completed" });

    const states = await db
      .select({ id: journeyStates.id, contactId: journeyStates.contactId })
      .from(journeyStates)
      .where(eq(journeyStates.journeyId, journeyId));
    expect(states).toHaveLength(1);
    expect(states[0]?.contactId).toBe(owner.id);
  });

  it("reaches the DISPLACED owner when a relink moves a platform account", async () => {
    // The OTHER `noteUnlinked` invocation — the one `noteLinked` chains ahead
    // of the `account.linked` when the same platform account changes hands.
    // Structurally distinct from the revoke leg above: it fires from inside
    // the link path, off `result.previous`, for a contact who did nothing.
    // That contact is exactly who a "you lost your Steam link" journey is for,
    // so this arm going quiet is invisible from the operator revoke's coverage.
    const first = await makeContact({});
    const second = await makeContact({});
    const providerUserId = uid("relink-puid");
    await link({
      provider: steam,
      providerId: STEAM,
      contactId: first.id,
      providerUserId,
      contactKey: first.externalId,
    });

    const before = pushedInputs("account.unlinked").length;
    // The SAME platform account, now proven under the second contact's warm
    // state — the one path in the feature allowed to displace a live owner.
    const linkedPush = await link({
      provider: steam,
      providerId: STEAM,
      contactId: second.id,
      providerUserId,
      contactKey: second.externalId,
    });

    const seen = await waitFor(
      async () => pushedInputs("account.unlinked"),
      before + 1,
    );
    expect(seen.length).toBe(before + 1);
    const unlinkedPush = seen[before];
    // Attributed to the DISPLACED owner, not to the contact that acted.
    expect(unlinkedPush?.userId).toBe(first.externalId);
    expect(unlinkedPush?.contactId).toBe(first.id);
    expect(unlinkedPush?.properties).toMatchObject({
      state: "unlinked",
      provider: STEAM,
      providerUserId,
      reason: "relinked",
    });

    const rows = await waitFor(
      () => storedEvent("account.unlinked", first.externalId),
      1,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBe(first.id);

    // THE VERSIONS, which are what keeps this pair of facts distinguishable.
    // The displacement consumes its OWN version rather than replaying the one
    // the first link used — if it reused v1, its key would collide with that
    // link's `account.linked` on the GLOBAL `user_events.idempotency_key`
    // unique index and this enrollment would be silently dropped.
    expect(rows[0]?.idempotencyKey).toBe(`al:${STEAM}:${providerUserId}:v2`);
    expect(linkedPush.properties).toMatchObject({
      relink: true,
      version: "3",
    });
    expect(unlinkedPush?.properties.version).toBe("2");
  });
});

describe("account.link_failed reaches the journey plane without minting", () => {
  it("stores the failure under the cold anonymous key and creates NO contact", async () => {
    // The COLD path is the only one that could plausibly mint: it carries a
    // browser-supplied anonymous id and no contact. The provider refuses after
    // the state verified — the latest a failure can happen with no contact in
    // hand.
    const anonymousId = uid("anon");
    const { AccountLinkCallbackError } = await import("@hogsend/core");
    steam.fails(
      new AccountLinkCallbackError("denied", "player pressed cancel"),
    );

    const before = await countContacts();

    const res = await callback(accountLinkState({ anonymousId }));
    expect(res.status).toBe(400);

    // The fact DID reach the journey plane — without this the no-mint count
    // below would pass vacuously, on a re-ingest that never ran.
    const rows = await waitFor(
      () => storedEvent("account.link_failed", anonymousId),
      1,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.properties).toEqual({ provider: STEAM, reason: "denied" });
    // No version, so no idempotency key: two genuine failures are two facts.
    expect(rows[0]?.idempotencyKey).toBeNull();

    // COUNTED, not sampled, and asserted FIRST: this is the DECISIONS §8
    // "never mints a contact" guard, and only a before/after count of the
    // whole table can see a row minted under a key this test did not predict.
    // `allowCreate: false` on the re-ingest is what makes it structural.
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    expect(await countContacts()).toBe(before);

    // The resolve REFUSED, so the row is contactless by design (D2: the
    // observation is kept, the CRM row deliberately is not).
    expect(rows[0]?.contactId).toBeNull();
    expect(
      await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(eq(contacts.anonymousId, anonymousId)),
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(eq(contacts.externalId, anonymousId)),
    ).toHaveLength(0);
  });

  it("refuses to file a cold failure onto an IDENTIFIED contact's timeline", async () => {
    // THE INJECTION SCREEN (`account-link-ingest.ts` → `screenAnonymousId` →
    // `collidesWithIdentified`). The cold arm's key arrives on an
    // UNAUTHENTICATED URL and nothing about it is proven, so an attacker can
    // name any identified contact they can guess a key for. `allowCreate:
    // false` stops the MINT; it does not stop the row being filed under the
    // victim's canonical key — a forged `account.link_failed` in a real
    // person's timeline, for any journey to trigger on.
    //
    // The one existing cold case passes a FRESH anon id that collides with
    // nothing, so the guard never fires there.
    const victim = await makeContact({
      email: `${uid("victim")}@example.test`,
    });
    // The victim's `external_id` IS their canonical key — the value every
    // `user_events` row of theirs is keyed on.
    const { AccountLinkCallbackError } = await import("@hogsend/core");
    steam.fails(
      new AccountLinkCallbackError("denied", "player pressed cancel"),
    );

    const res = await callback(
      accountLinkState({ anonymousId: victim.externalId }),
    );
    expect(res.status).toBe(400);

    // Absence, so a settle window rather than a poll.
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    expect(
      await storedEvent("account.link_failed", victim.externalId),
    ).toHaveLength(0);
    // …and nothing reached the victim by the pin either.
    expect(
      await db
        .select({ id: userEvents.id })
        .from(userEvents)
        .where(
          and(
            eq(userEvents.event, "account.link_failed"),
            eq(userEvents.contactId, victim.id),
          ),
        ),
    ).toHaveLength(0);
    // The victim is untouched: still exactly one contact on that key.
    expect(await countContactsKeyed(victim.externalId)).toBe(1);
  });

  it("attributes a WARM failure to the sealed contact and mints nothing", async () => {
    // The sealed arm of `ingestAccountLinkFailed`. `contactId` here is
    // SERVER-MINTED and unforgeable (it came out of a state that verified), so
    // unlike the cold arm it is screened by nothing — which is exactly why the
    // attribution needs pinning down.
    const owner = await makeContact({});
    const { AccountLinkCallbackError } = await import("@hogsend/core");
    steam.fails(
      new AccountLinkCallbackError("denied", "player pressed cancel"),
    );

    const res = await callback(accountLinkState({ contactId: owner.id }));
    expect(res.status).toBe(400);

    // The warm arm supplies the contact uuid as BOTH the value key and the
    // pin; `ingestEvent` stores the row under the RESOLVED canonical key, so
    // what lands is the contact's `external_id` — the same key every other row
    // of theirs is filed under, which is what makes the failure legible beside
    // the rest of their timeline rather than orphaned under a uuid.
    const rows = await waitFor(
      () => storedEvent("account.link_failed", owner.externalId),
      1,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contactId).toBe(owner.id);
    expect(rows[0]?.properties).toEqual({ provider: STEAM, reason: "denied" });
    // No version, so no idempotency key — two genuine failures are two facts.
    expect(rows[0]?.idempotencyKey).toBeNull();
    expect(rows[0]?.source).toBe("account_link");

    // No mint, on EITHER key the flow touched: the uuid the resolver was
    // handed, and the contact's own external id.
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    expect(await countContactsKeyed(owner.id)).toBe(0);
    expect(await countContactsKeyed(owner.externalId)).toBe(1);
  });
});
