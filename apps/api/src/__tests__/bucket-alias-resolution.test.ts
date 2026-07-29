/**
 * PRD 07 T7 — the bucket subsystem resolves a PRESENTED key through the
 * alias-aware primitive (`lookupContactIdByKey`), not through a
 * `coalesce(external_id, anonymous_id, id) = :key` column probe.
 *
 * The column probe is blind in exactly one place, and it is the place that
 * matters: a merged loser's key. After a merge the loser row is SOFT-DELETED
 * and its key survives only as a `contact_aliases` row pointing at the
 * survivor — so the coalesce probe matches nothing, and every bucket read that
 * used it silently took its miss arm for a key the survivor still owns:
 *
 *   - `bucket.has(staleKey)`        → "not a member" for a member;
 *   - real-time criteria eval       → properties read as `{}`, so every
 *                                     property leg answers "absent";
 *   - the admin members filter      → falls back to the string arm and shows
 *                                     only the fragment literally keyed on it;
 *   - the fast-expiry re-confirm    → evaluates against `{}` and EXPIRES a
 *                                     member who still qualifies.
 *
 * Each test below drives ONE of the four flipped sites with a real merge
 * (`mergedPair`, the idiom from `identity-guard-aliases.test.ts`) and asserts
 * the survivor's answer. Every one of them fails on the pre-flip probe: the
 * stale key is owned by NO live contact, so nothing but the identity table can
 * produce these results.
 *
 * Fixture law (bucket-flip-reads.test.ts): every identity value is
 * run-namespaced, nothing is asserted against a whole-table count, and each
 * bucket carries its OWN property name so a property-indexed candidate lookup
 * in one test can never narrow to another test's bucket.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

// DB-touching test. The DEFAULT below is the repo-wide one every file in this
// directory shares, and it is what CI's service container listens on. Point a
// worktree at its own stack by exporting HOGSEND_TEST_DATABASE_URL — never by
// editing the default.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Dual, config-PRESERVING hatchet mock: `bucketExpiryTask` is BUILT at import
// time against the ENGINE's own `lib/hatchet`, so spreading `...config` keeps
// `.fn` (the real task body) invokable without a live gRPC engine.
const hatchetMock = () => ({
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
    events: { push: vi.fn(async () => {}) },
    runs: { cancel: vi.fn(async () => {}), get: vi.fn() },
    worker: vi.fn(),
  },
});
vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../../../../packages/engine/src/lib/hatchet.js", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

const { bucketMemberships, contactAliases, contacts, userEvents } =
  await import("@hogsend/db");
const { and, eq, inArray, like, or } = await import("drizzle-orm");
const {
  JourneyRegistry,
  bucketExpiryTask,
  checkBucketMembership,
  createApp,
  createHogsendClient,
  defineBucket,
  minutes,
  resetBucketRegistry,
  resolveOrCreateContact,
} = await import("@hogsend/engine");

const RUN = `t7alias-${randomUUID()}`;
const uid = (label: string) => `${RUN}-${label}`;
const mail = (label: string) => `${RUN}-${label}@example.com`;

const MINUTE = 60 * 1000;

// One bucket per flipped site, each with its OWN property name so the
// property-index candidate lookup never crosses tests.
const HAS_BUCKET = uid("has-bucket");
const HAS_PROP = `${RUN}_has_plan`;
const CHECK_BUCKET = uid("check-bucket");
const CHECK_PROP = `${RUN}_check_plan`;
const ADMIN_BUCKET = uid("admin-bucket");
const ADMIN_PROP = `${RUN}_admin_plan`;
const EXPIRY_BUCKET = uid("expiry-bucket");
const EXPIRY_PROP = `${RUN}_expiry_plan`;
const EXPIRY_EVENT = `${RUN}.pulse`;

const hasBucket = defineBucket({
  meta: {
    id: HAS_BUCKET,
    name: "Alias has() bucket",
    enabled: true,
    criteria: (b) => b.prop(HAS_PROP).eq("pro"),
  },
});
const checkBucket = defineBucket({
  meta: {
    id: CHECK_BUCKET,
    name: "Alias real-time bucket",
    enabled: true,
    criteria: (b) => b.prop(CHECK_PROP).eq("pro"),
  },
});
const adminBucket = defineBucket({
  meta: {
    id: ADMIN_BUCKET,
    name: "Alias admin bucket",
    enabled: true,
    criteria: (b) => b.prop(ADMIN_PROP).eq("pro"),
  },
});
const expiryBucket = defineBucket({
  meta: {
    id: EXPIRY_BUCKET,
    name: "Alias fast-expiry bucket",
    enabled: true,
    fastExpiry: true,
    criteria: (b) =>
      b.all(
        b.event(EXPIRY_EVENT).within(minutes(5)).exists(),
        b.prop(EXPIRY_PROP).eq("pro"),
      ),
  },
});

const BUCKET_IDS = [HAS_BUCKET, CHECK_BUCKET, ADMIN_BUCKET, EXPIRY_BUCKET];

// ONE container holding all four buckets: it installs the process bucket
// registry the task + real-time path read, and it is the container the admin
// app resolves `bucketRegistry.has(id)` against.
const container = createHogsendClient({
  buckets: [hasBucket, checkBucket, adminBucket, expiryBucket],
});
const app = createApp(container);
const { db, logger } = container;

// The direct seam: `checkBucketMembership` takes the Hatchet client as a
// parameter, so the transition emits are observable without a live engine.
const stubHatchet = {
  events: { push: async () => {} },
};

// `bucketExpiryTask.fn` is the real task body (the config-preserving mock kept
// it); it self-bootstraps its db from process.env and reads the registry
// singleton installed above.
const expiryTask = bucketExpiryTask as unknown as {
  fn: (
    input: Record<string, unknown>,
    ctx: { sleepFor: (d: string) => Promise<unknown> },
  ) => Promise<{ status: string; reason?: string }>;
};

const createdContactIds: string[] = [];

/**
 * Drive a REAL merge and return the survivor plus its now-STALE key: two
 * identified contacts collide on the loser's email, the older survives, and
 * the loser's external key lives on ONLY as an alias while its own row is
 * soft-deleted (invisible to every column probe).
 */
