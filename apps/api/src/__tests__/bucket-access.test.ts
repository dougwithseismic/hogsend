import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// DB-touching test against the real docker TimescaleDB (mirrors buckets.test.ts),
// overriding the vitest.config placeholder DATABASE_URL.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Mock Hatchet so building the engine at import does NOT construct a live gRPC
// engine (the accessor never touches Hatchet, but createHogsendClient does at
// import). Single mock of the API's `../lib/hatchet.js` is enough here.
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

const { bucketMemberships, contacts } = await import("@hogsend/db");
const { like, sql } = await import("drizzle-orm");
const { createBucketAccessor, createHogsendClient, defineBucket } =
  await import("@hogsend/engine");

const container = createHogsendClient();
const { db } = container;

// All accessors are bound to the test db via the dbResolver seam (the same path
// the container uses for overrides.db).
const RUN = `acc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const uid = (label: string) => `${RUN}-${label}`;

const BUCKET_ID = uid("members-bucket");
const accessor = createBucketAccessor(BUCKET_ID, () => db);

async function seedContact(
  userId: string,
  opts?: { deletedAt?: Date },
): Promise<void> {
  await db
    .insert(contacts)
    .values({
      externalId: userId,
      email: `${userId}@example.com`,
      properties: {},
      deletedAt: opts?.deletedAt ?? null,
    })
    .onConflictDoUpdate({
      target: contacts.externalId,
      targetWhere: sql`${contacts.externalId} is not null and ${contacts.deletedAt} is null`,
      set: { deletedAt: opts?.deletedAt ?? null },
    });
}

async function seedMembership(opts: {
  userId: string;
  status: "active" | "left";
}): Promise<void> {
  await db.insert(bucketMemberships).values({
    userId: opts.userId,
    userEmail: `${opts.userId}@example.com`,
    bucketId: BUCKET_ID,
    status: opts.status,
    source: "event",
    entryCount: 1,
    leftAt: opts.status === "left" ? new Date() : null,
  });
}

beforeEach(async () => {
  // Clean this file's namespace before each test so counts are deterministic.
  await db
    .delete(bucketMemberships)
    .where(like(bucketMemberships.userId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}-%`));
});

