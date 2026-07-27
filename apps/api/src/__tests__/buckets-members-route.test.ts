/**
 * PRD 01 T01.4 + T01.5 — the secret-key `/v1/buckets/:id/members` surface and
 * the admin read surface that lets Studio tell a manual bucket from a dynamic
 * one.
 *
 * The auth boundary is the point of this file: `/v1/buckets` mirrors
 * `/v1/groups` exactly — `requireApiKey` + `requireScope("ingest")`, bare AND
 * subtree — so a publishable (pk_) browser key can NEVER mutate bucket
 * membership (AC 9). Everything else is a thin delegation to T01.3's service,
 * asserted against the real `bucket_memberships` / `user_events` rows rather
 * than the response body alone.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// DB-touching test against the real docker TimescaleDB (mirrors
// bucket-membership.test.ts / groups-api.test.ts), overriding the vitest.config
// placeholder DATABASE_URL.
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Hatchet is module-mocked (both the engine's own module and the API's) so no
// live gRPC engine is constructed at import. Transitions are asserted on the
// persisted `user_events` rows, which `emitBucketTransition` → `ingestEvent`
// writes for real.
const { hatchetMock } = vi.hoisted(() => {
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
  return { hatchetMock: factory };
});

vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

const { apiKeys, bucketMemberships, contacts, userEvents } = await import(
  "@hogsend/db"
);
const { and, eq, inArray, sql } = await import("drizzle-orm");
const { createApp, createHogsendClient, defineBucket } = await import(
  "@hogsend/engine"
);

const RUN = `bmr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const uid = (label: string) => `${RUN}-${label}`;

// ---------------------------------------------------------------------------
// Buckets under test — one manual (the mutable one) and one dynamic (whose
// membership is owned by its criteria and must refuse an explicit write).
// ---------------------------------------------------------------------------

const MANUAL_ID = `${RUN}-manual`;
const manualBucket = defineBucket({
  meta: {
    id: MANUAL_ID,
    name: "Manual bucket",
    description: "Membership written explicitly",
    enabled: true,
    kind: "manual",
  },
});

const DYNAMIC_ID = `${RUN}-dynamic`;
const dynamicBucket = defineBucket({
  meta: {
    id: DYNAMIC_ID,
    name: "Dynamic bucket",
    enabled: true,
    criteria: (b) => b.event(`${RUN}:did.thing`).atLeast(1),
  },
});

const BUCKET_IDS = [MANUAL_ID, DYNAMIC_ID];

const container = createHogsendClient({
  buckets: [manualBucket, dynamicBucket],
});
const app = createApp(container);
const { db } = container;

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

const SECRET_KEY = `hsk_test_${RUN}_secret`;
const PK_KEY = `pk_test_${RUN}_publishable`;
const ORIGIN = "https://app.example.com";

const SECRET_HEADERS = {
  Authorization: `Bearer ${SECRET_KEY}`,
  "Content-Type": "application/json",
};
const PK_HEADERS = {
  Authorization: `Bearer ${PK_KEY}`,
  Origin: ORIGIN,
  "Content-Type": "application/json",
};
const ADMIN_HEADERS = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
};

let secretKeyId = "";
let pkKeyId = "";

async function seedContact(userId: string): Promise<void> {
  await db.insert(contacts).values({
    externalId: userId,
    email: `${userId}@example.com`,
    properties: {},
  });
}

async function membershipRows(userId: string, bucketId: string) {
  return db.query.bucketMemberships.findMany({
    where: and(
      eq(bucketMemberships.userId, userId),
      eq(bucketMemberships.bucketId, bucketId),
    ),
    orderBy: (m, { asc }) => [asc(m.entryCount), asc(m.id)],
  });
}

/** Persisted `bucket:<kind>:<bucketId>` transitions for ONE user. */
async function transitionCount(
  bucketId: string,
  kind: "entered" | "left",
  userId: string,
): Promise<number> {
  const found = await db.query.userEvents.findMany({
    where: and(
      eq(userEvents.event, `bucket:${kind}:${bucketId}`),
      eq(userEvents.userId, userId),
    ),
  });
  return found.length;
}