async function mergedPair(label: string): Promise<{
  survivorId: string;
  survivorKey: string;
  staleKey: string;
}> {
  const survivorKey = uid(`${label}-survivor`);
  const staleKey = uid(`${label}-stale`);
  const loserEmail = mail(`${label}-loser`);

  const survivor = await resolveOrCreateContact({ db, userId: survivorKey });
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

  // The merge really happened: the loser is soft-deleted and the stale key
  // resolves to the survivor through the identity table ONLY.
  const [loserRow] = await db
    .select({ deletedAt: contacts.deletedAt })
    .from(contacts)
    .where(eq(contacts.id, loser.id));
  expect(loserRow?.deletedAt).not.toBeNull();
  const [alias] = await db
    .select({ contactId: contactAliases.contactId })
    .from(contactAliases)
    .where(
      and(
        eq(contactAliases.aliasKind, "external"),
        eq(contactAliases.aliasValue, staleKey),
      ),
    );
  expect(alias?.contactId).toBe(survivor.id);

  return { survivorId: survivor.id, survivorKey, staleKey };
}

/** Set the survivor's stored properties (what the flipped reads must see). */
async function setProps(
  contactId: string,
  properties: Record<string, unknown>,
): Promise<void> {
  await db
    .update(contacts)
    .set({ properties })
    .where(eq(contacts.id, contactId));
}

