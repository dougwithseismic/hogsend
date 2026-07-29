/**
 * PRD 07 T7 — the residual resolution reads are OFF the identity columns.
 *
 * Five sites used to answer "which contact owns this key string?" with a naked
 * `eq(contacts.external_id/anonymous_id, value)` probe. A column probe is blind
 * to a MERGED-AWAY key twice over: the loser's row is soft-deleted (so an
 * alias-only key resolves nothing) and the loser still HOLDS its `external_id`
 * (so a probe with no `deleted_at` filter reads the TOMBSTONE in preference to
 * the live survivor). Every test below drives a REAL merge and asserts the
 * flipped site now lands on the survivor.
 */
import { afterAll, describe, expect, it, vi } from "vitest";

// DB-touching test. The DEFAULT below is the repo-wide one every file in this
// directory shares, and it is what CI's service container listens on. Point a
// worktree at its own stack by exporting HOGSEND_TEST_DATABASE_URL — never by
// editing the default.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Config-preserving Hatchet mock that CAPTURES each journey's durable fn by
// task name (the journey-holdout harness pattern), so the run lifecycle — and
// with it the flipped timezone/provenance reads — executes for real against
// real Postgres without a live broker.
const { capturedFns, hatchetMock } = vi.hoisted(() => {
  type CapturedFn = (input: unknown, ctx: unknown) => Promise<unknown>;
  const captured = new Map<string, CapturedFn>();
  const factory = () => ({
    hatchet: {
      durableTask: vi.fn((config: { name: string; fn: CapturedFn }) => {
        captured.set(config.name, config.fn);
        return { run: vi.fn(), runNoWait: vi.fn(), runAndWait: vi.fn() };
      }),
      task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn(async () => ({})) })),
      events: { push: vi.fn(async () => {}) },
      runs: { cancel: vi.fn(), get: vi.fn() },
      worker: vi.fn(),
    },
  });
  return { capturedFns: captured, hatchetMock: factory };
});

vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

const { contactAliases, contacts, journeyStates, userEvents } = await import(
  "@hogsend/db"
);
const { and, eq, inArray, isNull, like, or } = await import("drizzle-orm");
const {
  createApp,
  createHogsendClient,
  defineConnectorAction,
  defineJourney,
  isHeldOut,
  resolveOrCreateContact,
  sendConnectorAction,
  setContactTimezone,
  setJourneyRegistry,
} = await import("@hogsend/engine");
const { JourneyRegistry } = await import("@hogsend/core/registry");

// `lookupContactIdByKey` is engine-INTERNAL (not in the public index), so the
// primitive-level proof imports the module by path — the same hatch
// contact-id-dualwrite-preferences.test.ts uses.
const contactsModulePath = new URL(
  "../../../../packages/engine/src/lib/contacts.ts",
  import.meta.url,
).pathname;
const { lookupContactIdByKey } = (await import(
  /* @vite-ignore */ contactsModulePath
)) as {
  lookupContactIdByKey: (db: unknown, key: string) => Promise<string | null>;
};

