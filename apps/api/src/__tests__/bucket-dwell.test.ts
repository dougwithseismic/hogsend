import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// DB-touching test against the real docker TimescaleDB (mirrors
// bucket-reconcile.test.ts), overriding the vitest.config placeholder
// DATABASE_URL.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Dual mock: the reconcile task + the desugared dwell reactions are BUILT inside
// @hogsend/engine, which uses the ENGINE's own `lib/hatchet.js`, so we mock BOTH
// that absolute source path AND the API's `../lib/hatchet.js`. The mock PRESERVES
// the `config` passed to `task()` so `bucketReconcileTask.fn` survives and the
// test can invoke the cron body directly. `events.push` is a spy so the test can
// prove the dwell pass emits `bucket:dwell:<id>:<label>` through ingestEvent.
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

const { bucketConfigs, bucketMemberships, contacts, userEvents } = await import(
  "@hogsend/db"
);
const { and, eq, like } = await import("drizzle-orm");
const {
  bucketReconcileTask,
  computeCriteriaHash,
  createHogsendClient,
  days,
  defineBucket,
  durationToMs,
  hours,
  resetBucketRegistry,
} = await import("@hogsend/engine");

const container = createHogsendClient();
const { db } = container;

// `bucketReconcileTask.fn` is the real cron body (the mock preserved it). It
// self-bootstraps db from process.env and reads the process bucket + journey
// registry singletons — all installed by createHogsendClient below.
const reconcileTask = bucketReconcileTask as unknown as {
  fn: () => Promise<{ reconciled: number; joined: number }>;
};
const runReconcile = () => reconcileTask.fn();

const RUN = `dwl-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const uid = (label: string) => `${RUN}-${label}`;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

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
 * Seed an ACTIVE membership row for (user, bucket) with a controlled dwell clock.
 * `enteredAt` defaults to `now - ageMs`; `dwellAnchorAt`/`dwellState` are optional
 * (the dwell gate reads coalesce(dwellAnchorAt, enteredAt)). Returns the row id.
 */
async function seedActiveMembership(opts: {
  userId: string;
  bucketId: string;
  ageMs?: number;
  dwellAnchorAt?: Date | null;
  dwellState?: Record<string, string>;
}): Promise<string> {
  const enteredAt = new Date(Date.now() - (opts.ageMs ?? 0));
  const [row] = await db
    .insert(bucketMemberships)
    .values({
      userId: opts.userId,
      userEmail: `${opts.userId}@example.com`,
      bucketId: opts.bucketId,
      status: "active",
      source: "reconcile",
      entryCount: 1,
      enteredAt,
      dwellAnchorAt: opts.dwellAnchorAt ?? null,
      dwellState: opts.dwellState ?? {},
      lastEvaluatedAt: new Date(Date.now() - DAY),
    })
    .returning({ id: bucketMemberships.id });
  if (!row) throw new Error("failed to seed membership");
  return row.id;
}

async function activeRow(userId: string, bucketId: string) {
  return db.query.bucketMemberships.findFirst({
    where: and(
      eq(bucketMemberships.userId, userId),
      eq(bucketMemberships.bucketId, bucketId),
      eq(bucketMemberships.status, "active"),
    ),
  });
}

/** How many `bucket:dwell:<id>:<label>` pushes targeted a specific user. */
function dwellPushCountForUser(
  bucketId: string,
  label: string,
  userId: string,
): number {
  const name = `bucket:dwell:${bucketId}:${label}`;
  return pushSpy.mock.calls.filter(
    (c) =>
      c[0] === name &&
      (c[1] as { userId?: string } | undefined)?.userId === userId,
  ).length;
}

/** The most recent dwell push payload for a user (to assert dwellCount). */
function lastDwellPushForUser(
  bucketId: string,
  label: string,
  userId: string,
): { userId?: string; properties?: { dwellCount?: number } } | undefined {
  const name = `bucket:dwell:${bucketId}:${label}`;
  const matches = pushSpy.mock.calls.filter(
    (c) =>
      c[0] === name &&
      (c[1] as { userId?: string } | undefined)?.userId === userId,
  );
  return matches[matches.length - 1]?.[1] as
    | { userId?: string; properties?: { dwellCount?: number } }
    | undefined;
}

/** Count of `userEvents` rows for a dwell event for a user (history parity). */
async function dwellUserEventCount(
  bucketId: string,
  label: string,
  userId: string,
): Promise<number> {
  const rows = await db
    .select({ id: userEvents.id })
    .from(userEvents)
    .where(
      and(
        eq(userEvents.userId, userId),
        eq(userEvents.event, `bucket:dwell:${bucketId}:${label}`),
      ),
    );
  return rows.length;
}

/**
 * Persist a bucket's criteriaHash so firstTimeBackfillIncomplete returns false
 * (the first-deploy quiet window is satisfied), mirroring the real lifecycle
 * where the backfill persists the hash before the cron's dwell pass may fire.
 */
async function settleBackfill(
  bucket: ReturnType<typeof defineBucket>,
): Promise<void> {
  const hash = computeCriteriaHash(bucket.meta.criteria);
  await db
    .insert(bucketConfigs)
    .values({ bucketId: bucket.meta.id, criteriaHash: hash })
    .onConflictDoUpdate({
      target: bucketConfigs.bucketId,
      set: { criteriaHash: hash, updatedAt: new Date() },
    });
}

/**
 * Build a dwell-only bucket: a PURE PROPERTY criterion, so it is NOT time-based
 * and has NO maxDwell — only the dwell pass should run (Test 22's widened-gate
 * path). The caller attaches `.on("dwell", ...)` and threads it through
 * createHogsendClient to install the bucket + journey registry singletons.
 */
function makeDwellBucket(id: string) {
  return defineBucket({
    meta: {
      id,
      name: "Dwell bucket",
      enabled: true,
      criteria: (b) => b.prop("plan").eq("x"),
    },
  });
}

beforeEach(() => {
  pushSpy.mockClear();
});

afterAll(async () => {
  resetBucketRegistry();
  await db
    .delete(bucketMemberships)
    .where(like(bucketMemberships.userId, `${RUN}-%`));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}-%`));
  await db
    .delete(bucketConfigs)
    .where(like(bucketConfigs.bucketId, `${RUN}-%`));
});

