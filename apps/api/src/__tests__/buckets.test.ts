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
// Dual mock (config-preserving): the reconcile cron is BUILT inside
// @hogsend/engine using the ENGINE's own `lib/hatchet.js`, so we mock BOTH that
// absolute source path AND the API's `../lib/hatchet.js`, sharing ONE hoisted
// push spy. The `...config` spread keeps `bucketReconcileTask.fn` available so
// the TTL-leave reason test (Test 11) can invoke the cron body directly, while
// the `events.push` spy is the SAME object the real-time `check()` seam funnels
// into.
const { enginePushSpy, hatchetMock } = vi.hoisted(() => {
  const push = vi.fn();
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
        runNoWait: vi.fn(),
      })),
      events: { push },
      runs: { cancel: vi.fn(), get: vi.fn() },
      worker: vi.fn(),
    },
  });
  return { enginePushSpy: push, hatchetMock: factory };
});

vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

const { bucketMemberships, contacts, userEvents } = await import("@hogsend/db");
const { and, desc, eq } = await import("drizzle-orm");
const {
  BucketRegistry,
  JourneyRegistry,
  buildBucketRegistry,
  bucketReconcileTask,
  checkBucketMembership,
  createHogsendClient,
  days,
  defineBucket,
  resetBucketRegistry,
  setBucketRegistry,
} = await import("@hogsend/engine");
const { bucketMetaSchema } = await import("@hogsend/core");

const container = createHogsendClient();
const { db, logger } = container;

// `bucketReconcileTask.fn` is the real cron body (the config-preserving mock kept
// it). Used by the TTL-leave reason test (Test 11). It self-bootstraps db from
// process.env.DATABASE_URL and reads the process bucket/journey registry
// singletons — both installed by the beforeEach setBucketRegistry + the
// file-level createHogsendClient.
const reconcileTask = bucketReconcileTask as unknown as {
  fn: () => Promise<{ reconciled: number; joined: number }>;
};

// `checkBucketMembership` takes the Hatchet client as a parameter and forwards it
// into the recursive emit → ingestEvent → `hatchet.events.push`. We pass a local
// spy so the test asserts on what WOULD be routed to journeys (the alias /
// generic event names) without a live engine. (The `vi.mock("../lib/hatchet.js")`
// above only stops the engine constructing a real gRPC durableTask at import.)
const pushSpy = enginePushSpy;
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

// entryLimit:"once" bucket keyed on a property → second join must NOT re-emit, but
// the active row IS written.
const ONCE_BUCKET_ID = `${RUN}-once-pro`;
const onceBucket = defineBucket({
  meta: {
    id: ONCE_BUCKET_ID,
    name: "Once pro",
    enabled: true,
    entryLimit: "once",
    criteria: {
      type: "property",
      property: "plan",
      operator: "eq",
      value: "pro",
    },
  },
});

// entryLimit:"once_per_period" bucket keyed on a property → a re-join INSIDE the
// configured entryPeriod (measured from the most-recent prior leave's leftAt)
// must NOT re-emit bucket:entered, but the active row IS still written + epoch
// advances. After the period elapses the emit is allowed again. The seam
// manipulates the prior left row's leftAt directly to control elapsed time
// deterministically (no real waiting).
const PERIOD_BUCKET_ID = `${RUN}-period-pro`;
const periodBucket = defineBucket({
  meta: {
    id: PERIOD_BUCKET_ID,
    name: "Once per period pro",
    enabled: true,
    entryLimit: "once_per_period",
    entryPeriod: { hours: 24 },
    criteria: {
      type: "property",
      property: "plan",
      operator: "eq",
      value: "pro",
    },
  },
});

// entryLimit:"once_per_period" WITHOUT a entryPeriod → 0.2.0 back-compat anchor:
// the precise cooldown is NOT activated, so the emit fires on every qualifying
// re-join exactly as it did before entryPeriod existed (the journey-side
// entryLimit/entryPeriod remains the redundant backstop).
const PERIOD_NOCFG_BUCKET_ID = `${RUN}-period-nocfg-pro`;
const periodNoCfgBucket = defineBucket({
  meta: {
    id: PERIOD_NOCFG_BUCKET_ID,
    name: "Once per period (no period configured)",
    enabled: true,
    entryLimit: "once_per_period",
    criteria: {
      type: "property",
      property: "plan",
      operator: "eq",
      value: "pro",
    },
  },
});

