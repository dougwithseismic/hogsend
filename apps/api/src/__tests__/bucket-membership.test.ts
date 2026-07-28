import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// DB-touching test against the real docker TimescaleDB (mirrors
// bucket-backfill.test.ts), overriding the vitest.config placeholder
// DATABASE_URL.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Mock Hatchet so nothing constructs a live gRPC engine at import. `events.push`
// is a spy; the membership service emits through `emitBucketTransition` →
// `ingestEvent`, which writes `user_events` rows for real and pushes to this
// spy. Emission is therefore asserted on the persisted `user_events` rows (the
// authoritative record), with the spy as a secondary signal.
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
const { and, eq, inArray, sql } = await import("drizzle-orm");
const {
  addBucketMember,
  buildBucketRegistry,
  createHogsendClient,
  defineBucket,
  readPendingLeave,
  removeBucketMember,
  resetBucketRegistry,
  seedBucketMembers,
  setBucketRegistry,
} = await import("@hogsend/engine");

const container = createHogsendClient();
const { db, registry, hatchet, logger } = container;

/** The explicit-dependency bundle every call passes (AC 11 — no container). */
const deps = { db, registry, hatchet, logger };

const RUN = `bm-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const uid = (label: string) => `${RUN}-${label}`;

// ---------------------------------------------------------------------------
// Test buckets — all manual except the dynamic one used for the reject guard.
// ---------------------------------------------------------------------------

const PLAIN_ID = `${RUN}-plain`;
const plainBucket = defineBucket({
  meta: { id: PLAIN_ID, name: "Plain manual", enabled: true, kind: "manual" },
});

const TTL_ID = `${RUN}-ttl`;
const ttlBucket = defineBucket({
  meta: {
    id: TTL_ID,
    name: "Manual with maxDwell",
    enabled: true,
    kind: "manual",
    maxDwell: { hours: 48 },
  },
});

const ONCE_ID = `${RUN}-once`;
const onceBucket = defineBucket({
  meta: {
    id: ONCE_ID,
    name: "Manual, entryLimit once",
    enabled: true,
    kind: "manual",
    entryLimit: "once",
  },
});

const DWELL_ID = `${RUN}-mindwell`;
const MIN_DWELL_HOURS = 6;
const minDwellBucket = defineBucket({
  meta: {
    id: DWELL_ID,
    name: "Manual with minDwell",
    enabled: true,
    kind: "manual",
    minDwell: { hours: MIN_DWELL_HOURS },
  },
});

const DYNAMIC_ID = `${RUN}-dynamic`;
const DYNAMIC_EVENT = `${RUN}:dyn.action`;
const dynamicBucket = defineBucket({
  meta: {
    id: DYNAMIC_ID,
    name: "Dynamic",
    enabled: true,
    criteria: (b) => b.event(DYNAMIC_EVENT).atLeast(1),
  },
});

const DISABLED_ID = `${RUN}-disabled`;
const disabledBucket = defineBucket({
  meta: {
    id: DISABLED_ID,
    name: "Disabled manual",
    enabled: false,
    kind: "manual",
  },
});

const TEST_BUCKETS = [
  plainBucket,
  ttlBucket,
  onceBucket,
  minDwellBucket,
  dynamicBucket,
  disabledBucket,
];
const ALL_BUCKET_IDS = [
  PLAIN_ID,
  TTL_ID,
  ONCE_ID,
  DWELL_ID,
  DYNAMIC_ID,
  DISABLED_ID,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedContact(
  userId: string,
  opts?: { email?: string | null; anonymousOnly?: boolean },
): Promise<void> {
  await db.insert(contacts).values({
    externalId: opts?.anonymousOnly ? null : userId,
    anonymousId: opts?.anonymousOnly ? userId : null,
    email: opts?.email === undefined ? `${userId}@example.com` : opts.email,
    properties: {},
  });
}

async function rows(userId: string, bucketId: string) {
  return db.query.bucketMemberships.findMany({
    where: and(
      eq(bucketMemberships.userId, userId),
      eq(bucketMemberships.bucketId, bucketId),
    ),
    orderBy: (m, { asc }) => [asc(m.entryCount), asc(m.id)],
  });
}

async function activeRow(userId: string, bucketId: string) {
  const all = await rows(userId, bucketId);
  return all.filter((r) => r.status === "active");
}

/**
 * The persisted `bucket:<kind>:<bucketId>` transitions for ONE user. Scoped per
 * user because several tests share a bucket id — an unscoped count would depend
 * on test order.
 */
async function transitionEvents(
  bucketId: string,
  kind: "entered" | "left",
  userId: string,
): Promise<Array<Record<string, unknown>>> {
  const found = await db.query.userEvents.findMany({
    where: and(
      eq(userEvents.event, `bucket:${kind}:${bucketId}`),
      eq(userEvents.userId, userId),
    ),
  });
  return found.map((r) => (r.properties ?? {}) as Record<string, unknown>);
}

/** The Hatchet push envelope for ONE user's `bucket:<kind>:<id>` transition. */
function transitionPush(
  bucketId: string,
  kind: "entered" | "left",
  userId: string,
): { userId?: string; userEmail?: string } | undefined {
  const match = pushSpy.mock.calls.find(
    (c) =>
      c[0] === `bucket:${kind}:${bucketId}` &&
      (c[1] as { userId?: string } | undefined)?.userId === userId,
  );
  return match?.[1] as { userId?: string; userEmail?: string } | undefined;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  pushSpy.mockClear();
  setBucketRegistry(buildBucketRegistry(TEST_BUCKETS, "*"));
});

afterAll(async () => {
  resetBucketRegistry();
  await db
    .delete(bucketMemberships)
    .where(inArray(bucketMemberships.bucketId, ALL_BUCKET_IDS));
  await db
    .delete(userEvents)
    .where(sql`${userEvents.userId} like ${`${RUN}-%`}`);
  await db
    .delete(contacts)
    .where(sql`${contacts.externalId} like ${`${RUN}-%`}`);
  await db
    .delete(contacts)
    .where(sql`${contacts.anonymousId} like ${`${RUN}-%`}`);
});

// ---------------------------------------------------------------------------
// AC 3 / AC 10 — add writes the row and emits
// ---------------------------------------------------------------------------

describe("addBucketMember", () => {
  it("writes an active row, stamps maxDwellAt, and emits bucket:entered", async () => {
    const userId = uid("add-1");
    await seedContact(userId);

    const before = Date.now();
    const result = await addBucketMember({
      ...deps,
      bucketId: TTL_ID,
      userId,
    });
    const after = Date.now();

    expect(result).toEqual({ emitted: true, epoch: 1, verdict: "applied" });

    const all = await rows(userId, TTL_ID);
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe("active");
    expect(all[0]?.entryCount).toBe(1);
    expect(all[0]?.source).toBe("manual");
    expect(all[0]?.userEmail).toBe(`${userId}@example.com`);
    // maxDwell 48h is stamped once at join, so the TTL sweep (which filters
    // isNotNull(maxDwellAt)) can force-leave the member (AC 6's precondition).
    const maxDwellAt = all[0]?.maxDwellAt?.getTime() ?? 0;
    expect(maxDwellAt).toBeGreaterThanOrEqual(before + 48 * 3_600_000 - 5_000);
    expect(maxDwellAt).toBeLessThanOrEqual(after + 48 * 3_600_000 + 5_000);

    const entered = await transitionEvents(TTL_ID, "entered", userId);
    expect(entered).toHaveLength(1);
    expect(entered[0]?.userId).toBe(userId);
    expect(entered[0]?.entryCount).toBe(1);
    expect(entered[0]?.source).toBe("manual");
  });

  // AC 5 — idempotent re-add.
  it("is idempotent for an already-active member: no row, no emission", async () => {
    const userId = uid("add-2");
    await seedContact(userId);

    const first = await addBucketMember({
      ...deps,
      bucketId: PLAIN_ID,
      userId,
    });
    expect(first.verdict).toBe("applied");

    const second = await addBucketMember({
      ...deps,
      bucketId: PLAIN_ID,
      userId,
    });
    expect(second).toEqual({
      emitted: false,
      epoch: 1,
      verdict: "already-active",
    });

    expect(await rows(userId, PLAIN_ID)).toHaveLength(1);
    expect(await transitionEvents(PLAIN_ID, "entered", userId)).toHaveLength(1);
  });

  // The epoch advances across a full leave/re-join cycle (countPriorMemberships
  // is status-agnostic, so the second join is epoch 2).
  it("advances the epoch on re-entry after a leave", async () => {
    const userId = uid("add-3");
    await seedContact(userId);

    await addBucketMember({ ...deps, bucketId: PLAIN_ID, userId });
    await removeBucketMember({ ...deps, bucketId: PLAIN_ID, userId });
    const rejoin = await addBucketMember({
      ...deps,
      bucketId: PLAIN_ID,
      userId,
    });

    expect(rejoin).toEqual({ emitted: true, epoch: 2, verdict: "applied" });
    const all = await rows(userId, PLAIN_ID);
    expect(all.map((r) => [r.entryCount, r.status])).toEqual([
      [1, "left"],
      [2, "active"],
    ]);
  });

  // AC 3 (the entryLimit half) / AC 10.
  it("writes the row but suppresses the emit under entryLimit:once", async () => {
    const userId = uid("add-4");
    await seedContact(userId);

    await addBucketMember({ ...deps, bucketId: ONCE_ID, userId });
    await removeBucketMember({ ...deps, bucketId: ONCE_ID, userId });
    const rejoin = await addBucketMember({
      ...deps,
      bucketId: ONCE_ID,
      userId,
    });

    expect(rejoin).toEqual({
      emitted: false,
      epoch: 2,
      verdict: "suppressed-by-entry-limit",
    });
    // The active row IS written (Studio size must reflect reality); only the
    // emission is gated.
    const active = await activeRow(userId, ONCE_ID);
    expect(active).toHaveLength(1);
    expect(active[0]?.entryCount).toBe(2);
    // Still exactly ONE bucket:entered from the first join.
    expect(await transitionEvents(ONCE_ID, "entered", userId)).toHaveLength(1);
  });

  // AC 12 (single-member form) — emit:false writes without emitting.
  it("emit:false writes the row and emits nothing (verdict seeded)", async () => {
    const userId = uid("add-5");
    await seedContact(userId);

    const result = await addBucketMember({
      ...deps,
      bucketId: PLAIN_ID,
      userId,
      emit: false,
    });

    expect(result).toEqual({ emitted: false, epoch: 1, verdict: "seeded" });
    expect(await activeRow(userId, PLAIN_ID)).toHaveLength(1);
    expect(await transitionEvents(PLAIN_ID, "entered", userId)).toHaveLength(0);
  });

  // Issue #608 — the contact provenance pin. An anonymous-only contact's
  // canonical key is its anonymous_id; re-ingesting a bare userId mints a
  // phantom external_id twin unless the service resolves and pins the contact.
  it("pins an anonymous-only contact instead of minting an external_id twin", async () => {
    const userId = uid("add-6");
    await seedContact(userId, { anonymousOnly: true, email: null });

    await addBucketMember({ ...deps, bucketId: PLAIN_ID, userId });

    const twins = await db.query.contacts.findMany({
      where: eq(contacts.externalId, userId),
    });
    expect(twins).toHaveLength(0);
    const live = await db.query.contacts.findMany({
      where: eq(contacts.anonymousId, userId),
    });
    expect(live).toHaveLength(1);
  });

  // Non-manual buckets: criteria own that membership.
  it("refuses to mutate a dynamic bucket", async () => {
    const userId = uid("add-7");
    await seedContact(userId);

    await expect(
      addBucketMember({ ...deps, bucketId: DYNAMIC_ID, userId }),
    ).rejects.toMatchObject({ code: "bucket_not_manual" });
    expect(await rows(userId, DYNAMIC_ID)).toHaveLength(0);
  });

  // `enabled: false` is the operator's kill switch. Every other membership
  // writer iterates getEnabled(), so a write accepted here would emit
  // `bucket:entered:<id>` into live journeys from a bucket that is switched off.
  it("refuses a disabled manual bucket", async () => {
    const userId = uid("add-disabled");
    await seedContact(userId);

    await expect(
      addBucketMember({ ...deps, bucketId: DISABLED_ID, userId }),
    ).rejects.toMatchObject({ code: "bucket_disabled" });
    expect(await rows(userId, DISABLED_ID)).toHaveLength(0);
  });

  it("refuses an unregistered bucket", async () => {
    await expect(
      addBucketMember({ ...deps, bucketId: `${RUN}-nope`, userId: uid("x") }),
    ).rejects.toMatchObject({ code: "bucket_not_found" });
  });
});

// ---------------------------------------------------------------------------
// AC 4 / AC 7 — remove
// ---------------------------------------------------------------------------

describe("removeBucketMember", () => {
  it("flips the row to left and emits bucket:left", async () => {
    const userId = uid("rm-1");
    await seedContact(userId);
    await addBucketMember({ ...deps, bucketId: PLAIN_ID, userId });

    const result = await removeBucketMember({
      ...deps,
      bucketId: PLAIN_ID,
      userId,
    });

    expect(result).toEqual({ emitted: true, epoch: 1, verdict: "applied" });
    const all = await rows(userId, PLAIN_ID);
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe("left");
    expect(all[0]?.leftAt).toBeInstanceOf(Date);

    const left = await transitionEvents(PLAIN_ID, "left", userId);
    expect(left).toHaveLength(1);
    expect(left[0]?.userId).toBe(userId);
    expect(left[0]?.reason).toBe("manual");
  });

  it("is a no-op for a non-member", async () => {
    const userId = uid("rm-2");
    await seedContact(userId);

    const result = await removeBucketMember({
      ...deps,
      bucketId: PLAIN_ID,
      userId,
    });

    expect(result).toEqual({
      emitted: false,
      epoch: 0,
      verdict: "already-left",
    });
    expect(await transitionEvents(PLAIN_ID, "left", userId)).toHaveLength(0);
  });

  it("is idempotent: a second remove reports already-left with the last epoch", async () => {
    const userId = uid("rm-3");
    await seedContact(userId);
    await addBucketMember({ ...deps, bucketId: PLAIN_ID, userId });
    await removeBucketMember({ ...deps, bucketId: PLAIN_ID, userId });

    const second = await removeBucketMember({
      ...deps,
      bucketId: PLAIN_ID,
      userId,
    });

    expect(second).toEqual({
      emitted: false,
      epoch: 1,
      verdict: "already-left",
    });
    expect(await transitionEvents(PLAIN_ID, "left", userId)).toHaveLength(1);
  });

  // AC 7 — minDwell DEFERS, never drops.
  it("defers a leave inside minDwell: row stays active, deadline armed", async () => {
    const userId = uid("rm-4");
    await seedContact(userId);
    await addBucketMember({ ...deps, bucketId: DWELL_ID, userId });

    const result = await removeBucketMember({
      ...deps,
      bucketId: DWELL_ID,
      userId,
    });

    expect(result).toEqual({ emitted: false, epoch: 1, verdict: "deferred" });
    const all = await rows(userId, DWELL_ID);
    expect(all).toHaveLength(1);
    // NOT dropped: the row is still active and carries the deferred-leave
    // deadline the reconcile cron resolves (enteredAt + minDwell).
    expect(all[0]?.status).toBe("active");
    const expected =
      (all[0]?.enteredAt.getTime() ?? 0) + MIN_DWELL_HOURS * 3_600_000;
    expect(all[0]?.expiresAt?.getTime()).toBe(expected);
    expect(await transitionEvents(DWELL_ID, "left", userId)).toHaveLength(0);
  });

  it("leaves normally once the minDwell window has elapsed", async () => {
    const userId = uid("rm-5");
    await seedContact(userId);
    await addBucketMember({ ...deps, bucketId: DWELL_ID, userId });
    // Backdate the join past the minDwell window.
    await db
      .update(bucketMemberships)
      .set({
        enteredAt: new Date(Date.now() - (MIN_DWELL_HOURS + 1) * 3_600_000),
      })
      .where(
        and(
          eq(bucketMemberships.userId, userId),
          eq(bucketMemberships.bucketId, DWELL_ID),
        ),
      );

    const result = await removeBucketMember({
      ...deps,
      bucketId: DWELL_ID,
      userId,
    });

    expect(result).toEqual({ emitted: true, epoch: 1, verdict: "applied" });
    expect((await rows(userId, DWELL_ID))[0]?.status).toBe("left");
    expect(await transitionEvents(DWELL_ID, "left", userId)).toHaveLength(1);
  });

  it("refuses to mutate a dynamic bucket", async () => {
    await expect(
      removeBucketMember({
        ...deps,
        bucketId: DYNAMIC_ID,
        userId: uid("rm-6"),
      }),
    ).rejects.toMatchObject({ code: "bucket_not_manual" });
  });

  // AC 7 — a deferral must be a recorded PENDING INTENT, not a bare timestamp.
  // `expiresAt` alone cannot say "somebody asked for this leave" (on a dynamic
  // bucket it is the criteria-window epoch) and cannot carry `emit`.
  it("records the deferred leave as a pending intent carrying emit", async () => {
    const userId = uid("rm-7");
    await seedContact(userId);
    await addBucketMember({ ...deps, bucketId: DWELL_ID, userId });

    const result = await removeBucketMember({
      ...deps,
      bucketId: DWELL_ID,
      userId,
    });

    expect(result).toEqual({ emitted: false, epoch: 1, verdict: "deferred" });
    const row = (await rows(userId, DWELL_ID))[0];
    expect(readPendingLeave(row?.context)).toEqual({
      deferUntil: row?.expiresAt?.toISOString(),
      emit: true,
    });
  });

  // The seed contract (DECISIONS §2.7a): `emit: false` must survive the
  // deferral, otherwise the reconcile pass emits a transition the caller
  // explicitly suppressed.
  it("carries emit:false onto the pending leave when the leave is deferred", async () => {
    const userId = uid("rm-8");
    await seedContact(userId);
    await addBucketMember({ ...deps, bucketId: DWELL_ID, userId });

    const result = await removeBucketMember({
      ...deps,
      bucketId: DWELL_ID,
      userId,
      emit: false,
    });

    expect(result).toEqual({ emitted: false, epoch: 1, verdict: "deferred" });
    const row = (await rows(userId, DWELL_ID))[0];
    expect(readPendingLeave(row?.context)).toEqual({
      deferUntil: row?.expiresAt?.toISOString(),
      emit: false,
    });
  });

  // A re-add inside the window cancels the pending leave. Without this the
  // member is a CURRENT member carrying a live leave deadline, and the
  // reconcile pass force-leaves them (see bucket-reconcile-manual.test.ts for
  // the sweep half of this).
  it("a re-add disarms the pending deferred leave", async () => {
    const userId = uid("rm-9");
    await seedContact(userId);
    await addBucketMember({ ...deps, bucketId: DWELL_ID, userId });
    await removeBucketMember({ ...deps, bucketId: DWELL_ID, userId });

    const readd = await addBucketMember({
      ...deps,
      bucketId: DWELL_ID,
      userId,
    });

    expect(readd).toEqual({
      emitted: false,
      epoch: 1,
      verdict: "already-active",
    });
    const all = await rows(userId, DWELL_ID);
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe("active");
    expect(all[0]?.expiresAt).toBeNull();
    expect(readPendingLeave(all[0]?.context)).toBeNull();
    expect(await transitionEvents(DWELL_ID, "left", userId)).toHaveLength(0);
  });

  // A suppressed LEAVE gets its own verdict — `seeded` is the suppressed JOIN,
  // and PRD 02's poller must tell the two apart from the return value alone.
  it("emit:false on an immediate leave returns leave-seeded, not seeded", async () => {
    const userId = uid("rm-10");
    await seedContact(userId);
    await addBucketMember({ ...deps, bucketId: PLAIN_ID, userId });

    const result = await removeBucketMember({
      ...deps,
      bucketId: PLAIN_ID,
      userId,
      emit: false,
    });

    expect(result).toEqual({
      emitted: false,
      epoch: 1,
      verdict: "leave-seeded",
    });
    expect((await rows(userId, PLAIN_ID))[0]?.status).toBe("left");
    expect(await transitionEvents(PLAIN_ID, "left", userId)).toHaveLength(0);
  });

  // Explicit `userEmail: null` means "emit with no email" and must survive, the
  // same way it does on the add path. `?? active.userEmail` silently swapped in
  // the stored row email instead.
  it("honours an explicit userEmail:null instead of the stored row email", async () => {
    const userId = uid("rm-11");
    await seedContact(userId);
    await addBucketMember({ ...deps, bucketId: PLAIN_ID, userId });
    pushSpy.mockClear();

    await removeBucketMember({
      ...deps,
      bucketId: PLAIN_ID,
      userId,
      userEmail: null,
    });

    expect(transitionPush(PLAIN_ID, "left", userId)).toMatchObject({
      userEmail: "",
    });
  });

  // `activeMembership`'s `deleted_at IS NULL` half. The CAS keys on id+status
  // only (the partial-unique index already guarantees one LIVE active row), so
  // without this filter an erased membership is flipped and emitted.
  it("never resurrects a soft-deleted active row", async () => {
    const userId = uid("rm-12");
    await seedContact(userId);
    await db.insert(bucketMemberships).values({
      userId,
      userEmail: `${userId}@example.com`,
      bucketId: PLAIN_ID,
      status: "active",
      source: "manual",
      entryCount: 1,
      deletedAt: new Date(),
    });

    const result = await removeBucketMember({
      ...deps,
      bucketId: PLAIN_ID,
      userId,
    });

    expect(result).toEqual({
      emitted: false,
      epoch: 1,
      verdict: "already-left",
    });
    const all = await rows(userId, PLAIN_ID);
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe("active");
    expect(all[0]?.leftAt).toBeNull();
    expect(await transitionEvents(PLAIN_ID, "left", userId)).toHaveLength(0);
  });

  // `activeMembership`'s `status = 'active'` half. Without it a `left` row is
  // taken for the active membership: the stale epoch is reported AND (on a
  // minDwell bucket) a pending leave is armed on a membership that ended.
  it("never treats a left row as the active membership", async () => {
    const userId = uid("rm-13");
    await seedContact(userId);
    await db.insert(bucketMemberships).values({
      userId,
      userEmail: `${userId}@example.com`,
      bucketId: DWELL_ID,
      status: "left",
      source: "manual",
      // Deliberately NOT the prior-membership count, so the reported epoch
      // distinguishes "counted the history" from "read this row".
      entryCount: 4,
      leftAt: new Date(),
    });

    const result = await removeBucketMember({
      ...deps,
      bucketId: DWELL_ID,
      userId,
    });

    expect(result).toEqual({
      emitted: false,
      epoch: 1,
      verdict: "already-left",
    });
    const all = await rows(userId, DWELL_ID);
    expect(all).toHaveLength(1);
    expect(all[0]?.expiresAt).toBeNull();
    expect(readPendingLeave(all[0]?.context)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC 12 — the bulk/seed path: rows with correct epoch + maxDwellAt, NO emission
// ---------------------------------------------------------------------------

describe("seedBucketMembers", () => {
  it("writes rows with epoch and maxDwellAt and emits nothing", async () => {
    const ids = [uid("seed-a"), uid("seed-b"), uid("seed-c")];
    for (const id of ids) await seedContact(id);

    const before = Date.now();
    const result = await seedBucketMembers({
      db,
      logger,
      bucketId: TTL_ID,
      members: ids.map((userId) => ({ userId })),
    });
    const after = Date.now();

    expect(result).toEqual({
      seeded: 3,
      alreadyActive: 0,
      skippedNoContact: 0,
    });

    for (const id of ids) {
      const all = await rows(id, TTL_ID);
      expect(all).toHaveLength(1);
      expect(all[0]?.status).toBe("active");
      expect(all[0]?.entryCount).toBe(1);
      expect(all[0]?.source).toBe("seed");
      // Email backfilled from the contacts row.
      expect(all[0]?.userEmail).toBe(`${id}@example.com`);
      const maxDwellAt = all[0]?.maxDwellAt?.getTime() ?? 0;
      expect(maxDwellAt).toBeGreaterThanOrEqual(
        before + 48 * 3_600_000 - 5_000,
      );
      expect(maxDwellAt).toBeLessThanOrEqual(after + 48 * 3_600_000 + 5_000);
    }

    // The Customer.io rule: seeding an existing population must NOT fire
    // bucket:entered into live journeys.
    for (const id of ids) {
      expect(await transitionEvents(TTL_ID, "entered", id)).toEqual([]);
    }
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("is idempotent against already-active members", async () => {
    const existing = uid("seed-d");
    const fresh = uid("seed-e");
    await seedContact(existing);
    await seedContact(fresh);
    await addBucketMember({ ...deps, bucketId: PLAIN_ID, userId: existing });

    const result = await seedBucketMembers({
      db,
      logger,
      bucketId: PLAIN_ID,
      members: [{ userId: existing }, { userId: fresh }],
    });

    expect(result).toEqual({
      seeded: 1,
      alreadyActive: 1,
      skippedNoContact: 0,
    });
    expect(await rows(existing, PLAIN_ID)).toHaveLength(1);
    expect(await rows(fresh, PLAIN_ID)).toHaveLength(1);
  });

  it("advances the epoch for a member with prior left rows", async () => {
    const userId = uid("seed-f");
    await seedContact(userId);
    await addBucketMember({ ...deps, bucketId: PLAIN_ID, userId });
    await removeBucketMember({ ...deps, bucketId: PLAIN_ID, userId });

    const result = await seedBucketMembers({
      db,
      logger,
      bucketId: PLAIN_ID,
      members: [{ userId }],
    });

    expect(result).toEqual({
      seeded: 1,
      alreadyActive: 0,
      skippedNoContact: 0,
    });
    const all = await rows(userId, PLAIN_ID);
    expect(all.map((r) => [r.entryCount, r.status])).toEqual([
      [1, "left"],
      [2, "active"],
    ]);
  });

  it("chunks a batch larger than batchSize without losing rows or emitting", async () => {
    const ids = Array.from({ length: 5 }, (_, i) => uid(`seed-chunk-${i}`));
    for (const id of ids) await seedContact(id);

    const result = await seedBucketMembers({
      db,
      logger,
      bucketId: PLAIN_ID,
      members: ids.map((userId) => ({ userId })),
      batchSize: 2,
    });

    expect(result).toEqual({
      seeded: 5,
      alreadyActive: 0,
      skippedNoContact: 0,
    });
    const all = await db.query.bucketMemberships.findMany({
      where: and(
        eq(bucketMemberships.bucketId, PLAIN_ID),
        inArray(bucketMemberships.userId, ids),
      ),
    });
    expect(all.map((r) => r.userId).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      expect(await transitionEvents(PLAIN_ID, "entered", id)).toEqual([]);
    }
  });

  // -------------------------------------------------------------------------
  // The live-contact gate. Every sweep that could ever move a member OUT of a
  // bucket (criteria leave, maxDwell TTL, pending-leave) selects through
  // `liveContactByCanonicalKey`, so a row seeded for a key no live contact owns
  // is invisible to all of them: it stays `active` forever, inflating bucket
  // size and membership stats with a member that has no path out.
  // -------------------------------------------------------------------------

  it("drops a member whose contact is soft-deleted, and reports the drop", async () => {
    const erased = uid("seed-erased");
    await seedContact(erased);
    // A merge loser / erased contact RETAINS its identity keys, so its
    // canonical key still resolves — only `deleted_at` marks it dead.
    await db
      .update(contacts)
      .set({ deletedAt: new Date() })
      .where(eq(contacts.externalId, erased));

    const result = await seedBucketMembers({
      db,
      logger,
      bucketId: PLAIN_ID,
      members: [{ userId: erased }],
    });

    expect(result).toEqual({
      seeded: 0,
      alreadyActive: 0,
      skippedNoContact: 1,
    });
    // No row AT ALL — not an inserted-then-unreachable one. Asserted on the
    // full row set (`rows`, both statuses) so an active row cannot hide behind
    // a status filter.
    expect(await rows(erased, PLAIN_ID)).toEqual([]);
  });

  // The caller-supplied email is the one input that could plausibly be read as
  // "I already know this member, skip the contact read" — it must not.
  it("does not let a caller-supplied email bypass the live-contact gate", async () => {
    const erased = uid("seed-erased-email");
    await seedContact(erased);
    await db
      .update(contacts)
      .set({ deletedAt: new Date() })
      .where(eq(contacts.externalId, erased));

    const result = await seedBucketMembers({
      db,
      logger,
      bucketId: PLAIN_ID,
      members: [{ userId: erased, userEmail: "supplied@example.com" }],
    });

    expect(result).toEqual({
      seeded: 0,
      alreadyActive: 0,
      skippedNoContact: 1,
    });
    expect(await rows(erased, PLAIN_ID)).toEqual([]);
  });

  // The gate keys on the CANONICAL key (external_id ?? anonymous_id ?? id), not
  // `external_id` — narrowing it would silently make every anonymous-only
  // contact unseedable, which is the failure mode that has already bitten three
  // reconcile passes.
  it("still seeds an anonymous-only contact", async () => {
    const anon = uid("seed-anon-only");
    await seedContact(anon, { anonymousOnly: true });

    const result = await seedBucketMembers({
      db,
      logger,
      bucketId: PLAIN_ID,
      members: [{ userId: anon }],
    });

    expect(result).toEqual({
      seeded: 1,
      alreadyActive: 0,
      skippedNoContact: 0,
    });
    expect(await activeRow(anon, PLAIN_ID)).toHaveLength(1);
  });

  // The counters must partition the deduped input: a caller that seeds nothing
  // has to be able to tell "everyone was already a member" from "every id was
  // dead". `batchSize: 2` splits the drops across chunks (the second chunk is
  // ALL-dead, so the empty-chunk short-circuit is exercised too).
  it("partitions a mixed batch into seeded / alreadyActive / skipped", async () => {
    const live = uid("seed-mixed-live");
    const active = uid("seed-mixed-active");
    const erased = uid("seed-mixed-erased");
    const neverExisted = uid("seed-mixed-missing");
    await seedContact(live);
    await seedContact(active);
    await seedContact(erased);
    await addBucketMember({ ...deps, bucketId: PLAIN_ID, userId: active });
    await db
      .update(contacts)
      .set({ deletedAt: new Date() })
      .where(eq(contacts.externalId, erased));

    const members = [live, active, erased, neverExisted];
    const result = await seedBucketMembers({
      db,
      logger,
      bucketId: PLAIN_ID,
      members: members.map((userId) => ({ userId })),
      batchSize: 2,
    });

    expect(result).toEqual({
      seeded: 1,
      alreadyActive: 1,
      skippedNoContact: 2,
    });
    expect(result.seeded + result.alreadyActive + result.skippedNoContact).toBe(
      members.length,
    );
    expect(await activeRow(live, PLAIN_ID)).toHaveLength(1);
    expect(await activeRow(active, PLAIN_ID)).toHaveLength(1);
    expect(await rows(erased, PLAIN_ID)).toEqual([]);
    expect(await rows(neverExisted, PLAIN_ID)).toEqual([]);
  });

  it("refuses to seed a dynamic bucket", async () => {
    await expect(
      seedBucketMembers({
        db,
        logger,
        bucketId: DYNAMIC_ID,
        members: [{ userId: uid("seed-g") }],
      }),
    ).rejects.toMatchObject({ code: "bucket_not_manual" });
  });
});

// ---------------------------------------------------------------------------
// AC 11 — callable from a workflow task with NO request container
// ---------------------------------------------------------------------------

describe("workflow-task call shape (no request container)", () => {
  it("behaves identically when deps are self-bootstrapped from process.env", async () => {
    const { createDatabase } = await import("@hogsend/db");
    const { createLogger, getJourneyRegistrySingleton } = await import(
      "@hogsend/engine"
    );

    // Exactly the bootstrap `bucketReconcileTask` performs — db + logger from
    // process.env, the journey registry from the process singleton. No
    // container, no request, nothing resolved from a Hono context. `hatchet` is
    // the engine's process-level client singleton (the same object the
    // reconcile task imports; the container merely re-exposes it).
    const { db: taskDb } = createDatabase({
      url: process.env.DATABASE_URL ?? "",
    });
    const taskLogger = createLogger("error");
    const taskRegistry = getJourneyRegistrySingleton();
    const taskHatchet = hatchet;

    const userId = uid("task-1");
    await seedContact(userId);

    const added = await addBucketMember({
      db: taskDb,
      registry: taskRegistry,
      hatchet: taskHatchet,
      logger: taskLogger,
      bucketId: PLAIN_ID,
      userId,
    });
    expect(added).toEqual({ emitted: true, epoch: 1, verdict: "applied" });

    const removed = await removeBucketMember({
      db: taskDb,
      registry: taskRegistry,
      hatchet: taskHatchet,
      logger: taskLogger,
      bucketId: PLAIN_ID,
      userId,
    });
    expect(removed).toEqual({ emitted: true, epoch: 1, verdict: "applied" });

    const all = await rows(userId, PLAIN_ID);
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe("left");
  });
});