const RUN = `raf-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const uid = (label: string) => `${RUN}-${label}`;
const mail = (label: string) => `${RUN}-${label}@example.com`;
/** The stale (merged-away) key `mergedPair(label)` produces, derivable before
 * the DB work so a journey id can be chosen against it at module scope. */
const staleKeyFor = (label: string) => uid(`${label}-stale`);

// --- the connector action under test (site 3) ------------------------------
const resolveAction = defineConnectorAction<
  { ref: string },
  { id: string } | null
>({
  connectorId: "test",
  name: "resolve",
  run: async (args, ctx) =>
    (await ctx.resolveContact(args.ref)) as { id: string } | null,
});

const container = createHogsendClient({ connectorActions: [resolveAction] });
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};

// --- the journeys under test (site 4) --------------------------------------
const TZ_JOURNEY_ID = `${RUN}-tz-journey`;
/** The holdout diversion is deterministic per (user, journey), and the stale
 * key is fixed by `mergedPair`, so the JOURNEY id is what gets searched. */
const HELDOUT_JOURNEY_ID = (() => {
  const userId = staleKeyFor("heldout");
  for (let i = 0; i < 1000; i++) {
    const journeyId = `${RUN}-heldout-j${i}`;
    if (isHeldOut({ userId, journeyId, percent: 50 })) return journeyId;
  }
  throw new Error("no held-out journey id found");
})();

let capturedInstant: Date | undefined;
const readInstant = () => capturedInstant;

const tzJourney = defineJourney({
  meta: {
    id: TZ_JOURNEY_ID,
    name: "Timezone flip",
    enabled: true,
    trigger: { event: `${RUN}.tz` },
    entryLimit: "unlimited",
    suppress: { hours: 0 },
  },
  // `ctx.when` is bound to the timezone the run lifecycle resolved, so the
  // instant this records IS the observable for that resolution.
  run: async (_user, ctx) => {
    capturedInstant = ctx.when.tomorrow().at("09:00");
  },
});

const heldOutJourney = defineJourney({
  meta: {
    id: HELDOUT_JOURNEY_ID,
    name: "Holdout provenance flip",
    enabled: true,
    trigger: { event: `${RUN}.heldout` },
    entryLimit: "unlimited",
    suppress: { hours: 0 },
    holdout: { percent: 50 },
  },
  run: async () => {},
});

const registry = new JourneyRegistry();
registry.register(tzJourney.meta);
registry.register(heldOutJourney.meta);
setJourneyRegistry(registry);

const journeyFn = (id: string) => {
  const fn = capturedFns.get(`journey-${id}`);
  if (!fn) throw new Error(`durable fn for ${id} was not captured`);
  return fn;
};
const runCtx = (runId: string) => ({
  workflowRunId: () => runId,
  sleepFor: async () => ({}),
  waitFor: async () => ({}),
  now: async () => new Date(),
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const createdContactIds: string[] = [];

/**
 * Drive a REAL merge and return the survivor plus the loser's now-STALE key.
 * Two identified contacts (the shared-browser shape) collide on the loser's
 * email; the older survives, the loser is soft-deleted with its `external_id`
 * still in place, and that key lives on ONLY as an alias on the survivor.
 */
async function mergedPair(label: string) {
  const survivorKey = uid(`${label}-survivor`);
  const staleKey = staleKeyFor(label);
  const survivorEmail = mail(`${label}-survivor`);
  const loserEmail = mail(`${label}-loser`);

  const survivor = await resolveOrCreateContact({
    db,
    userId: survivorKey,
    email: survivorEmail,
  });
  createdContactIds.push(survivor.id);
  const loser = await resolveOrCreateContact({
    db,
    userId: staleKey,
    email: loserEmail,
  });
  createdContactIds.push(loser.id);

  const merged = await resolveOrCreateContact({
    db,
    userId: survivorKey,
    email: loserEmail,
  });
  expect(merged.id).toBe(survivor.id);

  // The merge really happened, and the stale key is column-invisible: the
  // loser is soft-deleted (still holding `external_id`) and the only LIVE
  // owner of the key is the survivor, through the identity table.
  const liveColumnHits = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        isNull(contacts.deletedAt),
        or(
          eq(contacts.externalId, staleKey),
          eq(contacts.anonymousId, staleKey),
        ),
      ),
    );
  expect(liveColumnHits).toHaveLength(0);
  const [loserRow] = await db
    .select({ deletedAt: contacts.deletedAt, externalId: contacts.externalId })
    .from(contacts)
    .where(eq(contacts.id, loser.id));
  expect(loserRow?.deletedAt).not.toBeNull();
  expect(loserRow?.externalId).toBe(staleKey);

  return {
    survivorId: survivor.id,
    survivorKey,
    survivorEmail,
    staleKey,
    loserId: loser.id,
  };
}

afterAll(async () => {
  await db
    .delete(journeyStates)
    .where(
      inArray(journeyStates.journeyId, [TZ_JOURNEY_ID, HELDOUT_JOURNEY_ID]),
    );
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  await db
    .delete(contactAliases)
    .where(like(contactAliases.aliasValue, `${RUN}-%`));
  if (createdContactIds.length > 0) {
    await db
      .delete(contactAliases)
      .where(inArray(contactAliases.contactId, createdContactIds));
    await db.delete(contacts).where(inArray(contacts.id, createdContactIds));
  }
  await container.dbClient.end({ timeout: 5 }).catch(() => {});
});

// Site 1 — lib/refine.ts — tested in refine-contact.test.ts (its lookups
// spend the enrichment ledger, and that file's monthly-cap tests count the
// WHOLE ledger; a concurrent spender flips them red at random).

// ---------------------------------------------------------------------------
// Site 2 — lib/timezone.ts
// ---------------------------------------------------------------------------

describe("setContactTimezone (lib/timezone.ts)", () => {
  it("a merged-away userId writes the SURVIVOR, never the tombstone", async () => {
    const { survivorId, staleKey, loserId } = await mergedPair("tz");

    const result = await setContactTimezone({
      db,
      userId: staleKey,
      timezone: "Asia/Tokyo",
    });
    expect(result.updated).toBe(true);

    // Before the flip the UPDATE matched the soft-deleted loser (it still holds
    // `external_id` and the probe carried no `deleted_at` filter), so it
    // reported `updated: true` while the live contact kept no timezone at all.
    const [survivorRow] = await db
      .select({ timezone: contacts.timezone })
      .from(contacts)
      .where(eq(contacts.id, survivorId));
    expect(survivorRow?.timezone).toBe("Asia/Tokyo");
    const [loserRow] = await db
      .select({ timezone: contacts.timezone })
      .from(contacts)
      .where(eq(contacts.id, loserId));
    expect(loserRow?.timezone).toBeNull();
  });

  it("an unowned userId reports updated: false (miss behaviour preserved)", async () => {
    const result = await setContactTimezone({
      db,
      userId: uid("tz-nobody"),
      timezone: "Asia/Tokyo",
    });
    expect(result.updated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Site 3 — lib/connector-actions.ts
// ---------------------------------------------------------------------------

describe("connector action resolveContact (lib/connector-actions.ts)", () => {
  const call = async (ref: string) =>
    (await sendConnectorAction({
      connectorId: "test",
      action: "resolve",
      args: { ref },
    })) as { id: string } | null;

  it("a merged-away member ref resolves the SURVIVOR", async () => {
    const { survivorId, staleKey } = await mergedPair("connector");
    const resolved = await call(staleKey);
    expect(resolved?.id).toBe(survivorId);
  });

  it("live external / email / uuid refs still resolve, unknown refs miss", async () => {
    const { survivorId, survivorKey, survivorEmail } =
      await mergedPair("connector-live");
    for (const ref of [survivorKey, survivorEmail, survivorId]) {
      const resolved = await call(ref);
      expect(resolved?.id, `ref ${ref} should resolve`).toBe(survivorId);
    }
    expect(await call(uid("connector-nobody"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Site 4 — journeys/execute-journey-run.ts
// ---------------------------------------------------------------------------

describe("journey run subject reads (journeys/execute-journey-run.ts)", () => {
  it("resolves the timezone from the SURVIVOR, not the merged-away tombstone", async () => {
    const { survivorId, staleKey, loserId } = await mergedPair("jtz");
    await db
      .update(contacts)
      .set({ timezone: "Asia/Tokyo" })
      .where(eq(contacts.id, survivorId));
    // The tombstone carries a DIFFERENT zone, so the assertion below fails
    // loudly if the read ever goes back to `external_id` (which matches it).
    await db
      .update(contacts)
      .set({ timezone: "America/New_York" })
      .where(eq(contacts.id, loserId));

    capturedInstant = undefined;
    const result = await journeyFn(TZ_JOURNEY_ID)(
      { userId: staleKey, userEmail: "", properties: {} },
      runCtx(`${RUN}-tz-run`),
    );
    expect(result).toMatchObject({ status: "completed" });

    // 09:00 in Tokyo (UTC+9, no DST) is 00:00 UTC. New York would be 13/14 and
    // the UTC fallback 09. Read through `readInstant()` because the journey
    // writes the variable from inside a closure the compiler cannot see, so a
    // direct read is still narrowed to the `undefined` assigned above.
    const instant = readInstant();
    expect(instant).toBeInstanceOf(Date);
    expect(instant?.getUTCHours()).toBe(0);
  });

  it("pins the held-out re-emit to the SURVIVOR for a merged-away key", async () => {
    const { survivorId, survivorKey, staleKey } = await mergedPair("heldout");

    const result = await journeyFn(HELDOUT_JOURNEY_ID)(
      { userId: staleKey, userEmail: "", properties: {} },
      runCtx(`${RUN}-heldout-run`),
    );
    expect(result).toMatchObject({ status: "skipped", reason: "held_out" });

    // The `journey.heldout` spine event is owned by the survivor: the flipped
    // probe supplies the provenance pin (and, with it, the create verdict) for
    // a key no identity column carries. `ingestEvent` stores the event under
    // the RESOLVED canonical key, so the row lands on the survivor's key — no
    // phantom `external_id = <staleKey>` twin was minted.
    const spine = await db
      .select({ contactId: userEvents.contactId, userId: userEvents.userId })
      .from(userEvents)
      .where(
        and(
          eq(userEvents.event, "journey.heldout"),
          or(
            eq(userEvents.userId, staleKey),
            eq(userEvents.userId, survivorKey),
          ),
        ),
      );
    expect(spine).toHaveLength(1);
    expect(spine[0]?.contactId).toBe(survivorId);
    expect(spine[0]?.userId).toBe(survivorKey);
  });

  it("lookupContactIdByKey answers what the old column probe could not", async () => {
    // The primitive both journey sites now route through, pinned directly:
    // survivor for a stale key, null for an unowned one.
    const { survivorId, staleKey } = await mergedPair("lookup");
    expect(await lookupContactIdByKey(db, staleKey)).toBe(survivorId);
    expect(await lookupContactIdByKey(db, uid("lookup-nobody"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Site 5 — routes/admin/contacts.ts (the minRevenue subject scope)
// ---------------------------------------------------------------------------

describe("GET /v1/admin/contacts?minRevenue (routes/admin/contacts.ts)", () => {
  it("counts revenue owned by contact_id under a frozen user_id", async () => {
    const { survivorId, survivorKey } = await mergedPair("revenue");

    // The adoption/merge shape: `contact_id` stamped on the owner, `user_id`
    // frozen at the key observed when the row was written. The old
    // `user_id = coalesce(external_id, anonymous_id, id::text)` filter scored
    // this contact at zero revenue.
    await db.insert(userEvents).values({
      event: `${RUN}.purchase`,
      userId: staleKeyFor("revenue"),
      contactId: survivorId,
      value: 500,
      currency: "USD",
      properties: {},
    });

    const res = await app.request(
      `/v1/admin/contacts?identity=all&minRevenue=100&search=${encodeURIComponent(
        survivorKey,
      )}`,
      { method: "GET", headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { contacts: Array<{ id: string }> };
    expect(body.contacts.map((c) => c.id)).toContain(survivorId);
  });

  it("still excludes a contact whose valued events are below the floor", async () => {
    const { survivorId, survivorKey } = await mergedPair("revenue-low");
    await db.insert(userEvents).values({
      event: `${RUN}.purchase`,
      userId: survivorKey,
      contactId: survivorId,
      value: 5,
      currency: "USD",
      properties: {},
    });

    const res = await app.request(
      `/v1/admin/contacts?identity=all&minRevenue=100&search=${encodeURIComponent(
        survivorKey,
      )}`,
      { method: "GET", headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { contacts: Array<{ id: string }> };
    expect(body.contacts.map((c) => c.id)).not.toContain(survivorId);
  });
});