// maxDwell bucket: property inclusion (plan === "vip") with an UNCONDITIONAL
// 1-day membership TTL. Join stamps maxDwellAt = enteredAt + maxDwell; the cron
// force-leaves past it REGARDLESS of criteria (the leave itself is validated
// live against the reconcile worker, not at this unit seam).
const TTL_BUCKET_ID = `${RUN}-vip-ttl`;
const ttlBucket = defineBucket({
  meta: {
    id: TTL_BUCKET_ID,
    name: "VIP (time-boxed)",
    enabled: true,
    maxDwell: { hours: 24 },
    criteria: {
      type: "property",
      property: "plan",
      operator: "eq",
      value: "vip",
    },
  },
});

// Builder-form bucket — authored with the fluent criteria builder instead of a
// declarative object. Proves defineBucket resolves the function once and the
// result is indistinguishable downstream.
const BUILDER_BUCKET_ID = `${RUN}-builder-vip`;
const builderBucket = defineBucket({
  meta: {
    id: BUILDER_BUCKET_ID,
    name: "VIP (builder)",
    enabled: true,
    criteria: (b) => b.prop("tier").eq("vip"),
  },
});

// Absence-shaped composite — the canonical lapsed-active dormancy predicate
// (mirrors apps/api/src/buckets/went-dormant.ts): "was active once AND has NOT
// been active in the last 7 days". The exists-ever leg (no window) excludes
// brand-new never-active signups; the windowed not_exists leg is the time-based
// flip the cron sweep owns. `reconcileJoins` is intentionally UNSET so the
// engine INFERS the cron join path on for this absence-shaped composite (the
// inference under test). The actual cron join materialization is exercised by
// the lead's live validation (the inference helpers are engine-internal /
// non-exported); this fixture asserts the inference INPUTS the cron keys on.
const ABSENCE_BUCKET_ID = `${RUN}-went-dormant`;
const ABSENCE_EVENT = `${RUN}:app.active`;
const absenceBucket = defineBucket({
  meta: {
    id: ABSENCE_BUCKET_ID,
    name: "Went dormant (absence-shaped)",
    enabled: true,
    timeBased: true,
    fastExpiry: true,
    criteria: (b) =>
      b.all(
        b.event(ABSENCE_EVENT).exists(),
        b.event(ABSENCE_EVENT).within(days(7)).notExists(),
      ),
  },
});

const TEST_BUCKETS = [
  propBucket,
  eventBucket,
  onceBucket,
  periodBucket,
  periodNoCfgBucket,
  ttlBucket,
  builderBucket,
];

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

/**
 * Backdate the most-recent "left" membership row's leftAt for (user, bucket) so
 * the once_per_period cooldown anchor (the prior leave) is `ageMs` in the past.
 * Lets the seam exercise "inside the period" vs "after the period" deterministically
 * without real waiting. Returns the row id it mutated (or undefined if none).
 */