// ===========================================================================
// 16 — existing-population fire (after) + userEvents/history parity
// ===========================================================================

describe("dwell existing-population fire (Test 16)", () => {
  it("fires one bucket:dwell push per dwelling member with dwellCount 1, written to userEvents", async () => {
    const bucketId = uid("after-fire");
    const bucket = makeDwellBucket(bucketId);
    bucket.on("dwell", { after: days(7) }, async () => {});
    const label = `after-${durationToMs(days(7))}`;

    // Install bucket + journey-registry singletons (carries the dwell reaction).
    createHogsendClient({ buckets: [bucket] });
    await settleBackfill(bucket);

    // N active members dwelling longer than `after` (10 days > 7).
    const members = [uid("m1"), uid("m2"), uid("m3")];
    for (const m of members) {
      await seedContact(m);
      await seedActiveMembership({ userId: m, bucketId, ageMs: 10 * DAY });
    }

    await runReconcile();

    for (const m of members) {
      expect(dwellPushCountForUser(bucketId, label, m)).toBe(1);
      expect(
        lastDwellPushForUser(bucketId, label, m)?.properties?.dwellCount,
      ).toBe(1);
      // userEvents row written (exitOn/history/analytics parity, NOT a raw push).
      expect(await dwellUserEventCount(bucketId, label, m)).toBe(1);
    }
  });
});

// ===========================================================================
// 17 — idempotency across sweeps (after fires exactly once)
// ===========================================================================

describe("dwell idempotency across sweeps (Test 17)", () => {
  it("a second sweep emits zero additional dwell pushes (dwellState gate)", async () => {
    const bucketId = uid("after-idem");
    const bucket = makeDwellBucket(bucketId);
    bucket.on("dwell", { after: days(7) }, async () => {});
    const label = `after-${durationToMs(days(7))}`;

    createHogsendClient({ buckets: [bucket] });
    await settleBackfill(bucket);

    const m = uid("idem-member");
    await seedContact(m);
    await seedActiveMembership({ userId: m, bucketId, ageMs: 10 * DAY });

    await runReconcile();
    expect(dwellPushCountForUser(bucketId, label, m)).toBe(1);

    // Second sweep: dwellState[label] is set → no second fire.
    pushSpy.mockClear();
    await runReconcile();
    expect(dwellPushCountForUser(bucketId, label, m)).toBe(0);
  });
});

// ===========================================================================
// 17b — intra-sweep retry dedup (same key absorbed by userEvents)
// ===========================================================================

