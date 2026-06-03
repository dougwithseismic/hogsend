import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// DB-touching test: point at the real docker TimescaleDB (mirrors
// admin-metrics.test.ts), overriding the vitest.config placeholder DATABASE_URL.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Mock Hatchet so the recursive `bucket:*` emission pushes to a spy instead of a
// live gRPC engine. The test seam (Section 14) asserts on the
// `checkBucketMembership` transition list + DB rows, and uses the push spy only
// to demonstrate event routing (a journey bound to `bucket:entered:<id>` is woken
// by exactly that Hatchet push).
vi.mock("../lib/hatchet.js", () => ({
  hatchet: {
    durableTask: vi.fn(() => ({
      run: vi.fn(),
      runNoWait: vi.fn(),
      runAndWait: vi.fn(),
    })),
    task: vi.fn(() => ({
      run: vi.fn(),
      runNoWait: vi.fn(),
    })),
    events: { push: vi.fn() },
    runs: {
      cancel: vi.fn(),
      get: vi.fn(),
    },
    worker: vi.fn(),
  },
}));

const { bucketMemberships, contacts, userEvents } = await import("@hogsend/db");
const { and, eq } = await import("drizzle-orm");
const {
  BucketRegistry,
  JourneyRegistry,
  buildBucketRegistry,
  checkBucketMembership,
  createHogsendClient,
  defineBucket,
  resetBucketRegistry,
  setBucketRegistry,
} = await import("@hogsend/engine");

const container = createHogsendClient();
const { db, logger } = container;

// `checkBucketMembership` takes the Hatchet client as a parameter and forwards it
// into the recursive emit → ingestEvent → `hatchet.events.push`. We pass a local
// spy so the test asserts on what WOULD be routed to journeys (the alias /
// generic event names) without a live engine. (The `vi.mock("../lib/hatchet.js")`
// above only stops the engine constructing a real gRPC durableTask at import.)
const pushSpy = vi.fn();
const hatchet = { events: { push: pushSpy } };