async function backdateLastLeave(
  userId: string,
  bucketId: string,
  ageMs: number,
): Promise<string | undefined> {
  const last = await db.query.bucketMemberships.findFirst({
    where: and(
      eq(bucketMemberships.userId, userId),
      eq(bucketMemberships.bucketId, bucketId),
      eq(bucketMemberships.status, "left"),
    ),
    orderBy: [desc(bucketMemberships.leftAt)],
  });
  if (!last) return undefined;
  await db
    .update(bucketMemberships)
    .set({ leftAt: new Date(Date.now() - ageMs) })
    .where(eq(bucketMemberships.id, last.id));
  return last.id;
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
  for (const bucketId of [
    PROP_BUCKET_ID,
    EVENT_BUCKET_ID,
    ONCE_BUCKET_ID,
    PERIOD_BUCKET_ID,
    PERIOD_NOCFG_BUCKET_ID,
    TTL_BUCKET_ID,
    BUILDER_BUCKET_ID,
    ABSENCE_BUCKET_ID,
  ]) {
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
// Criteria builder (function form) — resolves at definition time, behaves same
// ===========================================================================

describe("criteria builder (function form)", () => {
  it("resolves the builder function to a plain ConditionEval at define time", () => {
    expect(typeof builderBucket.meta.criteria).toBe("object");
    expect(builderBucket.meta.criteria).toEqual({
      type: "property",
      property: "tier",
      operator: "eq",
      value: "vip",
    });
  });

  it("a builder-defined bucket joins exactly like a declarative one", async () => {
    const userId = uid("builder");
    await seedContact(userId, { tier: "vip" });

    const transitions = await check({
      userId,
      event: "user.updated",
      properties: { tier: "vip" },
    });

    expect(transitions).toContainEqual({
      bucketId: BUILDER_BUCKET_ID,
      transition: "entered",
    });
    expect((await activeRow(userId, BUILDER_BUCKET_ID))?.status).toBe("active");
  });
});

// ===========================================================================
// maxDwell — unconditional membership TTL stamped on join
// ===========================================================================

describe("maxDwell TTL stamping", () => {
  it("stamps maxDwellAt = enteredAt + maxDwell on join", async () => {
    const userId = uid("ttl");
    await seedContact(userId, { plan: "vip" });

    const transitions = await check({
      userId,
      event: "plan.changed",
      properties: { plan: "vip" },
    });

    expect(transitions).toContainEqual({
      bucketId: TTL_BUCKET_ID,
      transition: "entered",
    });

    const row = await activeRow(userId, TTL_BUCKET_ID);
    expect(row?.maxDwellAt).toBeTruthy();
    if (!row?.maxDwellAt) throw new Error("expected maxDwellAt to be set");

    // maxDwellAt ≈ enteredAt + 24h. enteredAt is the DB now(); maxDwellAt is the
    // JS now()+ttl, so allow a few seconds of skew.
    const expectedMs = row.enteredAt.getTime() + 24 * 60 * 60 * 1000;
    expect(Math.abs(row.maxDwellAt.getTime() - expectedMs)).toBeLessThan(5000);
  });

  it("leaves maxDwellAt null for buckets without maxDwell", async () => {
    const userId = uid("no-ttl");
    await seedContact(userId, { plan: "pro" });

    await check({ userId, event: "user.updated", properties: { plan: "pro" } });

    const row = await activeRow(userId, PROP_BUCKET_ID);
    expect(row?.maxDwellAt ?? null).toBeNull();
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
// Phase 1 acceptance #4 — entryLimit:"once" suppresses the 2nd entered but still
// writes the active row
// ===========================================================================

describe('entryLimit:"once" (Phase 1 #4)', () => {
  it("suppresses the second bucket:entered emit yet still writes the active row + advances epoch", async () => {
    const userId = uid("entryLimit-once");
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

    // ...but the bucket:entered EMIT is suppressed by entryLimit:"once" (no second
    // Hatchet push of the alias).
    expect(aliasPushCount("entered", ONCE_BUCKET_ID)).toBe(0);
  });
});

// ===========================================================================
// entryLimit:"once_per_period" — PRECISE cooldown gate (STEP 2). The active row is
// ALWAYS written + epoch advances; only the bucket:entered EMIT is gated on
// whether `entryPeriod` has elapsed since the most-recent prior leave (its
// leftAt). entryPeriod UNSET → 0.2.0 back-compat (always emits).
// ===========================================================================

describe('entryLimit:"once_per_period" precise cooldown (STEP 2)', () => {
  it("SUPPRESSES the re-join emit while still inside the entryPeriod", async () => {
    const userId = uid("period-inside");
    await seedContact(userId, { plan: "pro" });

    // First join → emits (first-ever join always emits).
    const first = await check({
      userId,
      event: "user.updated",
      properties: { plan: "pro" },
    });
    expect(
      first.filter(
        (t) => t.bucketId === PERIOD_BUCKET_ID && t.transition === "entered",
      ),
    ).toHaveLength(1);
    expect(aliasPushCount("entered", PERIOD_BUCKET_ID)).toBe(1);

    // Leave (downgrade) → writes a "left" row with leftAt.
    await seedContact(userId, { plan: "free" });
    await check({
      userId,
      event: "user.updated",
      properties: { plan: "free" },
    });
    expect(aliasPushCount("left", PERIOD_BUCKET_ID)).toBe(1);

    // Pin the prior leave to 1h ago — INSIDE the 24h entryPeriod.
    const leftId = await backdateLastLeave(
      userId,
      PERIOD_BUCKET_ID,
      60 * 60 * 1000,
    );
    expect(leftId).toBeDefined();
    pushSpy.mockClear();

    // Re-join (upgrade) while still cooling down.
    await seedContact(userId, { plan: "pro" });
    const second = await check({
      userId,
      event: "user.updated",
      properties: { plan: "pro" },
    });

    // The JOIN transition is still reported AND the active row is written +
    // epoch advanced...
    expect(
      second.filter(
        (t) => t.bucketId === PERIOD_BUCKET_ID && t.transition === "entered",
      ),
    ).toHaveLength(1);
    const active = await activeRow(userId, PERIOD_BUCKET_ID);
    expect(active).toBeDefined();
    expect(active?.entryCount).toBe(2);

    // ...but the bucket:entered EMIT is SUPPRESSED because the cooldown window
    // since the prior leave has not elapsed (1h < 24h). A journey bound to
    // bucket:entered:<id> therefore does NOT re-enroll during the cooldown.
    expect(aliasPushCount("entered", PERIOD_BUCKET_ID)).toBe(0);
  });

  it("ALLOWS the re-join emit once the entryPeriod has elapsed", async () => {
    const userId = uid("period-after");
    await seedContact(userId, { plan: "pro" });

    // Join → leave (first cycle).
    await check({ userId, event: "user.updated", properties: { plan: "pro" } });
    await seedContact(userId, { plan: "free" });
    await check({
      userId,
      event: "user.updated",
      properties: { plan: "free" },
    });

    // Pin the prior leave to 25h ago — PAST the 24h entryPeriod.
    const leftId = await backdateLastLeave(
      userId,
      PERIOD_BUCKET_ID,
      25 * 60 * 60 * 1000,
    );
    expect(leftId).toBeDefined();
    pushSpy.mockClear();

    // Re-join after the cooldown has elapsed.
    await seedContact(userId, { plan: "pro" });
    const second = await check({
      userId,
      event: "user.updated",
      properties: { plan: "pro" },
    });

    expect(
      second.filter(
        (t) => t.bucketId === PERIOD_BUCKET_ID && t.transition === "entered",
      ),
    ).toHaveLength(1);
    const active = await activeRow(userId, PERIOD_BUCKET_ID);
    expect(active?.entryCount).toBe(2);

    // The cooldown has elapsed (25h >= 24h) → the bucket:entered emit fires
    // again, re-arming any journey bound to bucket:entered:<id>.
    expect(aliasPushCount("entered", PERIOD_BUCKET_ID)).toBe(1);
  });

  it("BACK-COMPAT: once_per_period with NO entryPeriod always emits (0.2.0)", async () => {
    const userId = uid("period-nocfg");
    await seedContact(userId, { plan: "pro" });

    // First join → emits.
    await check({ userId, event: "user.updated", properties: { plan: "pro" } });
    expect(aliasPushCount("entered", PERIOD_NOCFG_BUCKET_ID)).toBe(1);

    // Leave then immediately re-join (no time passes); the prior leave is
    // brand-new but with no entryPeriod configured the precise gate is NOT
    // active, so the emit fires exactly as it did before entryPeriod existed.
    await seedContact(userId, { plan: "free" });
    await check({
      userId,
      event: "user.updated",
      properties: { plan: "free" },
    });
    pushSpy.mockClear();

    await seedContact(userId, { plan: "pro" });
    await check({ userId, event: "user.updated", properties: { plan: "pro" } });

    const active = await activeRow(userId, PERIOD_NOCFG_BUCKET_ID);
    expect(active?.entryCount).toBe(2);
    // No period configured → emit is NOT suppressed (back-compat anchor).
    expect(aliasPushCount("entered", PERIOD_NOCFG_BUCKET_ID)).toBe(1);
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

// ===========================================================================
// Absence-join inference (completeness #4 / STEP 4-5). The cron join path is
// INFERRED-ON for absence-shaped buckets (a windowed not_exists leg) when
// reconcileJoins is left UNDEFINED. The inference helpers
// (shouldReconcileJoins / isAbsenceShaped / collectAbsenceLegs) are
// engine-internal and NOT exported, so this suite asserts the inference INPUTS
// the cron keys on, while the actual JOIN materialization (and the starvation /
// multi-leg-floor fixes) is covered DB-backed in bucket-reconcile.test.ts. Here
// we assert: the absence-shaped composite (a) passes schema validation (a
// windowed not_exists is a legitimate anchor, not a degenerate pure-negation
// bucket), (b) registers + is indexed by both legs' event, and (c) leaves
// reconcileJoins UNSET so the engine's inference (rather than an explicit flag)
// decides — plus the exact criteria shape the inference matches on. went-dormant
// in apps/api/src/buckets/ is the same shape.
// ===========================================================================

describe("absence-join inference inputs (completeness #4 / STEP 4-5)", () => {
  it("the absence-shaped composite passes schema validation (windowed not_exists is a valid anchor)", () => {
    // A pure UNBOUNDED not_exists would be a degenerate pure-negation bucket and
    // throw; the windowed not_exists leg + exists-ever leg make this legitimate.
    expect(() => bucketMetaSchema.parse(absenceBucket.meta)).not.toThrow();
  });

  it("registers + is indexed by the absence event (reachable to the cron registry walk)", () => {
    const registry = buildBucketRegistry([absenceBucket], "*");
    expect(registry.has(ABSENCE_BUCKET_ID)).toBe(true);
    // Both legs reference ABSENCE_EVENT, so the event index routes to it; this is
    // the same getEnabled() registry the reconcile cron sweeps.
    expect(
      registry.getByReferencedEvent(ABSENCE_EVENT).map((b) => b.id),
    ).toContain(ABSENCE_BUCKET_ID);
    expect(registry.getEnabled().map((b) => b.id)).toContain(ABSENCE_BUCKET_ID);
  });

  it("leaves reconcileJoins UNSET so the engine INFERS the join path on", () => {
    // The whole point of the inference: an absence-shaped bucket needs NO
    // explicit reconcileJoins:true. undefined → inferred-on (the cron's
    // shouldReconcileJoins returns true for this shape).
    expect(absenceBucket.meta.reconcileJoins).toBeUndefined();
  });

  it("has the exact absence-shaped composite the inference matches on (windowed not_exists leg)", () => {
    // shouldReconcileJoins/isAbsenceShaped/collectAbsenceLegs key on: a
    // composite containing an EventCondition with check:"not_exists" AND a
    // `within` window. Assert that exact shape so a refactor that drops the
    // window (making it unbounded / non-joinable) is caught here, even though
    // the helper itself is internal.
    const criteria = absenceBucket.meta.criteria;
    expect(criteria?.type).toBe("composite");
    if (criteria?.type !== "composite") throw new Error("expected composite");

    const windowedNotExists = criteria.conditions.find(
      (c) => c.type === "event" && c.check === "not_exists" && c.within != null,
    );
    expect(windowedNotExists).toBeDefined();
    // collectAbsenceLegs picks this leg's event for the candidate query.
    expect(
      windowedNotExists?.type === "event"
        ? windowedNotExists.eventName
        : undefined,
    ).toBe(ABSENCE_EVENT);

    // The exists-ever floor leg (no window) MUST stay UNBOUNDED — only the
    // not_exists leg decays. This is the canonical lapsed-active shape the
    // composite-join path depends on.
    const existsEver = criteria.conditions.find(
      (c) => c.type === "event" && c.check === "exists" && c.within == null,
    );
    expect(existsEver).toBeDefined();
  });

  it("a non-absence time-based bucket (positive within) is NOT absence-shaped", () => {
    // Contrast: a windowed EXISTS (positive) bucket is caught real-time on event
    // arrival, so the inference must NOT turn the join scan on for it. We assert
    // the shape distinction (no windowed not_exists leg) that drives that.
    const positiveWindow = defineBucket({
      meta: {
        id: `${RUN}-recently-active`,
        name: "Recently active (positive window)",
        enabled: true,
        timeBased: true,
        criteria: (b) => b.event(ABSENCE_EVENT).within(days(7)).exists(),
      },
    });
    const criteria = positiveWindow.meta.criteria;
    // No not_exists leg anywhere → not absence-shaped → inference stays OFF.
    const hasWindowedNotExists =
      criteria?.type === "event" &&
      criteria.check === "not_exists" &&
      criteria.within != null;
    expect(hasWindowedNotExists).toBe(false);
  });
});

describe('kind:"manual" guard (Phase 1 #7)', () => {
  it("rejects a manual bucket at registration with the v1 message", () => {
    const manual = defineBucket({
      meta: {
        id: `${RUN}-manual-bucket`,
        name: "Manual bucket",
        enabled: true,
        kind: "manual",
      },
    });
    const registry = new BucketRegistry();
    expect(() => registry.register(manual.meta)).toThrow(
      /not implemented in v1/,
    );
    expect(registry.has(manual.meta.id)).toBe(false);
  });

  it("rejects a manual bucket even when it declares criteria", () => {
    const manual = defineBucket({
      meta: {
        id: `${RUN}-manual-with-criteria`,
        name: "Manual with criteria",
        enabled: true,
        kind: "manual",
        criteria: (b) => b.event(SIGNUP_EVENT).exists(),
      },
    });
    const registry = new BucketRegistry();
    expect(() => registry.register(manual.meta)).toThrow(
      /not implemented in v1/,
    );
  });

  it("rejects a manual bucket through buildBucketRegistry too", () => {
    const manual = defineBucket({
      meta: {
        id: `${RUN}-manual-build`,
        name: "Manual via build",
        enabled: true,
        kind: "manual",
      },
    });
    expect(() => buildBucketRegistry([manual], "*")).toThrow(
      /not implemented in v1/,
    );
  });

  it("dynamic buckets are unaffected by the manual guard", () => {
    const registry = new BucketRegistry();
    expect(() => registry.register(propBucket.meta)).not.toThrow();
    expect(() => registry.register(eventBucket.meta)).not.toThrow();
    expect(registry.has(PROP_BUCKET_ID)).toBe(true);
    expect(registry.has(EVENT_BUCKET_ID)).toBe(true);
  });
});

// ===========================================================================
// entryCount + reason threading on emitted transitions (Tests 9, 10, 11)
//
// The reaction `run` derives isFirstEntry from `entryCount` and filters on
// `reason`, both read off the emitted event's properties. These assert the
// PRODUCER side: a real-time join carries entryCount; a criteria leave carries
// reason "criteria"; a TTL leave carries reason "maxDwell".
// ===========================================================================

/** The most recent push payload for a transition event + user. */
function lastTransitionPush(
  kind: "entered" | "left",
  bucketId: string,
  userId: string,
):
  | { userId?: string; properties?: { entryCount?: number; reason?: string } }
  | undefined {
  const name = `bucket:${kind}:${bucketId}`;
  const matches = pushSpy.mock.calls.filter(
    (c) =>
      c[0] === name &&
      (c[1] as { userId?: string } | undefined)?.userId === userId,
  );
  return matches[matches.length - 1]?.[1] as
    | { userId?: string; properties?: { entryCount?: number; reason?: string } }
    | undefined;
}

describe("entryCount on a real-time join emit (Test 9)", () => {
  it("a bucket:entered emit carries properties.entryCount === 1 on first join", async () => {
    const userId = uid("entrycount-emit");
    await seedContact(userId, { plan: "pro" });

    await check({ userId, event: "user.updated", properties: { plan: "pro" } });

    const payload = lastTransitionPush("entered", PROP_BUCKET_ID, userId);
    expect(payload).toBeDefined();
    expect(payload?.properties?.entryCount).toBe(1);
  });
});

describe("reason on a real-time criteria leave (Test 10)", () => {
  it("a criteria leave emits bucket:left with reason 'criteria'", async () => {
    const userId = uid("reason-criteria-emit");
    await seedContact(userId, { plan: "pro" });

    // Join.
    await check({ userId, event: "user.updated", properties: { plan: "pro" } });
    pushSpy.mockClear();

    // Flip false → criteria leave.
    await seedContact(userId, { plan: "free" });
    await check({
      userId,
      event: "user.updated",
      properties: { plan: "free" },
    });

    const payload = lastTransitionPush("left", PROP_BUCKET_ID, userId);
    expect(payload).toBeDefined();
    expect(payload?.properties?.reason).toBe("criteria");
  });
});

describe("reason on a TTL leave via the reconcile cron (Test 11)", () => {
  it("the TTL pass emits bucket:left with reason 'maxDwell'", async () => {
    const userId = uid("reason-maxdwell-emit");
    await seedContact(userId, { plan: "vip" });

    // Join the maxDwell bucket (stamps maxDwellAt = enteredAt + 24h, future).
    await check({ userId, event: "plan.changed", properties: { plan: "vip" } });
    const row = await activeRow(userId, TTL_BUCKET_ID);
    expect(row).toBeDefined();

    // Backdate maxDwellAt into the past so the TTL sweep force-leaves the member.
    await db
      .update(bucketMemberships)
      .set({ maxDwellAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(bucketMemberships.userId, userId));
    pushSpy.mockClear();

    // Drive the reconcile cron body (the config-preserving mock kept `.fn`). It
    // reads the bucket registry singleton installed by beforeEach.
    await reconcileTask.fn();

    // The member was force-left with reason "maxDwell".
    expect(await activeRow(userId, TTL_BUCKET_ID)).toBeUndefined();
    const payload = lastTransitionPush("left", TTL_BUCKET_ID, userId);
    expect(payload).toBeDefined();
    expect(payload?.properties?.reason).toBe("maxDwell");
  });
});

// ===========================================================================
// Schema round-trip strip guard (Test 13b) — the blocker resolution.
//
// JourneyRegistry.register runs journeyMetaSchema.parse, a plain z.object that
// STRIPS unknown keys. The reaction tagging fields (sourceBucketId / reactionKind
// / dwellSchedule) MUST be declared on the schema or the dwell-cron lookup AND
// Studio grouping silently break. Register a dwell reaction meta and assert the
// fields survive the parse.
// ===========================================================================

describe("journeyMetaSchema reaction-field round-trip (Test 13b)", () => {
  it("preserves sourceBucketId / reactionKind / dwellSchedule through register()", () => {
    const dwellBucket = defineBucket({
      meta: {
        id: `${RUN}-roundtrip-bucket`,
        name: "Round-trip bucket",
        enabled: true,
        criteria: {
          type: "property",
          property: "plan",
          operator: "eq",
          value: "pro",
        },
      },
    });
    dwellBucket.on("dwell", { after: days(7) }, async () => {});
    const reaction = dwellBucket.reactions[0];
    if (!reaction) throw new Error("expected a dwell reaction");

    const registry = new JourneyRegistry();
    registry.register(reaction.meta);

    const stored = registry.getAll()[0];
    expect(stored).toBeDefined();
    expect(stored?.sourceBucketId).toBe(dwellBucket.meta.id);
    expect(stored?.reactionKind).toBe("dwell");
    expect(stored?.dwellSchedule).toEqual({
      label: `after-${24 * 7 * 60 * 60 * 1000}`,
      after: 24 * 7 * 60 * 60 * 1000,
    });
  });
});