describe("dwell intra-sweep retry dedup (Test 17b)", () => {
  it("a retried sweep recomputes the identical idempotencyKey and writes no second userEvents row", async () => {
    const bucketId = uid("after-retry");
    const bucket = makeDwellBucket(bucketId);
    bucket.on("dwell", { after: days(7) }, async () => {});
    const label = `after-${durationToMs(days(7))}`;

    createHogsendClient({ buckets: [bucket] });
    await settleBackfill(bucket);

    const m = uid("retry-member");
    await seedContact(m);
    const rowId = await seedActiveMembership({
      userId: m,
      bucketId,
      ageMs: 10 * DAY,
    });

    await runReconcile();
    expect(await dwellUserEventCount(bucketId, label, m)).toBe(1);

    // Simulate a SAME-sweep retry: clear the inter-sweep dwellState stamp so the
    // gate would fire again, but the deterministic idempotencyKey (one-shot
    // ordinal=1) recomputes identically → the userEvents onConflictDoNothing
    // dedup absorbs it (no second history row).
    await db
      .update(bucketMemberships)
      .set({ dwellState: {} })
      .where(eq(bucketMemberships.id, rowId));

    await runReconcile();
    expect(await dwellUserEventCount(bucketId, label, m)).toBe(1);
  });
});

// ===========================================================================
// 18 — continuous-membership gate (left member + re-join)
// ===========================================================================

describe("dwell continuous-membership gate (Test 18)", () => {
  it("a force-left member does NOT dwell; a freshly re-joined member does not fire until aged past after", async () => {
    const bucketId = uid("continuous");
    const bucket = makeDwellBucket(bucketId);
    bucket.on("dwell", { after: days(7) }, async () => {});
    const label = `after-${durationToMs(days(7))}`;

    createHogsendClient({ buckets: [bucket] });
    await settleBackfill(bucket);

    // A member who LEFT (status 'left') is excluded by the active-only scan.
    const leftUser = uid("left-user");
    await seedContact(leftUser);
    await db.insert(bucketMemberships).values({
      userId: leftUser,
      userEmail: `${leftUser}@example.com`,
      bucketId,
      status: "left",
      source: "reconcile",
      entryCount: 1,
      enteredAt: new Date(Date.now() - 30 * DAY),
      leftAt: new Date(Date.now() - DAY),
    });

    // A re-joined member: NEW active row, fresh enteredAt (1 day ago), empty
    // dwellState → not yet aged past `after` (7 days).
    const reJoined = uid("rejoined-user");
    await seedContact(reJoined);
    await seedActiveMembership({ userId: reJoined, bucketId, ageMs: 1 * DAY });

    // Positive control: a continuously-active member aged past `after` MUST fire
    // in the SAME sweep — so the 0s below prove the gate working, not a dead pass.
    const dwelling = uid("dwelling-control");
    await seedContact(dwelling);
    await seedActiveMembership({ userId: dwelling, bucketId, ageMs: 10 * DAY });

    await runReconcile();

    expect(dwellPushCountForUser(bucketId, label, leftUser)).toBe(0);
    expect(dwellPushCountForUser(bucketId, label, reJoined)).toBe(0);
    expect(dwellPushCountForUser(bucketId, label, dwelling)).toBe(1);
  });
});

// ===========================================================================
// 19 — maxDwell interop (TTL-left before dwell ever fires)
// ===========================================================================

describe("dwell maxDwell interop (Test 19)", () => {
  it("a member past maxDwell is TTL-left earlier in the sweep, so dwell never fires", async () => {
    const bucketId = uid("maxdwell-interop");
    // maxDwell (1 day) < after (7 days): the TTL pass force-leaves the member
    // BEFORE the dwell pass runs in the same iteration. timeBased false, but
    // bucket.maxDwell makes the iteration reach the TTL pass + dwell pass.
    const bucket = defineBucket({
      meta: {
        id: bucketId,
        name: "MaxDwell vs dwell",
        enabled: true,
        maxDwell: days(1),
        criteria: (b) => b.prop("plan").eq("x"),
      },
    });
    bucket.on("dwell", { after: days(7) }, async () => {});
    const label = `after-${durationToMs(days(7))}`;

    createHogsendClient({ buckets: [bucket] });
    await settleBackfill(bucket);

    const m = uid("ttl-member");
    await seedContact(m);
    // enteredAt 10 days ago AND maxDwellAt already past → TTL leaves it.
    await db.insert(bucketMemberships).values({
      userId: m,
      userEmail: `${m}@example.com`,
      bucketId,
      status: "active",
      source: "reconcile",
      entryCount: 1,
      enteredAt: new Date(Date.now() - 10 * DAY),
      maxDwellAt: new Date(Date.now() - DAY),
      lastEvaluatedAt: new Date(Date.now() - DAY),
    });

    // Positive control: a member whose maxDwellAt is in the FUTURE is NOT
    // TTL-left, and aged past `after` (10 days) → it DOES dwell in the same
    // sweep. Proves the 0 below is maxDwell winning, not a dead dwell pass.
    const survivor = uid("survivor-member");
    await seedContact(survivor);
    await db.insert(bucketMemberships).values({
      userId: survivor,
      userEmail: `${survivor}@example.com`,
      bucketId,
      status: "active",
      source: "reconcile",
      entryCount: 1,
      enteredAt: new Date(Date.now() - 10 * DAY),
      maxDwellAt: new Date(Date.now() + DAY),
      lastEvaluatedAt: new Date(Date.now() - DAY),
    });

    await runReconcile();

    // The member was force-left (status 'left') before the dwell pass, so the
    // dwell scan's status='active' filter excluded it → no dwell push.
    expect(await activeRow(m, bucketId)).toBeUndefined();
    expect(dwellPushCountForUser(bucketId, label, m)).toBe(0);
    // The control survived the TTL pass and dwelled.
    expect(await activeRow(survivor, bucketId)).toBeDefined();
    expect(dwellPushCountForUser(bucketId, label, survivor)).toBe(1);
  });
});