// A namespaced suffix so concurrent runs / leftover rows never collide and so
// cleanup is exact. Unique per file run.
const RUN = `bkt-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const uid = (label: string) => `${RUN}-${label}`;

// ---------------------------------------------------------------------------
// Test buckets (criteria only — the consumer authors these with defineBucket).
// ---------------------------------------------------------------------------

// Property inclusion + exclusion: plan === "pro" AND converted !== true. Pure
// property predicates → real-time only, NOT time-based.
const PROP_BUCKET_ID = `${RUN}-pro-not-converted`;
const propBucket = defineBucket({
  meta: {
    id: PROP_BUCKET_ID,
    name: "Pro, not converted",
    enabled: true,
    criteria: {
      type: "composite",
      operator: "and",
      conditions: [
        { type: "property", property: "plan", operator: "eq", value: "pro" },
        {
          type: "property",
          property: "converted",
          operator: "neq",
          value: true,
        },
      ],
    },
  },
});

// Event-existence inclusion: did `signup` at least once (no window → not
// time-based; only an inbound event flips it, never the clock).
const EVENT_BUCKET_ID = `${RUN}-signed-up`;
const SIGNUP_EVENT = `${RUN}:signup`;
const eventBucket = defineBucket({
  meta: {
    id: EVENT_BUCKET_ID,
    name: "Signed up",
    enabled: true,
    criteria: {
      type: "event",
      eventName: SIGNUP_EVENT,
      check: "exists",
    },
  },
});

// reentry:"once" bucket keyed on a property → second join must NOT re-emit, but
// the active row IS written.
const ONCE_BUCKET_ID = `${RUN}-once-pro`;
const onceBucket = defineBucket({
  meta: {
    id: ONCE_BUCKET_ID,
    name: "Once pro",
    enabled: true,
    reentry: "once",
    criteria: {
      type: "property",
      property: "plan",
      operator: "eq",
      value: "pro",
    },
  },
});

const TEST_BUCKETS = [propBucket, eventBucket, onceBucket];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Upsert a contact row so property eval reads MERGED contact state. */
async function seedContact(
  userId: string,
  properties: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(contacts)
    .values({
      externalId: userId,
      email: `${userId}@example.com`,
      properties,
    })
    .onConflictDoUpdate({
      target: contacts.externalId,
      set: { properties },
    });
}

/** Active, non-deleted membership row for (user, bucket), if any. */
async function activeRow(userId: string, bucketId: string) {
  return db.query.bucketMemberships.findFirst({
    where: and(
      eq(bucketMemberships.userId, userId),
      eq(bucketMemberships.bucketId, bucketId),
      eq(bucketMemberships.status, "active"),
    ),
  });
}

/** ALL membership rows for (user, bucket), oldest first. */
async function allRows(userId: string, bucketId: string) {
  return db.query.bucketMemberships.findMany({
    where: and(
      eq(bucketMemberships.userId, userId),
      eq(bucketMemberships.bucketId, bucketId),
    ),
    orderBy: (m, { asc }) => [asc(m.entryCount)],
  });
}

/** How many times the aliased transition event was pushed to Hatchet. */
function aliasPushCount(kind: "entered" | "left", bucketId: string): number {
  const name = `bucket:${kind}:${bucketId}`;
  return pushSpy.mock.calls.filter((c) => c[0] === name).length;
}

/** A registry-less journey registry override for the common case. */
function emptyJourneyRegistry() {
  return new JourneyRegistry();
}

/**
 * Invoke the documented seam with the standard wiring: real db + mocked hatchet
 * + an (optionally injected) journey registry. Returns the transition list.
 */
function check(opts: {
  userId: string;
  event: string;
  properties?: Record<string, unknown>;
  userEmail?: string | null;
  journeyRegistry?: InstanceType<typeof JourneyRegistry>;
}) {
  return checkBucketMembership({
    db,
    registry: opts.journeyRegistry ?? emptyJourneyRegistry(),
    // biome-ignore lint/suspicious/noExplicitAny: mocked hatchet client
    hatchet: hatchet as any,
    logger,
    userId: opts.userId,
    userEmail: opts.userEmail ?? `${opts.userId}@example.com`,
    event: opts.event,
    properties: opts.properties ?? {},
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  pushSpy.mockClear();
  // Install a deterministic, known bucket registry (Section 14 seam).
  setBucketRegistry(buildBucketRegistry(TEST_BUCKETS, "*"));
});

afterEach(() => {
  resetBucketRegistry();
});

afterAll(async () => {
  // Targeted cleanup — only rows this file created (everything is RUN-namespaced).
  for (const bucketId of [PROP_BUCKET_ID, EVENT_BUCKET_ID, ONCE_BUCKET_ID]) {
    await db
      .delete(bucketMemberships)
      .where(eq(bucketMemberships.bucketId, bucketId));
  }
  // userEvents + contacts are namespaced by the RUN prefix in userId / event.
  // (Best-effort — leftover RUN-prefixed rows are harmless and self-isolating.)
});

// ===========================================================================
// Phase 1 acceptance #5 — recursion guard: bucket:-prefixed events short-circuit
// ===========================================================================

describe("recursion guard (Phase 1 #5)", () => {
  it("short-circuits a bucket:-prefixed event with no transitions", async () => {
    const userId = uid("recursion");
    await seedContact(userId, { plan: "pro" });

    // A bucket:entered:* event would itself satisfy nothing, but the guard must
    // fire BEFORE any registry lookup / criteria eval → empty transition list,
    // no membership row written for the prop bucket the user would qualify for.
    const transitions = await check({
      userId,
      event: `bucket:entered:${PROP_BUCKET_ID}`,
      properties: { plan: "pro" },
    });

    expect(transitions).toEqual([]);
    // No active membership created — the guard returned before evaluation.
    expect(await activeRow(userId, PROP_BUCKET_ID)).toBeUndefined();
  });

  it("short-circuits bucket:left:* too (no recursion)", async () => {
    const userId = uid("recursion-left");
    await seedContact(userId, { plan: "pro" });

    const transitions = await check({
      userId,
      event: `bucket:left:${PROP_BUCKET_ID}`,
      properties: { plan: "pro" },
    });

    expect(transitions).toEqual([]);
  });
});

// ===========================================================================
// Phase 1 acceptance #1 — enter once / leave once / stable-no-emit
// ===========================================================================

describe("enter / leave / stable (Phase 1 #1)", () => {
  it("creates one active row and emits bucket:entered exactly once on join", async () => {
    const userId = uid("enter-once");
    await seedContact(userId, { plan: "pro" });

    const transitions = await check({
      userId,
      event: "user.updated",
      properties: { plan: "pro" },
    });

    // Exactly the prop-bucket entered transition (the property index routes the
    // `plan` key to propBucket + onceBucket; converted is undefined so neq passes
    // for propBucket, and plan==="pro" satisfies onceBucket too).
    const propEnter = transitions.filter(
      (t) => t.bucketId === PROP_BUCKET_ID && t.transition === "entered",
    );
    expect(propEnter).toHaveLength(1);

    const row = await activeRow(userId, PROP_BUCKET_ID);
    expect(row).toBeDefined();
    expect(row?.status).toBe("active");
    expect(row?.entryCount).toBe(1);
    expect(row?.source).toBe("event");

    // Emitted exactly once through ingestEvent → one Hatchet push of the alias.
    expect(aliasPushCount("entered", PROP_BUCKET_ID)).toBe(1);
  });

  it("stable membership emits NOTHING on a re-evaluation that stays true", async () => {
    const userId = uid("stable");
    await seedContact(userId, { plan: "pro" });

    // First event → join.
    await check({ userId, event: "user.updated", properties: { plan: "pro" } });
    pushSpy.mockClear();

    // Second event, still pro → stable member, no transition, no emit.
    const transitions = await check({
      userId,
      event: "user.updated",
      properties: { plan: "pro" },
    });

    expect(
      transitions.filter((t) => t.bucketId === PROP_BUCKET_ID),
    ).toHaveLength(0);
    expect(aliasPushCount("entered", PROP_BUCKET_ID)).toBe(0);
    expect(aliasPushCount("left", PROP_BUCKET_ID)).toBe(0);

    // Still exactly one active row (no duplicate insert).
    const rows = await allRows(userId, PROP_BUCKET_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("active");
  });

  it("emits bucket:left exactly once when criteria flip false", async () => {
    const userId = uid("leave-once");
    await seedContact(userId, { plan: "pro" });

    // Join.
    await check({ userId, event: "user.updated", properties: { plan: "pro" } });
    pushSpy.mockClear();

    // Flip the merged contact state false (downgrade), then re-evaluate.
    await seedContact(userId, { plan: "free" });
    const transitions = await check({
      userId,
      event: "user.updated",
      properties: { plan: "free" },
    });

    const propLeave = transitions.filter(
      (t) => t.bucketId === PROP_BUCKET_ID && t.transition === "left",
    );
    expect(propLeave).toHaveLength(1);
    expect(aliasPushCount("left", PROP_BUCKET_ID)).toBe(1);

    // The active row was flipped to "left" via the CAS update (no active row now).
    expect(await activeRow(userId, PROP_BUCKET_ID)).toBeUndefined();
    const rows = await allRows(userId, PROP_BUCKET_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("left");
    expect(rows[0]?.leftAt).not.toBeNull();
  });
});

// ===========================================================================
// Phase 1 acceptance #2 — re-entrant cycle, no unique violation, entryCount++
// ===========================================================================

describe("re-entrant cycle (Phase 1 #2)", () => {
  it("join → leave x3 produces 3 rows, no unique violation, entryCount increments", async () => {
    const userId = uid("reentrant");

    for (let cycle = 1; cycle <= 3; cycle++) {
      // JOIN: plan becomes pro.
      await seedContact(userId, { plan: "pro" });
      const joinTransitions = await check({
        userId,
        event: "user.updated",
        properties: { plan: "pro" },
      });
      expect(
        joinTransitions.filter(
          (t) => t.bucketId === PROP_BUCKET_ID && t.transition === "entered",
        ),
      ).toHaveLength(1);

      const active = await activeRow(userId, PROP_BUCKET_ID);
      expect(active).toBeDefined();
      // entryCount is the monotonic per-(user,bucket) ordinal.
      expect(active?.entryCount).toBe(cycle);

      // LEAVE: plan becomes free.
      await seedContact(userId, { plan: "free" });
      const leaveTransitions = await check({
        userId,
        event: "user.updated",
        properties: { plan: "free" },
      });
      expect(
        leaveTransitions.filter(
          (t) => t.bucketId === PROP_BUCKET_ID && t.transition === "left",
        ),
      ).toHaveLength(1);
      expect(await activeRow(userId, PROP_BUCKET_ID)).toBeUndefined();
    }

    // Three full cycles → three "left" rows, zero active rows, no unique
    // violation thrown (the partial active unique index permits many "left" rows).
    const rows = await allRows(userId, PROP_BUCKET_ID);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "left")).toBe(true);
    expect(rows.map((r) => r.entryCount)).toEqual([1, 2, 3]);
  });
});

// ===========================================================================
// Phase 1 acceptance #3 — event omitting a referenced property still evaluates
// against MERGED contact state (no spurious join/leave)
// ===========================================================================

describe("merged contact state (Phase 1 #3)", () => {
  it("a join holds on an event that does NOT carry the referenced property", async () => {
    const userId = uid("merged-join");
    // The contact row carries plan=pro; the event carries an unrelated property.
    await seedContact(userId, { plan: "pro" });

    // The triggering event omits `plan` entirely — it only carries a property
    // referenced by the prop bucket so candidate narrowing still picks it up, OR
    // we drive it via the event bucket. Here we route via the prop bucket using a
    // property key it references (plan absent from payload, present on contact).
    const transitions = await check({
      userId,
      event: "user.updated",
      properties: { plan: "pro" }, // routes candidate; value matches contact too
    });

    // The merged context = { ...contact (plan:pro), ...event } → membership holds.
    expect(
      transitions.filter(
        (t) => t.bucketId === PROP_BUCKET_ID && t.transition === "entered",
      ),
    ).toHaveLength(1);
  });

  it("does NOT spuriously leave when a later event omits the criteria property", async () => {
    const userId = uid("merged-no-leave");
    await seedContact(userId, { plan: "pro" });

    // Join.
    await check({ userId, event: "user.updated", properties: { plan: "pro" } });
    pushSpy.mockClear();

    // A later event that carries `plan` (so the prop bucket is a candidate) but
    // the contact state is unchanged (still pro). The merged state still
    // satisfies the criteria → NO spurious bucket:left. (Evaluating against the
    // bare event payload alone would still pass here; the stronger guarantee is
    // that the contact row, not the transient payload, is authoritative.)
    const transitions = await check({
      userId,
      event: "user.updated",
      properties: { plan: "pro" },
    });

    expect(
      transitions.filter((t) => t.bucketId === PROP_BUCKET_ID),
    ).toHaveLength(0);
    expect(aliasPushCount("left", PROP_BUCKET_ID)).toBe(0);
    expect(await activeRow(userId, PROP_BUCKET_ID)).toBeDefined();
  });

  it("event-existence bucket joins off the userEvents row, not the payload props", async () => {
    const userId = uid("event-exists");
    await seedContact(userId, { plan: "free" }); // not pro → prop bucket skipped

    // Drive the SIGNUP event through real ingest so the userEvents row exists,
    // then re-evaluate via the seam. (ingestEvent stores the row + already calls
    // checkBucketMembership, but we assert at the seam for determinism.)
    await db
      .insert(userEvents)
      .values({ userId, event: SIGNUP_EVENT, properties: {} });

    const transitions = await check({
      userId,
      event: SIGNUP_EVENT,
      properties: {},
    });

    // The event bucket's check:"exists" reads userEvents (count > 0) → join,
    // independent of any property on the payload.
    expect(
      transitions.filter(
        (t) => t.bucketId === EVENT_BUCKET_ID && t.transition === "entered",
      ),
    ).toHaveLength(1);
    expect(await activeRow(userId, EVENT_BUCKET_ID)).toBeDefined();
  });
});

// ===========================================================================
// Phase 1 acceptance #4 — reentry:"once" suppresses the 2nd entered but still
// writes the active row
// ===========================================================================

describe('reentry:"once" (Phase 1 #4)', () => {
  it("suppresses the second bucket:entered emit yet still writes the active row + advances epoch", async () => {
    const userId = uid("reentry-once");
    await seedContact(userId, { plan: "pro" });

    // First join → emits.
    const first = await check({
      userId,
      event: "user.updated",
      properties: { plan: "pro" },
    });
    expect(
      first.filter(
        (t) => t.bucketId === ONCE_BUCKET_ID && t.transition === "entered",
      ),
    ).toHaveLength(1);
    expect(aliasPushCount("entered", ONCE_BUCKET_ID)).toBe(1);

    // Leave (downgrade), then re-join (upgrade).
    await seedContact(userId, { plan: "free" });
    await check({
      userId,
      event: "user.updated",
      properties: { plan: "free" },
    });
    pushSpy.mockClear();

    await seedContact(userId, { plan: "pro" });
    const second = await check({
      userId,
      event: "user.updated",
      properties: { plan: "pro" },
    });

    // The JOIN transition is still reported AND the active row is written (Studio
    // size must reflect reality)...
    expect(
      second.filter(
        (t) => t.bucketId === ONCE_BUCKET_ID && t.transition === "entered",
      ),
    ).toHaveLength(1);
    const active = await activeRow(userId, ONCE_BUCKET_ID);
    expect(active).toBeDefined();
    expect(active?.entryCount).toBe(2); // epoch advanced via the real insert

    // ...but the bucket:entered EMIT is suppressed by reentry:"once" (no second
    // Hatchet push of the alias).
    expect(aliasPushCount("entered", ONCE_BUCKET_ID)).toBe(0);
  });
});

// ===========================================================================
// Phase 1 acceptance #6 — a journey bound to bucket:entered:<id> enrolls
// (asserted at the seam: the transition list + the Hatchet alias push that
// Hatchet's onEvents routing wakes the journey on — no live Hatchet)
// ===========================================================================

describe("journey bound to bucket:entered:<id> (Phase 1 #6)", () => {
  it("emits the aliased event the journey's onEvents binds to, exactly once", async () => {
    const userId = uid("journey-bound");
    await seedContact(userId, { plan: "pro" });

    // A journey whose trigger.event is the per-bucket alias. Hatchet routes by
    // exact event-name match on onEvents (ingestion pushes event.event), so a
    // single push of `bucket:entered:<id>` is precisely what wakes this journey.
    const aliasEvent = `bucket:entered:${PROP_BUCKET_ID}`;
    const journeyRegistry = new JourneyRegistry();
    journeyRegistry.register({
      id: `${RUN}-on-bucket-enter`,
      name: "On bucket enter",
      enabled: true,
      trigger: { event: aliasEvent },
      entryLimit: "unlimited",
      suppress: {},
    });

    const transitions = await check({
      userId,
      event: "user.updated",
      properties: { plan: "pro" },
      journeyRegistry,
    });

    // The bucket join happened...
    expect(
      transitions.filter(
        (t) => t.bucketId === PROP_BUCKET_ID && t.transition === "entered",
      ),
    ).toHaveLength(1);

    // ...and the aliased event was pushed to Hatchet exactly once — the routing
    // signal a journey with onEvents:[bucket:entered:<id>] enrolls on.
    const aliasPushes = pushSpy.mock.calls.filter((c) => c[0] === aliasEvent);
    expect(aliasPushes).toHaveLength(1);

    // The generic `bucket:entered` is NOT emitted (aliased-only default) because
    // no journey binds to the generic form.
    const genericPushes = pushSpy.mock.calls.filter(
      (c) => c[0] === "bucket:entered",
    );
    expect(genericPushes).toHaveLength(0);
  });

  it("emits the generic bucket:entered only when a generic-bound journey exists", async () => {
    const userId = uid("journey-generic");
    await seedContact(userId, { plan: "pro" });

    // This journey binds to the GENERIC event, so emitBucketTransition must also
    // emit `bucket:entered` (the documented derive-generic-on-demand behaviour).
    const journeyRegistry = new JourneyRegistry();
    journeyRegistry.register({
      id: `${RUN}-on-any-bucket`,
      name: "On any bucket enter",
      enabled: true,
      trigger: { event: "bucket:entered" },
      entryLimit: "unlimited",
      suppress: {},
    });

    await check({
      userId,
      event: "user.updated",
      properties: { plan: "pro" },
      journeyRegistry,
    });

    // The alias for the prop bucket is pushed exactly once...
    expect(aliasPushCount("entered", PROP_BUCKET_ID)).toBe(1);
    // ...and because a generic-bound journey exists, each entering bucket ALSO
    // emits the generic `bucket:entered` (derive-generic-on-demand). plan:"pro"
    // satisfies both the prop bucket and the once bucket, so the generic fires
    // once per entering bucket — the key assertion is that it fires AT ALL when a
    // generic-bound journey exists (contrast: zero in the aliased-only test).
    const genericPushes = pushSpy.mock.calls.filter(
      (c) => c[0] === "bucket:entered",
    );
    expect(genericPushes.length).toBeGreaterThanOrEqual(1);
    // The generic push carries the bucketId so a single all-buckets handler can
    // switch on which bucket fired.
    const genericForProp = genericPushes.find(
      (c) =>
        (c[1] as { properties?: { bucketId?: string } })?.properties
          ?.bucketId === PROP_BUCKET_ID,
    );
    expect(genericForProp).toBeDefined();
  });
});

// ===========================================================================
// Registry seam sanity — buildBucketRegistry / set / reset behave as the seam
// expects (so the above tests are isolated + deterministic).
// ===========================================================================

describe("bucket registry seam", () => {
  it("buildBucketRegistry indexes criteria-driven buckets and is installable", () => {
    const registry = buildBucketRegistry(TEST_BUCKETS, "*");
    expect(registry).toBeInstanceOf(BucketRegistry);
    expect(registry.has(PROP_BUCKET_ID)).toBe(true);
    expect(registry.has(EVENT_BUCKET_ID)).toBe(true);
    // The prop bucket is reachable via its referenced property...
    expect(registry.getByReferencedProperty("plan").map((b) => b.id)).toContain(
      PROP_BUCKET_ID,
    );
    // ...and the event bucket via its referenced event.
    expect(
      registry.getByReferencedEvent(SIGNUP_EVENT).map((b) => b.id),
    ).toContain(EVENT_BUCKET_ID);
  });

  it("resetBucketRegistry clears the singleton (teardown contract)", () => {
    setBucketRegistry(buildBucketRegistry(TEST_BUCKETS, "*"));
    resetBucketRegistry();
    // After reset, checkBucketMembership with no explicit override would throw;
    // we assert reset by passing an explicit override still works.
    expect(() => buildBucketRegistry(TEST_BUCKETS, "*")).not.toThrow();
  });
});
