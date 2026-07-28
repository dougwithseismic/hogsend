import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// DB-touching test against the real docker TimescaleDB (mirrors
// bucket-reconcile.test.ts / bucket-dwell.test.ts), overriding the vitest.config
// placeholder DATABASE_URL.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Mock Hatchet so building the reconcile task at import does NOT construct a
// live gRPC engine, while PRESERVING the `fn` passed to `task()` so the test can
// invoke `bucketReconcileTask.fn()` directly (the documented test seam).
// `events.push` is a spy: `emitBucketTransition` → `ingestEvent` writes real
// `user_events` rows AND pushes here, so both are assertable.
const { pushSpy, hatchetMock } = vi.hoisted(() => {
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
  return { pushSpy: push, hatchetMock: factory };
});

vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

const { bucketMemberships, contacts, userEvents } = await import("@hogsend/db");
const { and, eq, like } = await import("drizzle-orm");
const {
  addBucketMember,
  bucketReconcileTask,
  createHogsendClient,
  days,
  defineBucket,
  durationToMs,
  hours,
  removeBucketMember,
  resetBucketRegistry,
} = await import("@hogsend/engine");

type BucketMeta = import("@hogsend/core").BucketMeta;

/**
 * Which reconcile passes apply to one bucket. The criteria/kind split lives in
 * a PURE function precisely so each of the six passes can be mutation-tested
 * INDEPENDENTLY — a black-box "the manual bucket was/wasn't processed" assertion
 * is too coarse to catch a wrong split (PRD 01 §"The subtle part").
 */
interface BucketReconcilePasses {
  criteriaLeaves: boolean;
  criteriaJoins: boolean;
  ttlLeaves: boolean;
  pendingLeaves: boolean;
  dwell: boolean;
}

// Loaded through Vite by path: it is engine-internal (not part of the
// @hogsend/engine public surface) and a literal static import into another
// package's src would trip rootDir (TS6059) under `tsc --noEmit`. Same idiom as
// impact-digest.test.ts / provision-posthog-loop.test.ts.
const reconcileModulePath = new URL(
  "../../../../packages/engine/src/workflows/bucket-reconcile.ts",
  import.meta.url,
).pathname;
const { selectReconcilePasses } = (await import(
  /* @vite-ignore */ reconcileModulePath
)) as {
  selectReconcilePasses: (
    bucket: BucketMeta,
    hasDwell: boolean,
  ) => BucketReconcilePasses;
};

const container = createHogsendClient();
const { db, registry, hatchet, logger } = container;

/** The explicit-dependency bundle the membership seam takes (AC 11). */
const deps = { db, registry, hatchet, logger };

const reconcileTask = bucketReconcileTask as unknown as {
  fn: () => Promise<{ reconciled: number; joined: number }>;
};
const runReconcile = () => reconcileTask.fn();