// ===========================================================================
// 20 — every re-arms + coalescing (interval-ordinal dwellCount)
// ===========================================================================

describe("dwell every re-arms + coalescing (Test 20)", () => {
  it("fires on the first eligible sweep, re-arms after the interval, and coalesces a multi-interval gap to one fire", async () => {
    const bucketId = uid("every-rearm");
    const bucket = makeDwellBucket(bucketId);
    bucket.on("dwell", { every: hours(1) }, async () => {});
    const everyMs = durationToMs(hours(1));
    const label = `every-${everyMs}`;

    createHogsendClient({ buckets: [bucket] });
    await settleBackfill(bucket);

    const m = uid("every-member");
    await seedContact(m);
    // Anchor 2h ago (explicit, so I can advance it independently of enteredAt),
    // empty dwellState → first sweep fires; ordinal = floor(2h/1h) = 2.
    const rowId = await seedActiveMembership({
      userId: m,
      bucketId,
      ageMs: 2 * HOUR,
      dwellAnchorAt: new Date(Date.now() - 2 * HOUR),
    });

    await runReconcile();
    expect(dwellPushCountForUser(bucketId, label, m)).toBe(1);
    expect(
      lastDwellPushForUser(bucketId, label, m)?.properties?.dwellCount,
    ).toBe(2);

    // Set the last fire to 30m ago → next sweep is NOT yet due (30m < 1h).
    pushSpy.mockClear();
    await db
      .update(bucketMemberships)
      .set({
        dwellState: {
          [label]: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        },
      })
      .where(eq(bucketMemberships.id, rowId));
    await runReconcile();
    expect(dwellPushCountForUser(bucketId, label, m)).toBe(0);

    // Re-arm: anchor 3h ago + last fire 90m ago → due (90m >= 1h). The interval
    // ordinal is now floor(3h/1h) = 3, a DISTINCT idempotencyKey from the first
    // fire's ordinal 2, so the re-fire is NOT deduped at the userEvents layer.
    pushSpy.mockClear();
    await db
      .update(bucketMemberships)
      .set({
        dwellAnchorAt: new Date(Date.now() - 3 * HOUR),
        dwellState: {
          [label]: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
        },
      })
      .where(eq(bucketMemberships.id, rowId));
    await runReconcile();
    expect(dwellPushCountForUser(bucketId, label, m)).toBe(1);
    expect(
      lastDwellPushForUser(bucketId, label, m)?.properties?.dwellCount,
    ).toBe(3);
  });

  it("a multi-interval outage produces exactly ONE catch-up fire with the elapsed-period ordinal", async () => {
    const bucketId = uid("every-coalesce");
    const bucket = makeDwellBucket(bucketId);
    bucket.on("dwell", { every: hours(1) }, async () => {});
    const everyMs = durationToMs(hours(1));
    const label = `every-${everyMs}`;

    createHogsendClient({ buckets: [bucket] });
    await settleBackfill(bucket);

    const m = uid("coalesce-member");
    await seedContact(m);
    // Anchor 3h ago, never fired → ONE catch-up fire (coalescing) with
    // dwellCount = floor(3h/1h) = 3, NOT three fires.
    await seedActiveMembership({ userId: m, bucketId, ageMs: 3 * HOUR });

    await runReconcile();
    expect(dwellPushCountForUser(bucketId, label, m)).toBe(1);
    expect(
      lastDwellPushForUser(bucketId, label, m)?.properties?.dwellCount,
    ).toBe(3);
  });
});

// ===========================================================================
// 21 — first-deploy quiet window (criteriaHash null → skip dwell pass)
// ===========================================================================