/** An active membership owned by `contactId`, keyed on its CURRENT key. */
async function seedMembership(opts: {
  bucketId: string;
  userId: string;
  contactId: string;
  expiresAt?: Date;
}): Promise<string> {
  const [row] = await db
    .insert(bucketMemberships)
    .values({
      userId: opts.userId,
      userEmail: null,
      bucketId: opts.bucketId,
      status: "active",
      source: "event",
      entryCount: 1,
      contactId: opts.contactId,
      expiresAt: opts.expiresAt ?? null,
    })
    .returning({ id: bucketMemberships.id });
  if (!row) throw new Error("bucketMemberships insert returned no row");
  return row.id;
}

afterAll(async () => {
  resetBucketRegistry();
  await db
    .delete(bucketMemberships)
    .where(inArray(bucketMemberships.bucketId, BUCKET_IDS));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  if (createdContactIds.length > 0) {
    await db
      .delete(userEvents)
      .where(inArray(userEvents.contactId, createdContactIds));
    await db
      .delete(contactAliases)
      .where(inArray(contactAliases.contactId, createdContactIds));
  }
  await db
    .delete(contactAliases)
    .where(like(contactAliases.aliasValue, `${RUN}-%`));
  await db
    .delete(contacts)
    .where(
      or(
        like(contacts.externalId, `${RUN}-%`),
        like(contacts.anonymousId, `${RUN}-%`),
        like(contacts.email, `${RUN}-%`),
      ),
    );
});

// ===========================================================================
// Site 1 — `bucket-access.ts` has()
// ===========================================================================

describe("bucket accessor has() — alias-aware key resolution", () => {
  it("answers TRUE for a merged-away key the survivor still owns", async () => {
    const { survivorId, survivorKey, staleKey } = await mergedPair("has");
    await seedMembership({
      bucketId: HAS_BUCKET,
      userId: survivorKey,
      contactId: survivorId,
    });

    // The survivor's CURRENT key is the control: unchanged by the flip.
    const live = await hasBucket.has(survivorKey);
    expect(live.error).toBeNull();
    expect(live.data).toBe(true);

    // THE ASSERTION. No live contact's `coalesce(external_id, anonymous_id,
    // id)` equals the stale key — only the identity table can reach the
    // survivor from here, so the pre-flip probe answered false for a member.
    const stale = await hasBucket.has(staleKey);
    expect(stale.error).toBeNull();
    expect(stale.data).toBe(true);

    // ...and an unowned key is still a miss (the no-resolve arm, preserved).
    const unknown = await hasBucket.has(uid("has-nobody"));
    expect(unknown.error).toBeNull();
    expect(unknown.data).toBe(false);
  });
});

// ===========================================================================
// Site 2 — `check-membership.ts` real-time criteria eval
// ===========================================================================

describe("checkBucketMembership — alias-aware contact-state read", () => {
  it("evaluates property criteria against the SURVIVOR for a stale key", async () => {
    const { survivorId, staleKey } = await mergedPair("check");
    await setProps(survivorId, { [CHECK_PROP]: "pro" });

    // The event is presented under the STALE key (the shape a webhook or a
    // stale client still sends after a merge). Its property name narrows the
    // candidate set; D2 keeps the payload OUT of property eval, so the "pro"
    // verdict can only come from the contact row the key resolved to.
    const transitions = await checkBucketMembership({
      db,
      registry: new JourneyRegistry(),
      // biome-ignore lint/suspicious/noExplicitAny: stubbed hatchet client
      hatchet: stubHatchet as any,
      logger,
      userId: staleKey,
      userEmail: null,
      event: `${RUN}.touch`,
      eventProperties: { [CHECK_PROP]: "irrelevant" },
    });

    // Pre-flip this read found no row at all: properties evaluated as `{}`,
    // the property leg answered "absent", and no transition was produced.
    expect(transitions).toContainEqual({
      bucketId: CHECK_BUCKET,
      transition: "entered",
    });
  });

  it("still sees a SOFT-DELETED contact through the coalesce fallback", async () => {
    // The load-bearing fallback: `lookupContactIdByKey` is live-only, so a
    // soft-deleted contact resolves to null. Stopping there would leave
    // `contactDeleted` false and re-open the GDPR guard — the exact failure
    // the flipped site's comment block calls "the serious one".
    const erasedKey = uid("check-erased");
    const erased = await resolveOrCreateContact({ db, userId: erasedKey });
    createdContactIds.push(erased.id);
    await setProps(erased.id, { [CHECK_PROP]: "pro" });
    await db
      .update(contacts)
      .set({ deletedAt: new Date() })
      .where(eq(contacts.id, erased.id));

    const transitions = await checkBucketMembership({
      db,
      registry: new JourneyRegistry(),
      // biome-ignore lint/suspicious/noExplicitAny: stubbed hatchet client
      hatchet: stubHatchet as any,
      logger,
      userId: erasedKey,
      userEmail: null,
      event: `${RUN}.touch`,
      eventProperties: { [CHECK_PROP]: "irrelevant" },
    });

    expect(transitions).toEqual([]);
    const rows = await db
      .select({ id: bucketMemberships.id })
      .from(bucketMemberships)
      .where(
        and(
          eq(bucketMemberships.bucketId, CHECK_BUCKET),
          eq(bucketMemberships.userId, erasedKey),
        ),
      );
    expect(rows).toHaveLength(0);
  });
});