beforeAll(async () => {
  const [secretRow] = await db
    .insert(apiKeys)
    .values({
      name: `${RUN} secret ingest`,
      keyPrefix: SECRET_KEY.slice(0, 8),
      keyHash: hashKey(SECRET_KEY),
      scopes: ["ingest"],
    })
    .returning({ id: apiKeys.id });
  secretKeyId = secretRow?.id ?? "";

  const [pkRow] = await db
    .insert(apiKeys)
    .values({
      name: `${RUN} publishable`,
      keyPrefix: PK_KEY.slice(0, 8),
      keyHash: hashKey(PK_KEY),
      scopes: ["ingest-public"],
      allowedOrigins: [ORIGIN],
    })
    .returning({ id: apiKeys.id });
  pkKeyId = pkRow?.id ?? "";
});

afterAll(async () => {
  await db
    .delete(bucketMemberships)
    .where(inArray(bucketMemberships.bucketId, BUCKET_IDS));
  await db
    .delete(userEvents)
    .where(sql`${userEvents.userId} like ${`${RUN}-%`}`);
  await db
    .delete(contacts)
    .where(sql`${contacts.externalId} like ${`${RUN}-%`}`);
  if (secretKeyId) await db.delete(apiKeys).where(eq(apiKeys.id, secretKeyId));
  if (pkKeyId) await db.delete(apiKeys).where(eq(apiKeys.id, pkKeyId));
});

// ===========================================================================
// (1) AUTH BOUNDARY (AC 9) — secret-key only, exactly like /v1/groups.
// ===========================================================================