describe("dwell first-deploy quiet window (Test 21)", () => {
  it("skips the dwell pass while the first-time backfill is incomplete (no criteriaHash)", async () => {
    const bucketId = uid("quiet-window");
    const bucket = makeDwellBucket(bucketId);
    bucket.on("dwell", { after: days(7) }, async () => {});
    const label = `after-${durationToMs(days(7))}`;

    createHogsendClient({ buckets: [bucket] });
    // Deliberately DO NOT settle the backfill (criteriaHash absent) → the dwell
    // pass reuses firstTimeBackfillIncomplete and returns 0.

    const m = uid("quiet-member");
    await seedContact(m);
    await seedActiveMembership({ userId: m, bucketId, ageMs: 10 * DAY });

    await runReconcile();

    expect(dwellPushCountForUser(bucketId, label, m)).toBe(0);

    // Positive control: once the backfill settles (criteriaHash present), the
    // SAME member fires — proving the 0 above was the quiet window, not a dead
    // pass.
    await settleBackfill(bucket);
    pushSpy.mockClear();
    await runReconcile();
    expect(dwellPushCountForUser(bucketId, label, m)).toBe(1);
  });
});

// ===========================================================================
// 22 — dwell-only bucket reaches the pass (widened-gate regression guard)
// ===========================================================================

describe("dwell-only bucket reaches the pass (Test 22)", () => {
  it("a bucket with no timeBased/maxDwell but a dwell reaction still fires the dwell pass", async () => {
    const bucketId = uid("dwell-only");
    // Pure property criterion → NOT time-based, NO maxDwell. Without the widened
    // early-continue (!hasDwell), the iteration would `continue` and never run
    // the dwell pass.
    const bucket = makeDwellBucket(bucketId);
    bucket.on("dwell", { after: days(7) }, async () => {});
    const label = `after-${durationToMs(days(7))}`;

    createHogsendClient({ buckets: [bucket] });
    await settleBackfill(bucket);

    const m = uid("dwell-only-member");
    await seedContact(m);
    await seedActiveMembership({ userId: m, bucketId, ageMs: 10 * DAY });

    await runReconcile();

    expect(dwellPushCountForUser(bucketId, label, m)).toBe(1);
  });
});

// ===========================================================================
// 22b — anchor honesty (dwellAnchorAt drives the clock; NULL → enteredAt)
// ===========================================================================

describe("dwell anchor honesty (Test 22b)", () => {
  it("a backfilled member with a historical dwellAnchorAt fires on the first eligible sweep", async () => {
    const bucketId = uid("anchor-historical");
    const bucket = makeDwellBucket(bucketId);
    bucket.on("dwell", { after: days(7) }, async () => {});
    const label = `after-${durationToMs(days(7))}`;

    createHogsendClient({ buckets: [bucket] });
    await settleBackfill(bucket);

    // enteredAt is the backfill instant (NOW), but dwellAnchorAt is a historical
    // instant 30 days ago → coalesce(anchor, enteredAt) is past `after`, so it
    // fires on the FIRST sweep (not 7 days after deploy).
    const m = uid("anchor-member");
    await seedContact(m);
    await seedActiveMembership({
      userId: m,
      bucketId,
      ageMs: 0, // enteredAt = now
      dwellAnchorAt: new Date(Date.now() - 30 * DAY),
    });

    await runReconcile();

    expect(dwellPushCountForUser(bucketId, label, m)).toBe(1);
  });

  it("a NULL dwellAnchorAt falls back to enteredAt (live join: clock starts at entry)", async () => {
    const bucketId = uid("anchor-null");
    const bucket = makeDwellBucket(bucketId);
    bucket.on("dwell", { after: days(7) }, async () => {});
    const label = `after-${durationToMs(days(7))}`;

    createHogsendClient({ buckets: [bucket] });
    await settleBackfill(bucket);

    // NULL anchor + enteredAt only 1 day ago → not yet aged past `after`.
    const recent = uid("anchor-null-recent");
    await seedContact(recent);
    await seedActiveMembership({
      userId: recent,
      bucketId,
      ageMs: 1 * DAY,
      dwellAnchorAt: null,
    });

    // NULL anchor + enteredAt 10 days ago → aged past `after` → fires.
    const old = uid("anchor-null-old");
    await seedContact(old);
    await seedActiveMembership({
      userId: old,
      bucketId,
      ageMs: 10 * DAY,
      dwellAnchorAt: null,
    });

    await runReconcile();

    expect(dwellPushCountForUser(bucketId, label, recent)).toBe(0);
    expect(dwellPushCountForUser(bucketId, label, old)).toBe(1);
  });
});