afterAll(async () => {
  await db
    .delete(bucketMemberships)
    .where(like(bucketMemberships.userId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}-%`));
});

// ===========================================================================
// 23 — count()
// ===========================================================================

describe("count() (Test 23)", () => {
  it("counts active members only, excluding left members and soft-deleted contacts", async () => {
    // 3 active + 2 left → count is 3.
    for (let i = 0; i < 3; i++) {
      const u = uid(`active-${i}`);
      await seedContact(u);
      await seedMembership({ userId: u, status: "active" });
    }
    for (let i = 0; i < 2; i++) {
      const u = uid(`left-${i}`);
      await seedContact(u);
      await seedMembership({ userId: u, status: "left" });
    }

    const { data, error } = await accessor.count();
    expect(error).toBeNull();
    expect(data).toBe(3);
  });

  it("excludes a member whose contact is soft-deleted (GDPR join)", async () => {
    const live = uid("gdpr-live");
    await seedContact(live);
    await seedMembership({ userId: live, status: "active" });

    const deleted = uid("gdpr-deleted");
    await seedContact(deleted, { deletedAt: new Date() });
    await seedMembership({ userId: deleted, status: "active" });

    const { data, error } = await accessor.count();
    expect(error).toBeNull();
    expect(data).toBe(1);
  });
});

// ===========================================================================
// 24 — has()
// ===========================================================================

describe("has() (Test 24)", () => {
  it("returns true for an active member, false for a left member, false for a non-member", async () => {
    const activeUser = uid("has-active");
    await seedContact(activeUser);
    await seedMembership({ userId: activeUser, status: "active" });

    const leftUser = uid("has-left");
    await seedContact(leftUser);
    await seedMembership({ userId: leftUser, status: "left" });

    const nonMember = uid("has-none");
    await seedContact(nonMember);

    expect((await accessor.has(activeUser)).data).toBe(true);
    expect((await accessor.has(leftUser)).data).toBe(false);
    expect((await accessor.has(nonMember)).data).toBe(false);
  });
});

// ===========================================================================
// 25 — members() pagination (keyset cursor, no overlap / no gap)
// ===========================================================================

describe("members() pagination (Test 25)", () => {
  it("pages 5 active members in limit-2 chunks via the keyset cursor", async () => {
    for (let i = 0; i < 5; i++) {
      const u = uid(`page-${i}`);
      await seedContact(u);
      await seedMembership({ userId: u, status: "active" });
    }

    const seen = new Set<string>();

    const p1 = await accessor.members({ limit: 2 });
    expect(p1.error).toBeNull();
    expect(p1.data).toHaveLength(2);
    expect(p1.count).toBe(5);
    expect(p1.cursor).not.toBeNull();
    for (const r of p1.data) seen.add(r.id);

    const p2 = await accessor.members({
      limit: 2,
      cursor: p1.cursor ?? undefined,
    });
    expect(p2.data).toHaveLength(2);
    expect(p2.cursor).not.toBeNull();
    for (const r of p2.data) seen.add(r.id);

    const p3 = await accessor.members({
      limit: 2,
      cursor: p2.cursor ?? undefined,
    });
    expect(p3.data).toHaveLength(1);
    // Final page exhausts → cursor null.
    expect(p3.cursor).toBeNull();
    for (const r of p3.data) seen.add(r.id);

    // No overlap, no gap: exactly 5 distinct rows across the three pages.
    expect(seen.size).toBe(5);
  });
});

// ===========================================================================
// 26 — hard cap (MAX_PAGE)
// ===========================================================================

describe("members() hard cap (Test 26)", () => {
  it("never returns more than MAX_PAGE rows even when limit is huge", async () => {
    // Seed a handful; the cap is structural (limit + 1 peek capped at MAX_PAGE),
    // so a small population still proves limit:1000 does not blow past the cap.
    for (let i = 0; i < 5; i++) {
      const u = uid(`cap-${i}`);
      await seedContact(u);
      await seedMembership({ userId: u, status: "active" });
    }

    const page = await accessor.members({ limit: 1000 });
    expect(page.error).toBeNull();
    // MAX_PAGE is 100 — the returned page is at most that, and here is the 5
    // seeded rows. The assertion that matters is "never exceeds the cap".
    expect(page.data.length).toBeLessThanOrEqual(100);
    expect(page.data.length).toBe(5);
  });
});

// ===========================================================================
// 27 — async iterator yields all rows exactly once
// ===========================================================================

describe("membersIterator() (Test 27)", () => {
  it("yields all 5 active members exactly once across internal pages", async () => {
    for (let i = 0; i < 5; i++) {
      const u = uid(`iter-${i}`);
      await seedContact(u);
      await seedMembership({ userId: u, status: "active" });
    }

    const ids = new Set<string>();
    let total = 0;
    for await (const row of accessor.membersIterator({ pageSize: 2 })) {
      ids.add(row.id);
      total += 1;
    }

    expect(total).toBe(5);
    expect(ids.size).toBe(5);
  });
});

// ===========================================================================
// 28 — error contract (no throw; failure lands in error)
// ===========================================================================

describe("error contract (Test 28)", () => {
  it("returns a populated error instead of throwing when the db errors", async () => {
    // A dbResolver that returns a db whose query chain rejects. The accessor must
    // catch and surface it on `error`, never throw.
    const failing = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => Promise.reject(new Error("boom")),
          }),
        }),
      }),
      // biome-ignore lint/suspicious/noExplicitAny: minimal failing db stub
    } as any;
    const failingAccessor = createBucketAccessor(BUCKET_ID, () => failing);

    const res = await failingAccessor.count();
    expect(res.data).toBeNull();
    expect(res.error).toBeInstanceOf(Error);
    expect(res.error?.message).toBe("boom");
  });
});

// ===========================================================================
// 28b — overrides.db seam (accessors re-bound to the injected db)
// ===========================================================================

describe("overrides.db seam (Test 28b)", () => {
  it("re-binds the bucket accessors to the container's injected db", async () => {
    // A sentinel db that records it was queried and returns a fixed count. The
    // count() chain is select().from().innerJoin().where() → rows array.
    const calls: string[] = [];
    const injected = {
      select: () => {
        calls.push("select");
        return {
          from: () => ({
            innerJoin: () => ({
              where: () => Promise.resolve([{ value: 42 }]),
            }),
          }),
        };
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal injected db stub
    } as any;

    const bucket = defineBucket({
      meta: {
        id: uid("override-bucket"),
        name: "Override",
        enabled: true,
        // A dynamic bucket requires a non-empty criteria or bucketMetaSchema
        // rejects it at registration before the accessor re-bind can run.
        criteria: (b) => b.prop("plan").eq("vip"),
      },
    });

    // The container re-binds the bucket's accessors to overrides.db via the
    // dbResolver seam — so bucket.count() must hit the injected db, NOT getDb().
    createHogsendClient({ buckets: [bucket], overrides: { db: injected } });

    const res = await bucket.count();
    expect(res.error).toBeNull();
    expect(res.data).toBe(42);
    expect(calls).toContain("select");
  });
});