// ===========================================================================
// Site 3 — `routes/admin/buckets.ts` members filter
// ===========================================================================

describe("GET /v1/admin/buckets/:id/members?userId — alias-aware filter", () => {
  it("shows the survivor's membership when filtered by a merged-away key", async () => {
    const { survivorId, survivorKey, staleKey } = await mergedPair("admin");
    const membershipId = await seedMembership({
      bucketId: ADMIN_BUCKET,
      userId: survivorKey,
      contactId: survivorId,
    });

    const res = await app.request(
      `/v1/admin/buckets/${encodeURIComponent(ADMIN_BUCKET)}/members` +
        `?userId=${encodeURIComponent(staleKey)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
          "Content-Type": "application/json",
        },
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    // Pre-flip the resolve missed, `bySubject` fell back to
    // `user_id = <staleKey>`, and the operator saw an empty list for a person
    // whose row is right there under the survivor's id.
    expect(body.total).toBe(1);
    expect(body.members.map((m: { id: string }) => m.id)).toEqual([
      membershipId,
    ]);
  });
});

// ===========================================================================
// Site 4 — `workflows/bucket-reconcile.ts` resolveLiveContact (fast expiry)
// ===========================================================================

describe("bucketExpiryTask re-confirm — alias-aware owner resolution", () => {
  it("keeps a still-qualifying member whose armed key was merged away", async () => {
    const { survivorId, survivorKey, staleKey } = await mergedPair("expiry");
    await setProps(survivorId, { [EXPIRY_PROP]: "pro" });

    // The qualifying event, dual-written with its owner exactly as
    // `ingestEvent` writes it — reachable only BY SUBJECT.
    await db.insert(userEvents).values({
      userId: survivorKey,
      event: EXPIRY_EVENT,
      properties: {},
      source: "test",
      contactId: survivorId,
      occurredAt: new Date(),
    });

    const armedExpiresAt = new Date(Date.now() + MINUTE);
    const rowId = await seedMembership({
      bucketId: EXPIRY_BUCKET,
      userId: survivorKey,
      contactId: survivorId,
      expiresAt: armedExpiresAt,
    });

    // The timer was armed under the key that has since merged away — the CAS
    // below matches this row exactly, so a failed re-confirm really does
    // expire a member who still qualifies.
    const result = await expiryTask.fn(
      {
        rowId,
        bucketId: EXPIRY_BUCKET,
        userId: staleKey,
        userEmail: null,
        armedExpiresAt: armedExpiresAt.toISOString(),
        msUntilExpiry: 0,
      },
      { sleepFor: async () => ({}) },
    );

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("still_member");

    const [after] = await db
      .select({ status: bucketMemberships.status })
      .from(bucketMemberships)
      .where(eq(bucketMemberships.id, rowId));
    expect(after?.status).toBe("active");
  });
});