const RUN = `rcm-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const uid = (label: string) => `${RUN}-${label}`;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// Test buckets
// ---------------------------------------------------------------------------

/** Manual + maxDwell: the criteria-INDEPENDENT TTL pass must run for it. */
const TTL_ID = `${RUN}-manual-ttl`;
const manualTtlBucket = defineBucket({
  meta: {
    id: TTL_ID,
    name: "Manual with maxDwell",
    enabled: true,
    kind: "manual",
    maxDwell: hours(48),
  },
});

/** Manual + minDwell: the deferred-leave resolution pass must run for it. */
const DEFER_ID = `${RUN}-manual-defer`;
const MIN_DWELL = hours(2);
const manualDeferBucket = defineBucket({
  meta: {
    id: DEFER_ID,
    name: "Manual with minDwell",
    enabled: true,
    kind: "manual",
    minDwell: MIN_DWELL,
  },
});

/** Manual + a dwell reaction: the dwell pass must run for it. */
const DWELL_ID = `${RUN}-manual-dwell`;
const DWELL_AFTER = days(7);
const DWELL_LABEL = `after-${durationToMs(DWELL_AFTER)}`;
const manualDwellBucket = defineBucket({
  meta: {
    id: DWELL_ID,
    name: "Manual with a dwell reaction",
    enabled: true,
    kind: "manual",
  },
});
manualDwellBucket.on("dwell", { after: DWELL_AFTER }, async () => {});

/**
 * Manual bucket carrying the two knobs that turn the CRITERIA passes on for a
 * dynamic bucket (`timeBased` + `reconcileJoins`). The schema leaves both
 * unvalidated for `kind:"manual"` (Rule 4 returns early), so this is a
 * registerable shape. Both criteria passes dereference `bucket.criteria`
 * unguarded, so if the split lets either run for a manual bucket it throws
 * inside the per-bucket try — swallowing the TTL pass that comes after it.
 */
const TRAP_ID = `${RUN}-manual-trap`;
const manualTrapBucket = defineBucket({
  meta: {
    id: TRAP_ID,
    name: "Manual carrying criteria-pass knobs",
    enabled: true,
    kind: "manual",
    timeBased: true,
    reconcileJoins: true,
    maxDwell: hours(48),
  },
});

/**
 * DYNAMIC time-based bucket with `minDwell`. Its members carry an `expiresAt`
 * that is the CRITERIA-WINDOW arming epoch, NOT a pending leave — so a
 * pending-leave pass that ran for dynamic buckets would force-leave a member
 * who still matches, with no criteria re-check. That is the dynamic-regression
 * guard.
 */
const DYNAMIC_ID = `${RUN}-dynamic-window`;
const DYNAMIC_EVENT = `${RUN}:dyn.active`;
const dynamicBucket = defineBucket({
  meta: {
    id: DYNAMIC_ID,
    name: "Dynamic windowed exists with minDwell",
    enabled: true,
    timeBased: true,
    minDwell: hours(1),
    criteria: (b) => b.event(DYNAMIC_EVENT).within(days(7)).exists(),
  },
});

/**
 * Manual + minDwell, DEDICATED to the pending-leave BATCH_SIZE bound tests so
 * their 500+ seeded rows cannot starve (or be starved by) the rows the AC 7
 * suite above puts in `manualDeferBucket`.
 */
const BOUND_ID = `${RUN}-manual-bound`;
const manualBoundBucket = defineBucket({
  meta: {
    id: BOUND_ID,
    name: "Manual minDwell — pending-leave bound",
    enabled: true,
    kind: "manual",
    minDwell: MIN_DWELL,
  },
});

/** Same, for the raised-minDwell starvation guard. */
const STARVE_ID = `${RUN}-manual-starve`;
const manualStarveBucket = defineBucket({
  meta: {
    id: STARVE_ID,
    name: "Manual minDwell — raised-window starvation",
    enabled: true,
    kind: "manual",
    minDwell: MIN_DWELL,
  },
});

/**
 * Manual bucket with NO `minDwell` at all — the state an operator leaves behind
 * by REMOVING `minDwell` after a leave was already deferred. The armed row and
 * its `__pendingLeave__` marker outlive the config edit, so a selector keyed on
 * the bucket's CURRENT `minDwell` switches the only pass that can resolve them
 * off forever.
 */
const NOMIN_ID = `${RUN}-manual-nomindwell`;
const manualNoMinDwellBucket = defineBucket({
  meta: {
    id: NOMIN_ID,
    name: "Manual, minDwell since removed",
    enabled: true,
    kind: "manual",
  },
});

/**
 * DISABLED manual bucket with `minDwell`. A leave deferred while it was live
 * must still be RESOLVED once the window elapses (else the member is stranded
 * `active` forever), but a switched-off bucket must never fire into live
 * journeys — so the row flips SILENTLY.
 */
const DISABLED_ID = `${RUN}-manual-disabled`;
const manualDisabledBucket = defineBucket({
  meta: {
    id: DISABLED_ID,
    name: "Disabled manual with minDwell",
    enabled: false,
    kind: "manual",
    minDwell: MIN_DWELL,
  },
});

/**
 * Manual + minDwell, dedicated to the SELECT→UPDATE race guard so the disarm
 * fired from the push hook cannot perturb any other suite's rows.
 */
const RACE_ID = `${RUN}-manual-race`;
const manualRaceBucket = defineBucket({
  meta: {
    id: RACE_ID,
    name: "Manual minDwell — re-add race",
    enabled: true,
    kind: "manual",
    minDwell: MIN_DWELL,
  },
});

/**
 * Manual with BOTH ceilings: the TTL pass and the deferred-leave pass can come
 * due on the SAME tick, and the TTL pass runs first. A SEEDED population's
 * `emit: false` lives only on the pending-leave marker, so a TTL force-leave
 * destroys it and blasts `bucket:left` into live journeys.
 */
const SEEDTTL_ID = `${RUN}-manual-seed-ttl`;
const manualSeedTtlBucket = defineBucket({
  meta: {
    id: SEEDTTL_ID,
    name: "Manual with maxDwell AND minDwell",
    enabled: true,
    kind: "manual",
    minDwell: MIN_DWELL,
    maxDwell: hours(48),
  },
});

const TEST_BUCKETS = [
  manualTtlBucket,
  manualDeferBucket,
  manualDwellBucket,
  manualTrapBucket,
  manualBoundBucket,
  manualStarveBucket,
  manualNoMinDwellBucket,
  manualDisabledBucket,
  manualRaceBucket,
  manualSeedTtlBucket,
  dynamicBucket,
];

// Installs BOTH the bucket-registry and journey-registry singletons the cron
// reads (the dwell reaction rides the journey registry).
createHogsendClient({ buckets: TEST_BUCKETS });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedContact(userId: string): Promise<void> {
  await db
    .insert(contacts)
    .values({
      externalId: userId,
      email: `${userId}@example.com`,
      properties: {},
    })
    .onConflictDoNothing();
}

/**
 * A contact with NO `external_id` — its canonical key (and therefore its
 * `bucket_memberships.userId`) is the `anonymous_id`. Every criteria-independent
 * reconcile pass has to resolve it through the canonical-key coalesce.
 */
async function seedAnonContact(userId: string): Promise<void> {
  await db
    .insert(contacts)
    .values({ anonymousId: userId, properties: {} })
    .onConflictDoNothing();
}

/**
 * A SOFT-DELETED contact. `mergeContacts` frees identity keys from the
 * partial-unique indexes rather than nulling them, so a dead row still
 * coalesces to its canonical key — the `deleted_at IS NULL` half of
 * `liveContactByCanonicalKey` is the only thing keeping it out of a pass.
 */
async function seedDeletedContact(userId: string): Promise<void> {
  await db
    .insert(contacts)
    .values({
      externalId: userId,
      email: `${userId}@example.com`,
      properties: {},
      deletedAt: new Date(),
    })
    .onConflictDoNothing();
}

/** A pending-leave marker exactly as `removeBucketMember` records it. */
function pendingLeave(deferUntil: Date, emit: boolean) {
  return { __pendingLeave__: { deferUntil: deferUntil.toISOString(), emit } };
}

async function membershipRow(userId: string, bucketId: string) {
  return db.query.bucketMemberships.findFirst({
    where: and(
      eq(bucketMemberships.userId, userId),
      eq(bucketMemberships.bucketId, bucketId),
    ),
  });
}

/** Pushes of `bucket:<kind>:<bucketId>` (+ suffix) scoped to ONE user. */
function pushCountForUser(event: string, userId: string): number {
  return pushSpy.mock.calls.filter(
    (c) =>
      c[0] === event &&
      (c[1] as { userId?: string } | undefined)?.userId === userId,
  ).length;
}

function lastPushForUser(
  event: string,
  userId: string,
): { properties?: Record<string, unknown> } | undefined {
  const matches = pushSpy.mock.calls.filter(
    (c) =>
      c[0] === event &&
      (c[1] as { userId?: string } | undefined)?.userId === userId,
  );
  return matches[matches.length - 1]?.[1] as
    | { properties?: Record<string, unknown> }
    | undefined;
}

const meta = (over: Partial<BucketMeta>): BucketMeta => ({
  id: "sel",
  name: "sel",
  enabled: true,
  ...over,
});

/**
 * A hook fired FROM INSIDE the emit of a `bucket:left`, i.e. at the one instant
 * that sits strictly between the pending-leave pass's SELECT and the UPDATE it
 * issues for the SILENT partition (`ingestEvent` awaits `hatchet.events.push`,
 * and the pass emits the `emit: true` partition before flipping the silent one).
 * That is the only honest way to land a concurrent write in the window the CAS
 * is supposed to cover — a wall-clock race would be probabilistic, and a
 * probabilistic guard certifies rather than fails.
 */
let onPush: ((event: string, userId: string) => Promise<void>) | null = null;

pushSpy.mockImplementation(
  async (event: string, payload: { userId?: string }) => {
    await onPush?.(event, payload?.userId ?? "");
  },
);

beforeEach(() => {
  onPush = null;
  pushSpy.mockClear();
});

afterAll(async () => {
  resetBucketRegistry();
  await db
    .delete(bucketMemberships)
    .where(like(bucketMemberships.userId, `${RUN}-%`));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.anonymousId, `${RUN}-%`));
});

// ===========================================================================
// A. The split itself — each of the six passes asserted INDEPENDENTLY.
// ===========================================================================

describe("selectReconcilePasses (the criteria/kind split)", () => {
  it("runs ONLY the criteria-independent passes for a manual bucket", () => {
    expect(
      selectReconcilePasses(
        meta({
          kind: "manual",
          maxDwell: hours(48),
          minDwell: hours(2),
        }),
        true,
      ),
    ).toEqual({
      // criteria-driven → OFF: a manual bucket has no criteria.
      criteriaLeaves: false,
      criteriaJoins: false,
      // criteria-INDEPENDENT → ON.
      ttlLeaves: true,
      pendingLeaves: true,
      dwell: true,
    });
  });

  it("keeps the criteria passes off for a manual bucket even when it carries timeBased + reconcileJoins", () => {
    expect(
      selectReconcilePasses(
        meta({
          kind: "manual",
          timeBased: true,
          reconcileJoins: true,
          maxDwell: hours(48),
        }),
        false,
      ),
    ).toEqual({
      criteriaLeaves: false,
      criteriaJoins: false,
      ttlLeaves: true,
      // ON despite `minDwell` being absent: the pass selects on the PRESENCE of
      // the `__pendingLeave__` marker, never on the live config, so removing
      // `minDwell` cannot orphan an already-armed deferral.
      pendingLeaves: true,
      dwell: false,
    });
  });

  // Config edits must not destroy recorded intent. A manual bucket that has
  // NEVER had `minDwell` selects nothing (the marker predicate returns zero
  // rows), so arming the pass unconditionally is free; keying it on the live
  // `minDwell` is what makes a REMOVAL strand every deferred leave.
  it("arms the pending-leave pass for a manual bucket with no minDwell at all", () => {
    expect(selectReconcilePasses(meta({ kind: "manual" }), false)).toEqual({
      criteriaLeaves: false,
      criteriaJoins: false,
      ttlLeaves: false,
      pendingLeaves: true,
      dwell: false,
    });
  });

  // A DISABLED manual bucket keeps the deferred-leave pass and NOTHING else:
  // every other pass DISCOVERS work from the clock (and a kill switch must
  // discover nothing), while a pending leave is an already-applied operator
  // intent that no other code path will ever clear.
  it("leaves a disabled manual bucket with the pending-leave pass ONLY", () => {
    expect(
      selectReconcilePasses(
        meta({
          enabled: false,
          kind: "manual",
          minDwell: hours(2),
          maxDwell: hours(48),
        }),
        true,
      ),
    ).toEqual({
      criteriaLeaves: false,
      criteriaJoins: false,
      ttlLeaves: false,
      pendingLeaves: true,
      dwell: false,
    });
  });

  it("keeps a disabled DYNAMIC bucket fully inert", () => {
    expect(
      selectReconcilePasses(
        meta({
          enabled: false,
          timeBased: true,
          maxDwell: hours(48),
          criteria: {
            type: "event",
            eventName: "x",
            check: "exists",
            within: days(7),
          },
        }),
        true,
      ),
    ).toEqual({
      criteriaLeaves: false,
      criteriaJoins: false,
      ttlLeaves: false,
      pendingLeaves: false,
      dwell: false,
    });
  });

  it("leaves a dynamic time-based bucket unchanged — and never arms pendingLeaves for it", () => {
    expect(
      selectReconcilePasses(
        meta({
          timeBased: true,
          minDwell: hours(1),
          maxDwell: hours(48),
          criteria: {
            type: "event",
            eventName: "x",
            check: "exists",
            within: days(7),
          },
        }),
        false,
      ),
    ).toEqual({
      criteriaLeaves: true,
      // `exists` is not an absence shape → the join scan stays inferred-off.
      criteriaJoins: false,
      ttlLeaves: true,
      // THE dynamic-regression term: `expiresAt` on a dynamic member is the
      // criteria-window arming epoch, never a pending leave.
      pendingLeaves: false,
      dwell: false,
    });
  });

  it("still infers the absence join scan for a dynamic single-event not_exists bucket", () => {
    expect(
      selectReconcilePasses(
        meta({
          criteria: {
            type: "event",
            eventName: "x",
            check: "not_exists",
            within: days(7),
          },
        }),
        false,
      ),
    ).toEqual({
      criteriaLeaves: true,
      criteriaJoins: true,
      ttlLeaves: false,
      pendingLeaves: false,
      dwell: false,
    });
  });

  it("runs only the TTL pass for a dynamic pure-property bucket with maxDwell", () => {
    expect(
      selectReconcilePasses(
        meta({
          maxDwell: hours(48),
          criteria: {
            type: "property",
            property: "plan",
            operator: "eq",
            value: "pro",
          },
        }),
        false,
      ),
    ).toEqual({
      criteriaLeaves: false,
      criteriaJoins: false,
      ttlLeaves: true,
      pendingLeaves: false,
      dwell: false,
    });
  });

  it("keeps a dynamic bucket with no criteria fully inert", () => {
    expect(selectReconcilePasses(meta({ maxDwell: hours(48) }), true)).toEqual({
      criteriaLeaves: false,
      criteriaJoins: false,
      ttlLeaves: false,
      pendingLeaves: false,
      dwell: false,
    });
  });
});

// ===========================================================================
// B. Wiring — the cron actually calls the passes the split selected.
// ===========================================================================

describe("manual bucket: maxDwell TTL pass runs (AC 6)", () => {
  it("force-leaves a member past maxDwellAt and emits bucket:left", async () => {
    const user = uid("ttl-member");
    await seedContact(user);
    await addBucketMember({ ...deps, bucketId: TTL_ID, userId: user });

    // Rewind the TTL deadline past now (the clock advancing 48h).
    await db
      .update(bucketMemberships)
      .set({ maxDwellAt: new Date(Date.now() - HOUR) })
      .where(
        and(
          eq(bucketMemberships.bucketId, TTL_ID),
          eq(bucketMemberships.userId, user),
        ),
      );
    pushSpy.mockClear();

    await runReconcile();

    const row = await membershipRow(user, TTL_ID);
    expect(row?.status).toBe("left");
    expect(pushCountForUser(`bucket:left:${TTL_ID}`, user)).toBe(1);
    expect(
      lastPushForUser(`bucket:left:${TTL_ID}`, user)?.properties?.reason,
    ).toBe("maxDwell");
  });
});

describe("manual bucket: minDwell-deferred leave resolution (AC 7)", () => {
  it("holds the leave inside the window, then resolves it once elapsed", async () => {
    const user = uid("defer-member");
    await seedContact(user);
    await addBucketMember({ ...deps, bucketId: DEFER_ID, userId: user });

    const removed = await removeBucketMember({
      ...deps,
      bucketId: DEFER_ID,
      userId: user,
    });
    expect(removed.verdict).toBe("deferred");
    expect(removed.emitted).toBe(false);

    // A sweep INSIDE the dwell window must not leave: the deadline is armed in
    // the future.
    pushSpy.mockClear();
    await runReconcile();
    expect((await membershipRow(user, DEFER_ID))?.status).toBe("active");
    expect(pushCountForUser(`bucket:left:${DEFER_ID}`, user)).toBe(0);

    // Advance the clock past the armed deadline (rewind the row instead).
    await db
      .update(bucketMemberships)
      .set({
        enteredAt: new Date(Date.now() - 3 * HOUR),
        expiresAt: new Date(Date.now() - HOUR),
      })
      .where(
        and(
          eq(bucketMemberships.bucketId, DEFER_ID),
          eq(bucketMemberships.userId, user),
        ),
      );

    pushSpy.mockClear();
    await runReconcile();

    expect((await membershipRow(user, DEFER_ID))?.status).toBe("left");
    expect(pushCountForUser(`bucket:left:${DEFER_ID}`, user)).toBe(1);
    expect(
      lastPushForUser(`bucket:left:${DEFER_ID}`, user)?.properties?.reason,
    ).toBe("manual");

    // And it is not re-emitted on the next sweep (the row is no longer active).
    pushSpy.mockClear();
    await runReconcile();
    expect(pushCountForUser(`bucket:left:${DEFER_ID}`, user)).toBe(0);
  });

  it("never leaves a member who has no pending leave, however long they have dwelt", async () => {
    const user = uid("defer-untouched");
    await seedContact(user);
    await addBucketMember({ ...deps, bucketId: DEFER_ID, userId: user });
    // Older than minDwell, but nobody ever asked for them to be removed, so
    // `expiresAt` is NULL. Selecting on age alone would force-leave them.
    await db
      .update(bucketMemberships)
      .set({ enteredAt: new Date(Date.now() - 5 * HOUR), expiresAt: null })
      .where(
        and(
          eq(bucketMemberships.bucketId, DEFER_ID),
          eq(bucketMemberships.userId, user),
        ),
      );

    pushSpy.mockClear();
    await runReconcile();

    expect((await membershipRow(user, DEFER_ID))?.status).toBe("active");
    expect(pushCountForUser(`bucket:left:${DEFER_ID}`, user)).toBe(0);
  });

  // The deferral must be a recorded INTENT. A due `expiresAt` with no
  // pending-leave marker is what a dynamic bucket's criteria-window arming
  // leaves behind — nobody asked for this member to be removed.
  it("never resolves a due deadline that carries no pending-leave marker", async () => {
    const user = uid("defer-nomarker");
    await seedContact(user);
    await addBucketMember({ ...deps, bucketId: DEFER_ID, userId: user });
    await db
      .update(bucketMemberships)
      .set({
        enteredAt: new Date(Date.now() - 3 * HOUR),
        expiresAt: new Date(Date.now() - HOUR),
      })
      .where(
        and(
          eq(bucketMemberships.bucketId, DEFER_ID),
          eq(bucketMemberships.userId, user),
        ),
      );

    pushSpy.mockClear();
    await runReconcile();

    expect((await membershipRow(user, DEFER_ID))?.status).toBe("active");
    expect(pushCountForUser(`bucket:left:${DEFER_ID}`, user)).toBe(0);
  });

  // AC 7 "never drop it" for an ANONYMOUS-ONLY contact. `addBucketMember`
  // writes the CANONICAL key (`external_id ?? anonymous_id ?? id`) onto
  // `bucket_memberships.userId`, so a resolution pass joining `contacts` on
  // `external_id` alone never selects this row — the leave is deferred forever
  // rather than deferred-then-applied.
  it("resolves a deferred leave for an anonymous-only contact", async () => {
    const user = uid("defer-anon");
    await db
      .insert(contacts)
      .values({ anonymousId: user, properties: {} })
      .onConflictDoNothing();
    await addBucketMember({ ...deps, bucketId: DEFER_ID, userId: user });

    const removed = await removeBucketMember({
      ...deps,
      bucketId: DEFER_ID,
      userId: user,
    });
    expect(removed.verdict).toBe("deferred");

    await db
      .update(bucketMemberships)
      .set({
        enteredAt: new Date(Date.now() - 3 * HOUR),
        expiresAt: new Date(Date.now() - HOUR),
      })
      .where(
        and(
          eq(bucketMemberships.bucketId, DEFER_ID),
          eq(bucketMemberships.userId, user),
        ),
      );

    pushSpy.mockClear();
    await runReconcile();

    expect((await membershipRow(user, DEFER_ID))?.status).toBe("left");
    expect(pushCountForUser(`bucket:left:${DEFER_ID}`, user)).toBe(1);
  });

  // A re-add before the sweep cancels the pending leave. Without the disarm the
  // member is a CURRENT member carrying a live deadline, and this sweep
  // force-leaves them + emits a spurious `bucket:left`.
  it("does not force-leave a member whose deferred leave a re-add disarmed", async () => {
    const user = uid("defer-readd");
    await seedContact(user);
    await addBucketMember({ ...deps, bucketId: DEFER_ID, userId: user });

    const removed = await removeBucketMember({
      ...deps,
      bucketId: DEFER_ID,
      userId: user,
    });
    expect(removed.verdict).toBe("deferred");

    // The clock advances past the armed deadline before the cron next runs.
    await db
      .update(bucketMemberships)
      .set({
        enteredAt: new Date(Date.now() - 3 * HOUR),
        expiresAt: new Date(Date.now() - HOUR),
      })
      .where(
        and(
          eq(bucketMemberships.bucketId, DEFER_ID),
          eq(bucketMemberships.userId, user),
        ),
      );

    const readd = await addBucketMember({
      ...deps,
      bucketId: DEFER_ID,
      userId: user,
    });
    expect(readd.verdict).toBe("already-active");

    pushSpy.mockClear();
    await runReconcile();

    expect((await membershipRow(user, DEFER_ID))?.status).toBe("active");
    expect(pushCountForUser(`bucket:left:${DEFER_ID}`, user)).toBe(0);
  });

  // `emit: false` is honoured on the defer branch too: the leave still LANDS
  // (never dropped), it just stays silent — the seed contract, DECISIONS §2.7a.
  it("applies an emit:false deferred leave without emitting", async () => {
    const user = uid("defer-silent");
    await seedContact(user);
    await addBucketMember({ ...deps, bucketId: DEFER_ID, userId: user });

    const removed = await removeBucketMember({
      ...deps,
      bucketId: DEFER_ID,
      userId: user,
      emit: false,
    });
    expect(removed.verdict).toBe("deferred");

    await db
      .update(bucketMemberships)
      .set({
        enteredAt: new Date(Date.now() - 3 * HOUR),
        expiresAt: new Date(Date.now() - HOUR),
      })
      .where(
        and(
          eq(bucketMemberships.bucketId, DEFER_ID),
          eq(bucketMemberships.userId, user),
        ),
      );

    pushSpy.mockClear();
    await runReconcile();

    expect((await membershipRow(user, DEFER_ID))?.status).toBe("left");
    expect(pushCountForUser(`bucket:left:${DEFER_ID}`, user)).toBe(0);
  });

  it("honours the ARMED deadline, not the bucket's current minDwell window", async () => {
    const user = uid("defer-armed-later");
    await seedContact(user);
    await addBucketMember({ ...deps, bucketId: DEFER_ID, userId: user });
    // The state left behind when `minDwell` was LONGER at arming time than it
    // is now: the row is older than the current 2h window, but the deadline it
    // was actually promised is still in the future. The armed deadline wins.
    await db
      .update(bucketMemberships)
      .set({
        enteredAt: new Date(Date.now() - 5 * HOUR),
        expiresAt: new Date(Date.now() + HOUR),
      })
      .where(
        and(
          eq(bucketMemberships.bucketId, DEFER_ID),
          eq(bucketMemberships.userId, user),
        ),
      );

    pushSpy.mockClear();
    await runReconcile();

    expect((await membershipRow(user, DEFER_ID))?.status).toBe("active");
    expect(pushCountForUser(`bucket:left:${DEFER_ID}`, user)).toBe(0);
  });
});

describe("manual bucket: dwell pass runs", () => {
  it("fires bucket:dwell for a member dwelling past the `after` offset", async () => {
    const user = uid("dwell-member");
    await seedContact(user);
    await addBucketMember({ ...deps, bucketId: DWELL_ID, userId: user });

    await db
      .update(bucketMemberships)
      .set({ enteredAt: new Date(Date.now() - 10 * DAY) })
      .where(
        and(
          eq(bucketMemberships.bucketId, DWELL_ID),
          eq(bucketMemberships.userId, user),
        ),
      );

    pushSpy.mockClear();
    await runReconcile();

    // A manual bucket NEVER gets a bucket_configs.criteriaHash (nothing
    // backfills it), so the dwell pass's first-deploy quiet window must not
    // apply to it — otherwise this is a permanent no-op.
    expect(
      pushCountForUser(`bucket:dwell:${DWELL_ID}:${DWELL_LABEL}`, user),
    ).toBe(1);
    expect((await membershipRow(user, DWELL_ID))?.status).toBe("active");
  });
});

describe("manual bucket: criteria passes do NOT run", () => {
  it("completes the TTL leave on a manual bucket carrying timeBased + reconcileJoins", async () => {
    const user = uid("trap-member");
    await seedContact(user);
    await addBucketMember({ ...deps, bucketId: TRAP_ID, userId: user });

    await db
      .update(bucketMemberships)
      .set({ maxDwellAt: new Date(Date.now() - HOUR) })
      .where(
        and(
          eq(bucketMemberships.bucketId, TRAP_ID),
          eq(bucketMemberships.userId, user),
        ),
      );
    pushSpy.mockClear();

    await runReconcile();

    // Both criteria passes dereference `bucket.criteria` unguarded. If either
    // ran it would throw into the per-bucket catch and the TTL pass below it
    // would never execute — so a surviving TTL leave is the proof they did not.
    const row = await membershipRow(user, TRAP_ID);
    expect(row?.status).toBe("left");
    expect(pushCountForUser(`bucket:left:${TRAP_ID}`, user)).toBe(1);
    // And no criteria-discovered join was materialized for the bucket.
    expect(pushCountForUser(`bucket:entered:${TRAP_ID}`, user)).toBe(0);
  });
});

describe("dynamic bucket behaviour is unchanged", () => {
  it("does not leave a still-matching member whose expiresAt has passed", async () => {
    const user = uid("dyn-member");
    await seedContact(user);
    // Still matches: fired the event inside the 7-day window.
    await db.insert(userEvents).values({
      userId: user,
      event: DYNAMIC_EVENT,
      properties: {},
      occurredAt: new Date(Date.now() - DAY),
    });
    await db.insert(bucketMemberships).values({
      userId: user,
      userEmail: `${user}@example.com`,
      bucketId: DYNAMIC_ID,
      status: "active",
      source: "event",
      entryCount: 1,
      enteredAt: new Date(Date.now() - 3 * HOUR),
      // The criteria-window arming epoch, already elapsed. A pending-leave pass
      // that keyed on expiresAt alone would force-leave this member.
      expiresAt: new Date(Date.now() - HOUR),
      lastEvaluatedAt: new Date(Date.now() - 3 * HOUR),
    });

    pushSpy.mockClear();
    await runReconcile();

    expect((await membershipRow(user, DYNAMIC_ID))?.status).toBe("active");
    expect(pushCountForUser(`bucket:left:${DYNAMIC_ID}`, user)).toBe(0);
  });

  it("still criteria-leaves a member who fell out of the window", async () => {
    const user = uid("dyn-leaver");
    await seedContact(user);
    // Last activity 30 days ago → outside the 7-day `exists` window.
    await db.insert(userEvents).values({
      userId: user,
      event: DYNAMIC_EVENT,
      properties: {},
      occurredAt: new Date(Date.now() - 30 * DAY),
    });
    await db.insert(bucketMemberships).values({
      userId: user,
      userEmail: `${user}@example.com`,
      bucketId: DYNAMIC_ID,
      status: "active",
      source: "event",
      entryCount: 1,
      enteredAt: new Date(Date.now() - 30 * DAY),
      lastEvaluatedAt: new Date(Date.now() - 30 * DAY),
    });

    pushSpy.mockClear();
    await runReconcile();

    expect((await membershipRow(user, DYNAMIC_ID))?.status).toBe("left");
    expect(pushCountForUser(`bucket:left:${DYNAMIC_ID}`, user)).toBe(1);
    expect(
      lastPushForUser(`bucket:left:${DYNAMIC_ID}`, user)?.properties?.reason,
    ).toBe("criteria");
  });
});

// ===========================================================================
// C. The criteria-INDEPENDENT passes resolve the CANONICAL contact key.
//
// `addBucketMember` stamps `bucket_memberships.userId` with the canonical key
// (`external_id ?? anonymous_id ?? id`) — the same key
// `liveContactByCanonicalKey` pairs with the live-row filter. A pass joining
// `contacts.external_id` alone makes every anonymous-only member invisible to
// it; a pass dropping the `deleted_at IS NULL` half lets an erased contact be
// swept (and a soft-deleted merge loser win the join).
// ===========================================================================

describe("maxDwell TTL pass resolves the canonical contact key", () => {
  it("force-leaves an ANONYMOUS-ONLY member past maxDwellAt", async () => {
    const user = uid("ttl-anon");
    await seedAnonContact(user);
    await addBucketMember({ ...deps, bucketId: TTL_ID, userId: user });

    await db
      .update(bucketMemberships)
      .set({ maxDwellAt: new Date(Date.now() - HOUR) })
      .where(
        and(
          eq(bucketMemberships.bucketId, TTL_ID),
          eq(bucketMemberships.userId, user),
        ),
      );

    pushSpy.mockClear();
    await runReconcile();

    expect((await membershipRow(user, TTL_ID))?.status).toBe("left");
    expect(pushCountForUser(`bucket:left:${TTL_ID}`, user)).toBe(1);
  });

  it("never force-leaves a member whose contact is SOFT-DELETED", async () => {
    const user = uid("ttl-deleted");
    await seedDeletedContact(user);
    await db.insert(bucketMemberships).values({
      userId: user,
      userEmail: `${user}@example.com`,
      bucketId: TTL_ID,
      status: "active",
      source: "manual",
      entryCount: 1,
      enteredAt: new Date(Date.now() - 3 * DAY),
      maxDwellAt: new Date(Date.now() - HOUR),
      lastEvaluatedAt: new Date(Date.now() - 3 * DAY),
    });

    pushSpy.mockClear();
    await runReconcile();

    expect((await membershipRow(user, TTL_ID))?.status).toBe("active");
    expect(pushCountForUser(`bucket:left:${TTL_ID}`, user)).toBe(0);
  });
});

describe("dwell pass resolves the canonical contact key", () => {
  it("fires bucket:dwell for an ANONYMOUS-ONLY member", async () => {
    const user = uid("dwell-anon");
    await seedAnonContact(user);
    await addBucketMember({ ...deps, bucketId: DWELL_ID, userId: user });

    await db
      .update(bucketMemberships)
      .set({ enteredAt: new Date(Date.now() - 10 * DAY) })
      .where(
        and(
          eq(bucketMemberships.bucketId, DWELL_ID),
          eq(bucketMemberships.userId, user),
        ),
      );

    pushSpy.mockClear();
    await runReconcile();

    expect(
      pushCountForUser(`bucket:dwell:${DWELL_ID}:${DWELL_LABEL}`, user),
    ).toBe(1);
    const row = await membershipRow(user, DWELL_ID);
    expect(row?.dwellState as Record<string, string> | null).toHaveProperty(
      DWELL_LABEL,
    );
  });

  // The assertion is the `dwellState` STAMP, not the push. A dwell emit for a
  // soft-deleted contact is dropped downstream anyway (the provenance pin hits
  // `ContactProvenanceLostError` in `ingestEvent`), so a push-count assertion
  // here would be green whether or not the pass selected the row. The stamp is
  // written by the dwell pass itself, so it is the honest observable.
  it("never fires dwell for a member whose contact is SOFT-DELETED", async () => {
    const user = uid("dwell-deleted");
    await seedDeletedContact(user);
    await db.insert(bucketMemberships).values({
      userId: user,
      userEmail: `${user}@example.com`,
      bucketId: DWELL_ID,
      status: "active",
      source: "manual",
      entryCount: 1,
      enteredAt: new Date(Date.now() - 10 * DAY),
      lastEvaluatedAt: new Date(Date.now() - 10 * DAY),
    });

    pushSpy.mockClear();
    await runReconcile();

    const row = await membershipRow(user, DWELL_ID);
    expect(
      (row?.dwellState as Record<string, string> | null) ?? {},
    ).not.toHaveProperty(DWELL_LABEL);
    expect(
      pushCountForUser(`bucket:dwell:${DWELL_ID}:${DWELL_LABEL}`, user),
    ).toBe(0);
  });
});

describe("pending-leave pass resolves the canonical contact key", () => {
  // The anonymous-only leg is covered by "resolves a deferred leave for an
  // anonymous-only contact" above; this is the live-row half of the same
  // predicate.
  it("never resolves a deferred leave for a SOFT-DELETED contact", async () => {
    const user = uid("defer-deleted");
    await seedDeletedContact(user);
    await db.insert(bucketMemberships).values({
      userId: user,
      userEmail: `${user}@example.com`,
      bucketId: DEFER_ID,
      status: "active",
      source: "manual",
      entryCount: 1,
      enteredAt: new Date(Date.now() - 5 * HOUR),
      expiresAt: new Date(Date.now() - HOUR),
      context: pendingLeave(new Date(Date.now() - HOUR), true),
      lastEvaluatedAt: new Date(Date.now() - 5 * HOUR),
    });

    pushSpy.mockClear();
    await runReconcile();

    expect((await membershipRow(user, DEFER_ID))?.status).toBe("active");
    expect(pushCountForUser(`bucket:left:${DEFER_ID}`, user)).toBe(0);
  });
});

// ===========================================================================
// D. The pending-leave pass is BATCH_SIZE-bounded and cannot stall.
// ===========================================================================

/** Mirrors the engine-internal `BATCH_SIZE` in bucket-reconcile.ts. */
const BATCH_SIZE = 500;

/**
 * Bulk-seed `count` due pending leaves into `bucketId`. All silent
 * (`emit: false`) so the sweep is one SELECT + one UPDATE — the bound is what
 * is under test, not the emit path. `expiresAt` is strictly ascending with the
 * index, so the `expiresAt asc, id asc` selection order is TOTAL and the row
 * left behind by a bounded sweep is deterministic (never heap order).
 */
async function seedDuePendingLeaves(opts: {
  bucketId: string;
  prefix: string;
  count: number;
  enteredAgoMs: number;
}): Promise<string[]> {
  const { bucketId, prefix, count, enteredAgoMs } = opts;
  const now = Date.now();
  const users = Array.from({ length: count }, (_, i) =>
    uid(`${prefix}-${String(i).padStart(4, "0")}`),
  );
  await db
    .insert(contacts)
    .values(
      users.map((u) => ({
        externalId: u,
        email: `${u}@example.com`,
        properties: {},
      })),
    )
    .onConflictDoNothing();
  await db.insert(bucketMemberships).values(
    users.map((u, i) => {
      // Strictly ascending, all in the past: index 0 is the longest overdue.
      const expiresAt = new Date(now - (count - i) * 60_000);
      return {
        userId: u,
        userEmail: `${u}@example.com`,
        bucketId,
        status: "active" as const,
        source: "manual",
        entryCount: 1,
        enteredAt: new Date(now - enteredAgoMs),
        expiresAt,
        context: pendingLeave(expiresAt, false),
        lastEvaluatedAt: new Date(now - enteredAgoMs),
      };
    }),
  );
  return users;
}

async function statusByUser(
  bucketId: string,
): Promise<Map<string, string | null>> {
  const rows = await db
    .select({
      userId: bucketMemberships.userId,
      status: bucketMemberships.status,
    })
    .from(bucketMemberships)
    .where(eq(bucketMemberships.bucketId, bucketId));
  return new Map(rows.map((r) => [r.userId, r.status]));
}

describe("pending-leave pass: BATCH_SIZE bound", () => {
  it("resolves at most BATCH_SIZE due leaves per sweep, longest-overdue first", async () => {
    const users = await seedDuePendingLeaves({
      bucketId: BOUND_ID,
      prefix: "bound",
      count: BATCH_SIZE + 1,
      enteredAgoMs: 10 * HOUR,
    });

    await runReconcile();

    const afterFirst = await statusByUser(BOUND_ID);
    const left = users.filter((u) => afterFirst.get(u) === "left");
    const active = users.filter((u) => afterFirst.get(u) === "active");
    expect(left).toHaveLength(BATCH_SIZE);
    expect(active).toHaveLength(1);
    // Deterministic remainder: the LATEST `expiresAt`, i.e. the last seeded.
    expect(active[0]).toBe(users[BATCH_SIZE]);

    // The queue drains — the bound defers work, it does not drop it.
    await runReconcile();
    const afterSecond = await statusByUser(BOUND_ID);
    expect(users.filter((u) => afterSecond.get(u) === "active")).toHaveLength(
      0,
    );
  });
});

describe("pending-leave pass: a RAISED minDwell re-defers without looping", () => {
  // The armed `expiresAt` was computed against the minDwell in force at REMOVAL
  // time. Raising minDwell and redeploying leaves rows whose armed deadline is
  // due but whose CURRENT floor is not met — `bulkLeave` refuses them. If the
  // selector does not apply the same floor, those rows sit at the head of the
  // `expiresAt asc` queue every sweep, consume the whole BATCH_SIZE, and starve
  // the leaves that really are due.
  it("does not let re-deferred rows starve a genuinely due leave", async () => {
    const stuck = await seedDuePendingLeaves({
      bucketId: STARVE_ID,
      prefix: "starve-stuck",
      count: BATCH_SIZE,
      // INSIDE the bucket's current 2h minDwell floor → must be re-deferred.
      enteredAgoMs: HOUR,
    });

    const dueUser = uid("starve-due");
    await seedContact(dueUser);
    await db.insert(bucketMemberships).values({
      userId: dueUser,
      userEmail: `${dueUser}@example.com`,
      bucketId: STARVE_ID,
      status: "active",
      source: "manual",
      entryCount: 1,
      // Past the floor, and the LATEST expiresAt of the set — so an
      // `expiresAt asc` sweep reaches it only once the stuck rows are excluded.
      enteredAt: new Date(Date.now() - 10 * HOUR),
      expiresAt: new Date(Date.now() - 60_000),
      context: pendingLeave(new Date(Date.now() - 60_000), true),
      lastEvaluatedAt: new Date(Date.now() - 10 * HOUR),
    });

    pushSpy.mockClear();
    await runReconcile();

    const statuses = await statusByUser(STARVE_ID);
    expect(statuses.get(dueUser)).toBe("left");
    expect(pushCountForUser(`bucket:left:${STARVE_ID}`, dueUser)).toBe(1);
    // …and the re-deferred rows are untouched: raising minDwell holds the
    // leave, it never force-applies it early.
    expect(stuck.filter((u) => statuses.get(u) === "active")).toHaveLength(
      BATCH_SIZE,
    );
  });
});

// ===========================================================================
// E. A deferred leave can never be STRANDED.
//
// AC 7 is "minDwell DEFERS the leave, NEVER DROPS it". A deferral that no pass
// will ever look at again is a DROP that also leaves the member permanently
// `active` with an armed deadline — strictly worse than dropping it cleanly.
// Both strandings below are reached by CONFIG, not by data: the marker outlives
// the config edit that made it, so the selector must key on the marker.
// ===========================================================================

/** Insert an ACTIVE membership already carrying a DUE pending leave. */
async function seedDuePendingLeave(opts: {
  bucketId: string;
  userId: string;
  emit: boolean;
  enteredAgoMs?: number;
  dueAgoMs?: number;
  maxDwellAt?: Date | null;
}): Promise<void> {
  const {
    bucketId,
    userId,
    emit,
    enteredAgoMs = 5 * HOUR,
    dueAgoMs = HOUR,
    maxDwellAt = null,
  } = opts;
  const expiresAt = new Date(Date.now() - dueAgoMs);
  await db.insert(bucketMemberships).values({
    userId,
    userEmail: `${userId}@example.com`,
    bucketId,
    status: "active",
    source: "manual",
    entryCount: 1,
    enteredAt: new Date(Date.now() - enteredAgoMs),
    expiresAt,
    ...(maxDwellAt ? { maxDwellAt } : {}),
    context: pendingLeave(expiresAt, emit),
    lastEvaluatedAt: new Date(Date.now() - enteredAgoMs),
  });
}

describe("pending-leave pass: the selector keys on the MARKER, not on config", () => {
  // (a) The operator REMOVES `minDwell` after a leave was deferred. The armed
  // row survives the edit; a selector reading the bucket's CURRENT `minDwell`
  // switches the only pass that can resolve it off, permanently.
  it("resolves a deferred leave on a bucket whose minDwell was since removed", async () => {
    const user = uid("nomindwell-defer");
    await seedContact(user);
    await seedDuePendingLeave({ bucketId: NOMIN_ID, userId: user, emit: true });

    pushSpy.mockClear();
    await runReconcile();

    expect((await membershipRow(user, NOMIN_ID))?.status).toBe("left");
    expect(pushCountForUser(`bucket:left:${NOMIN_ID}`, user)).toBe(1);
    expect(
      lastPushForUser(`bucket:left:${NOMIN_ID}`, user)?.properties?.reason,
    ).toBe("manual");
  });

  // (b) The operator DISABLES the bucket after a leave was deferred. The sweep
  // iterates enabled buckets, so the row is never looked at again.
  it("resolves a deferred leave on a DISABLED bucket, silently", async () => {
    const user = uid("disabled-defer");
    await seedContact(user);
    await seedDuePendingLeave({
      bucketId: DISABLED_ID,
      userId: user,
      // Recorded `emit: true` — the suppression under test comes from the
      // bucket being switched OFF, not from the marker.
      emit: true,
    });

    pushSpy.mockClear();
    await runReconcile();

    // The row is resolved (never stranded active with an armed deadline)…
    expect((await membershipRow(user, DISABLED_ID))?.status).toBe("left");
    // …and a switched-off bucket fires NOTHING into live journeys (§2.7a).
    expect(pushCountForUser(`bucket:left:${DISABLED_ID}`, user)).toBe(0);
  });
});

// ===========================================================================
// F. The pending-leave CAS is honest about every predicate its SELECT used.
// ===========================================================================

describe("pending-leave pass: a re-add between SELECT and UPDATE wins", () => {
  // `addBucketMember` disarms a pending leave precisely so a re-added member is
  // not force-left by the next sweep. That disarm is worthless if the sweep's
  // UPDATE does not RE-ASSERT the marker + deadline: the SELECT already
  // captured the row, so the UPDATE flips a member the caller just re-added.
  //
  // The disarm is landed from inside the emit of the OTHER (emit:true) row —
  // `ingestEvent` awaits `hatchet.events.push`, and the pass emits its
  // `emit: true` partition before flipping the silent one, so that push is a
  // deterministic point strictly between the SELECT and the silent UPDATE.
  it("does not flip a row whose pending leave a re-add disarmed mid-sweep", async () => {
    const trigger = uid("race-trigger");
    const raced = uid("race-readded");
    await seedContact(trigger);
    await seedContact(raced);
    await seedDuePendingLeave({
      bucketId: RACE_ID,
      userId: trigger,
      emit: true,
      dueAgoMs: 2 * HOUR,
    });
    await seedDuePendingLeave({
      bucketId: RACE_ID,
      userId: raced,
      emit: false,
      dueAgoMs: HOUR,
    });

    pushSpy.mockClear();
    let disarmed = false;
    onPush = async (event, userId) => {
      if (
        disarmed ||
        event !== `bucket:left:${RACE_ID}` ||
        userId !== trigger
      ) {
        return;
      }
      disarmed = true;
      // The REAL re-add path, not a hand-rolled UPDATE.
      const readd = await addBucketMember({
        ...deps,
        bucketId: RACE_ID,
        userId: raced,
      });
      expect(readd.verdict).toBe("already-active");
    };

    await runReconcile();
    expect(disarmed).toBe(true);

    // The trigger row is unaffected — it really was due and really did leave.
    expect((await membershipRow(trigger, RACE_ID))?.status).toBe("left");

    // The re-added member is STILL a member: the CAS re-checked the marker and
    // the armed deadline, both cleared by the disarm, so it matched zero rows.
    const racedRow = await membershipRow(raced, RACE_ID);
    expect(racedRow?.status).toBe("active");
    expect(racedRow?.expiresAt).toBeNull();
    expect(
      (racedRow?.context as Record<string, unknown> | null) ?? {},
    ).not.toHaveProperty("__pendingLeave__");
    expect(pushCountForUser(`bucket:left:${RACE_ID}`, raced)).toBe(0);
  });
});

// ===========================================================================
// G. The TTL pass must not destroy a recorded `emit: false`.
// ===========================================================================

describe("maxDwell TTL pass honours a SUPPRESSED pending leave", () => {
  // A seeded population removed inside the dwell window records `emit: false`
  // on the marker. On a bucket with BOTH ceilings the TTL deadline can come due
  // on the SAME tick, and the TTL pass runs FIRST — force-leaving the row and
  // emitting `bucket:left` with `reason: "maxDwell"`, i.e. firing a SEEDED
  // population into live journeys (DECISIONS §2.7a) and destroying the recorded
  // intent (the row is already `left` when the pending pass runs).
  //
  // The EMIT is the assertion. A status-only check is green either way — the
  // row ends `left` whichever pass reaches it — while the journey-visible event
  // still fired, which IS the defect.
  it("emits nothing when an emit:false deferral and maxDwell come due together", async () => {
    const user = uid("seedttl-silent");
    await seedContact(user);

    const added = await addBucketMember({
      ...deps,
      bucketId: SEEDTTL_ID,
      userId: user,
      emit: false,
    });
    expect(added.verdict).toBe("seeded");

    const removed = await removeBucketMember({
      ...deps,
      bucketId: SEEDTTL_ID,
      userId: user,
      emit: false,
    });
    expect(removed.verdict).toBe("deferred");

    // Both deadlines due on this tick (maxDwell >= minDwell is schema-enforced,
    // so a due maxDwellAt always implies a due armed expiresAt).
    await db
      .update(bucketMemberships)
      .set({
        enteredAt: new Date(Date.now() - 72 * HOUR),
        expiresAt: new Date(Date.now() - 70 * HOUR),
        maxDwellAt: new Date(Date.now() - 24 * HOUR),
      })
      .where(
        and(
          eq(bucketMemberships.bucketId, SEEDTTL_ID),
          eq(bucketMemberships.userId, user),
        ),
      );

    pushSpy.mockClear();
    await runReconcile();

    // Applied, never dropped — the leave still lands…
    expect((await membershipRow(user, SEEDTTL_ID))?.status).toBe("left");
    // …and stays SILENT. This is the assertion the defect breaks: without the
    // TTL exclusion the row leaves with `reason: "maxDwell"` and this is 1.
    expect(pushCountForUser(`bucket:left:${SEEDTTL_ID}`, user)).toBe(0);
  });

  // An `emit: true` deferral whose armed deadline is ALSO due is resolvable by
  // the PENDING pass on this same tick, so both passes could leave the row —
  // but they emit different journey-visible `reason`s. "manual" is the truth:
  // an operator explicitly removed this member and `minDwell` merely delayed
  // it. Leaving the answer to pass ORDER means a journey branching on `reason`
  // gets a value that depends on how the sweep happens to be sequenced.
  it("a due emit:true deferral leaves with reason manual, not maxDwell", async () => {
    const user = uid("seedttl-reason");
    await seedContact(user);
    await seedDuePendingLeave({
      bucketId: SEEDTTL_ID,
      userId: user,
      emit: true,
      enteredAgoMs: 72 * HOUR,
      // Positive → the armed deadline is DUE, so the pending pass owns this row.
      dueAgoMs: HOUR,
      maxDwellAt: new Date(Date.now() - 24 * HOUR),
    });

    pushSpy.mockClear();
    await runReconcile();

    expect((await membershipRow(user, SEEDTTL_ID))?.status).toBe("left");
    // Journey-visible either way, so a count assertion alone would pass with
    // the defect present — the REASON is the whole finding.
    expect(pushCountForUser(`bucket:left:${SEEDTTL_ID}`, user)).toBe(1);
    expect(
      lastPushForUser(`bucket:left:${SEEDTTL_ID}`, user)?.properties?.reason,
    ).toBe("manual");
  });

  // The exclusion must be NARROW — `emit: false` only, never "any marker". The
  // discriminating state is a marker whose armed deadline is NOT yet due while
  // `maxDwellAt` IS (the operator LOWERED `minDwell` after the deferral was
  // armed, so `expiresAt = enteredAt + oldMinDwell` outruns
  // `maxDwellAt = enteredAt + maxDwell`). The pending pass cannot touch this row
  // — its deadline is in the future — so if the TTL pass skipped every marker
  // the member would sit past their TTL ceiling with nobody to force-leave them.
  // An `emit: true` leave is journey-visible whichever pass reaches it, so the
  // TTL ceiling wins here and the emit is correct.
  it("still force-leaves a row whose pending leave is emit:true and not yet due", async () => {
    const user = uid("seedttl-loud");
    await seedContact(user);
    await seedDuePendingLeave({
      bucketId: SEEDTTL_ID,
      userId: user,
      emit: true,
      enteredAgoMs: 72 * HOUR,
      // Negative → the armed deadline is still an hour AWAY.
      dueAgoMs: -HOUR,
      maxDwellAt: new Date(Date.now() - 24 * HOUR),
    });

    pushSpy.mockClear();
    await runReconcile();

    expect((await membershipRow(user, SEEDTTL_ID))?.status).toBe("left");
    expect(pushCountForUser(`bucket:left:${SEEDTTL_ID}`, user)).toBe(1);
    expect(
      lastPushForUser(`bucket:left:${SEEDTTL_ID}`, user)?.properties?.reason,
    ).toBe("maxDwell");
  });
});