describe("/v1/buckets auth boundary (secret-key only)", () => {
  it("POST /v1/buckets/:id/members with NO api key → 401 and writes nothing", async () => {
    const userId = uid("noauth");
    const res = await app.request(`/v1/buckets/${MANUAL_ID}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    expect(res.status).toBe(401);
    expect(await membershipRows(userId, MANUAL_ID)).toEqual([]);
  });

  it("POST /v1/buckets/:id/members with a publishable pk_ key → 403 and writes nothing", async () => {
    const userId = uid("pk-add");
    const res = await app.request(`/v1/buckets/${MANUAL_ID}/members`, {
      method: "POST",
      headers: PK_HEADERS,
      body: JSON.stringify({ userId }),
    });
    expect(res.status).toBe(403);
    expect(await membershipRows(userId, MANUAL_ID)).toEqual([]);
  });

  it("DELETE /v1/buckets/:id/members/:userId with a publishable pk_ key → 403 and leaves the row active", async () => {
    const userId = uid("pk-remove");
    await seedContact(userId);
    const added = await app.request(`/v1/buckets/${MANUAL_ID}/members`, {
      method: "POST",
      headers: SECRET_HEADERS,
      body: JSON.stringify({ userId }),
    });
    expect(added.status).toBe(200);

    const res = await app.request(
      `/v1/buckets/${MANUAL_ID}/members/${userId}`,
      { method: "DELETE", headers: PK_HEADERS },
    );
    expect(res.status).toBe(403);

    const rows = await membershipRows(userId, MANUAL_ID);
    expect(rows.map((r) => r.status)).toEqual(["active"]);
  });

  it("GET /v1/buckets/:id/members unauthenticated → 401", async () => {
    const res = await app.request(`/v1/buckets/${MANUAL_ID}/members`, {
      method: "GET",
    });
    expect(res.status).toBe(401);
  });

  it("GET /v1/buckets/:id/members with a publishable pk_ key → 403", async () => {
    const res = await app.request(`/v1/buckets/${MANUAL_ID}/members`, {
      method: "GET",
      headers: { Authorization: `Bearer ${PK_KEY}`, Origin: ORIGIN },
    });
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// (2) MUTATION with a valid secret ingest key.
// ===========================================================================

describe("/v1/buckets/:id/members mutation (secret ingest key)", () => {
  it("POST adds a member: 200 + the service verdict + an active row + bucket:entered", async () => {
    const userId = uid("add");
    await seedContact(userId);

    const res = await app.request(`/v1/buckets/${MANUAL_ID}/members`, {
      method: "POST",
      headers: SECRET_HEADERS,
      body: JSON.stringify({ userId }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      emitted: true,
      epoch: 1,
      verdict: "applied",
    });

    const rows = await membershipRows(userId, MANUAL_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("active");
    expect(rows[0]?.entryCount).toBe(1);
    expect(rows[0]?.source).toBe("manual");
    expect(await transitionCount(MANUAL_ID, "entered", userId)).toBe(1);
  });

  it("POST is idempotent for an already-active member (AC 5)", async () => {
    const userId = uid("add-twice");
    await seedContact(userId);

    for (const _ of [0, 1]) {
      const res = await app.request(`/v1/buckets/${MANUAL_ID}/members`, {
        method: "POST",
        headers: SECRET_HEADERS,
        body: JSON.stringify({ userId }),
      });
      expect(res.status).toBe(200);
    }

    expect(await membershipRows(userId, MANUAL_ID)).toHaveLength(1);
    expect(await transitionCount(MANUAL_ID, "entered", userId)).toBe(1);
  });

  it("POST with emit:false seeds the row and emits NOTHING (AC 12)", async () => {
    const userId = uid("seed");
    await seedContact(userId);

    const res = await app.request(`/v1/buckets/${MANUAL_ID}/members`, {
      method: "POST",
      headers: SECRET_HEADERS,
      body: JSON.stringify({ userId, emit: false, source: "seed" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      emitted: false,
      epoch: 1,
      verdict: "seeded",
    });

    const rows = await membershipRows(userId, MANUAL_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("active");
    expect(rows[0]?.source).toBe("seed");
    // The whole point of the seed mode: an existing population must not fire
    // into live journeys (the Customer.io rule).
    expect(await transitionCount(MANUAL_ID, "entered", userId)).toBe(0);
  });

  it("DELETE removes a member: 200 + a left row + bucket:left", async () => {
    const userId = uid("remove");
    await seedContact(userId);
    await app.request(`/v1/buckets/${MANUAL_ID}/members`, {
      method: "POST",
      headers: SECRET_HEADERS,
      body: JSON.stringify({ userId }),
    });

    const res = await app.request(
      `/v1/buckets/${MANUAL_ID}/members/${userId}`,
      { method: "DELETE", headers: SECRET_HEADERS },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      emitted: true,
      epoch: 1,
      verdict: "applied",
    });

    const rows = await membershipRows(userId, MANUAL_ID);
    expect(rows.map((r) => r.status)).toEqual(["left"]);
    expect(await transitionCount(MANUAL_ID, "left", userId)).toBe(1);
  });

  it("DELETE for a non-member is a no-op with the already-left verdict", async () => {
    const userId = uid("never-member");
    const res = await app.request(
      `/v1/buckets/${MANUAL_ID}/members/${userId}`,
      { method: "DELETE", headers: SECRET_HEADERS },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      emitted: false,
      epoch: 0,
      verdict: "already-left",
    });
    expect(await transitionCount(MANUAL_ID, "left", userId)).toBe(0);
  });
});

// ===========================================================================
// (3) The non-manual refusal — criteria own a dynamic bucket's membership.
// ===========================================================================

describe("/v1/buckets/:id/members refuses a non-manual bucket", () => {
  it("POST on a DYNAMIC bucket → 409 and writes no membership row", async () => {
    const userId = uid("dyn-add");
    await seedContact(userId);

    const res = await app.request(`/v1/buckets/${DYNAMIC_ID}/members`, {
      method: "POST",
      headers: SECRET_HEADERS,
      body: JSON.stringify({ userId }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(DYNAMIC_ID);

    expect(await membershipRows(userId, DYNAMIC_ID)).toEqual([]);
    expect(await transitionCount(DYNAMIC_ID, "entered", userId)).toBe(0);
  });

  it("DELETE on a DYNAMIC bucket → 409", async () => {
    const userId = uid("dyn-remove");
    const res = await app.request(
      `/v1/buckets/${DYNAMIC_ID}/members/${userId}`,
      { method: "DELETE", headers: SECRET_HEADERS },
    );
    expect(res.status).toBe(409);
  });

  it("POST on an UNREGISTERED bucket → 404", async () => {
    const res = await app.request(`/v1/buckets/${RUN}-nope/members`, {
      method: "POST",
      headers: SECRET_HEADERS,
      body: JSON.stringify({ userId: uid("ghost") }),
    });
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// (4) LIST — deterministic assertions on the ROW SET, never on heap order.
// ===========================================================================

describe("GET /v1/buckets/:id/members", () => {
  const listUsers = ["list-a", "list-b", "list-c"].map(uid);

  it("lists active members and filters by status", async () => {
    for (const userId of listUsers) {
      await seedContact(userId);
      const res = await app.request(`/v1/buckets/${MANUAL_ID}/members`, {
        method: "POST",
        headers: SECRET_HEADERS,
        body: JSON.stringify({ userId }),
      });
      expect(res.status).toBe(200);
    }
    // Remove exactly one so active and left are both non-empty.
    const [, , removed] = listUsers;
    await app.request(`/v1/buckets/${MANUAL_ID}/members/${removed}`, {
      method: "DELETE",
      headers: SECRET_HEADERS,
    });

    // Scoped by `userId` prefix is not available, so assert on SET membership
    // within this bucket rather than on an ordering- or limit-dependent slice.
    const activeRes = await app.request(
      `/v1/buckets/${MANUAL_ID}/members?status=active&limit=100`,
      { headers: SECRET_HEADERS },
    );
    expect(activeRes.status).toBe(200);
    const active = (await activeRes.json()) as {
      members: Array<{ userId: string; status: string; entryCount: number }>;
      total: number;
    };
    const activeIds = new Set(active.members.map((m) => m.userId));
    expect(activeIds.has(listUsers[0] as string)).toBe(true);
    expect(activeIds.has(listUsers[1] as string)).toBe(true);
    expect(activeIds.has(removed as string)).toBe(false);
    expect(active.members.every((m) => m.status === "active")).toBe(true);

    const leftRes = await app.request(
      `/v1/buckets/${MANUAL_ID}/members?status=left&limit=100`,
      { headers: SECRET_HEADERS },
    );
    const left = (await leftRes.json()) as {
      members: Array<{ userId: string; status: string }>;
      total: number;
    };
    const leftIds = new Set(left.members.map((m) => m.userId));
    expect(leftIds.has(removed as string)).toBe(true);
    expect(leftIds.has(listUsers[0] as string)).toBe(false);
    expect(left.members.every((m) => m.status === "left")).toBe(true);
  });

  it("filters to a single member by userId", async () => {
    const [target] = listUsers;
    const res = await app.request(
      `/v1/buckets/${MANUAL_ID}/members?userId=${target}`,
      { headers: SECRET_HEADERS },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      members: Array<{ userId: string; entryCount: number; source: string }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.members.map((m) => m.userId)).toEqual([target]);
    expect(body.members[0]?.entryCount).toBe(1);
  });

  it("404s an unregistered bucket", async () => {
    const res = await app.request(`/v1/buckets/${RUN}-nope/members`, {
      headers: SECRET_HEADERS,
    });
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// (5) T01.5 — the admin read surface distinguishes manual from dynamic.
// ===========================================================================

describe("admin bucket detail surfaces `kind` (T01.5)", () => {
  it('reports kind:"manual" for a manual bucket', async () => {
    const res = await app.request(`/v1/admin/buckets/${MANUAL_ID}`, {
      headers: ADMIN_HEADERS,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bucket: { id: string; kind: string; criteria?: unknown };
    };
    expect(body.bucket.id).toBe(MANUAL_ID);
    expect(body.bucket.kind).toBe("manual");
    // A manual bucket has no criteria — that is what makes it manual.
    expect(body.bucket.criteria).toBeUndefined();
  });

  it('reports kind:"dynamic" for a criteria-driven bucket', async () => {
    const res = await app.request(`/v1/admin/buckets/${DYNAMIC_ID}`, {
      headers: ADMIN_HEADERS,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bucket: { kind: string } };
    expect(body.bucket.kind).toBe("dynamic");
  });
});
