import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// DB-touching test: point at the real docker TimescaleDB (mirrors the other
// data-plane tests), overriding the vitest.config placeholder DATABASE_URL.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Hatchet is module-mocked so a successful `POST /v1/events` (which pushes
// through the ingest pipeline) never dials a live gRPC engine. The auth gate on
// `/v1/groups` runs before the handler, so the 401/403 boundary paths never
// touch Hatchet anyway.
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

const { apiKeys, contacts, groupMemberships, groups, userEvents } =
  await import("@hogsend/db");
const { and, eq, inArray } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");

const mockHatchet = {
  durableTask: vi.fn(() => ({
    run: vi.fn(),
    runNoWait: vi.fn(),
    runAndWait: vi.fn(),
  })),
  task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
  events: { push: vi.fn() },
  runs: { cancel: vi.fn(), get: vi.fn() },
  worker: vi.fn(),
} as unknown as ReturnType<typeof createHogsendClient>["hatchet"];

const container = createHogsendClient({
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db } = container;

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// RUN-namespaced so parallel/sequential suites never collide, and afterAll
// cleanup is precise.
const RUN = `groups-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const GROUP_TYPE = "company";
const GROUP_KEY = `${RUN}-acme`;
const EVENTS_GROUP_KEY = `${RUN}-events-acme`;
// A distinct key used only by the "add-member with a nonexistent contact"
// case — so the no-orphan-group assertion is unambiguous (this key must NEVER
// appear in a list after the 404).
const ORPHAN_CHECK_GROUP_KEY = `${RUN}-orphan-check`;

const SECRET_KEY = `hsk_test_${RUN}_secret`;
const PK_KEY = `pk_test_${RUN}_publishable`;
const ORIGIN = "https://app.example.com";

let secretKeyId = "";
let pkKeyId = "";
let contactId = "";
// The events-association test drives the PUBLISHABLE path (pk_ key), which is
// anon-only — the contact is resolved by this browser anon id.
const EVENTS_ANON_ID = `${RUN}-events-anon`;

const SECRET_HEADERS = {
  Authorization: `Bearer ${SECRET_KEY}`,
  "Content-Type": "application/json",
};

beforeAll(async () => {
  // A secret ingest-scoped key (the ONLY class that may reach /v1/groups).
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

  // A publishable (pk_) key with `ingest-public` scope + an Origin allowlist —
  // it can ingest browser events but must NEVER reach /v1/groups.
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

  // A live contact to add as a group member.
  const [contactRow] = await db
    .insert(contacts)
    .values({ externalId: `${RUN}-member`, email: `${RUN}-member@example.com` })
    .returning({ id: contacts.id });
  contactId = contactRow?.id ?? "";
});

afterAll(async () => {
  // Membership + group rows this suite created (both the CRUD group and the
  // events-association group), then the fixture contacts + keys. Scoped to THIS
  // RUN's group keys — the suites share one dev DB, so deleting by bare
  // groupType would nuke every other suite's (or a local demo's) memberships.
  const groupRows = await db
    .select({ id: groups.id })
    .from(groups)
    .where(
      and(
        eq(groups.groupType, GROUP_TYPE),
        inArray(groups.groupKey, [GROUP_KEY, EVENTS_GROUP_KEY]),
      ),
    );
  for (const { id } of groupRows) {
    await db.delete(groupMemberships).where(eq(groupMemberships.groupId, id));
  }
  await db.delete(groups).where(eq(groups.groupKey, GROUP_KEY));
  await db.delete(groups).where(eq(groups.groupKey, EVENTS_GROUP_KEY));
  // Defensive: this key must never have been created (the no-orphan guarantee),
  // but clean it up anyway so a regression can't leak a row into other suites.
  await db.delete(groups).where(eq(groups.groupKey, ORPHAN_CHECK_GROUP_KEY));

  await db.delete(contacts).where(eq(contacts.externalId, `${RUN}-member`));
  // The publishable event resolved an anon contact by its anonymousId; its
  // canonical key (and thus `user_events.user_id`) is that same anon id.
  await db.delete(userEvents).where(eq(userEvents.userId, EVENTS_ANON_ID));
  await db.delete(contacts).where(eq(contacts.anonymousId, EVENTS_ANON_ID));

  if (secretKeyId) await db.delete(apiKeys).where(eq(apiKeys.id, secretKeyId));
  if (pkKeyId) await db.delete(apiKeys).where(eq(apiKeys.id, pkKeyId));
});

// ===========================================================================
// (1) AUTH BOUNDARY — /v1/groups is SECRET-KEY ONLY. No key and a publishable
//     pk_ key must be rejected (401/403), NEVER served (200).
// ===========================================================================

describe("/v1/groups auth boundary (secret-key only)", () => {
  it("POST /v1/groups with NO api key → 401", async () => {
    const res = await app.request("/v1/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupType: GROUP_TYPE, groupKey: GROUP_KEY }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /v1/groups with a publishable pk_ key → 403 (ingest-public ≠ ingest)", async () => {
    const res = await app.request("/v1/groups", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PK_KEY}`,
        Origin: ORIGIN,
      },
      body: JSON.stringify({ groupType: GROUP_TYPE, groupKey: GROUP_KEY }),
    });
    expect(res.status).toBe(403);
  });

  it("GET /v1/groups unauthenticated → 401", async () => {
    const res = await app.request("/v1/groups", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("GET /v1/groups with a publishable pk_ key → 403", async () => {
    const res = await app.request("/v1/groups", {
      method: "GET",
      headers: { Authorization: `Bearer ${PK_KEY}`, Origin: ORIGIN },
    });
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// (2) CRUD with a valid secret ingest key.
// ===========================================================================

describe("/v1/groups CRUD (secret ingest key)", () => {
  it("POST /v1/groups identifies a group (200 + serialized group + DB row)", async () => {
    const res = await app.request("/v1/groups", {
      method: "POST",
      headers: SECRET_HEADERS,
      body: JSON.stringify({
        groupType: GROUP_TYPE,
        groupKey: GROUP_KEY,
        displayName: "Acme Inc",
        properties: { plan: "enterprise", seats: 42 },
      }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.group.groupType).toBe(GROUP_TYPE);
    expect(body.group.groupKey).toBe(GROUP_KEY);
    expect(body.group.displayName).toBe("Acme Inc");
    expect(body.group.properties).toEqual({ plan: "enterprise", seats: 42 });
    expect(typeof body.group.id).toBe("string");
    expect(typeof body.group.firstSeenAt).toBe("string");
    // Internal columns are NOT serialized.
    expect(body.group.organizationId).toBeUndefined();
    expect(body.group.deletedAt).toBeUndefined();

    // The row actually exists.
    const [row] = await db
      .select()
      .from(groups)
      .where(
        and(eq(groups.groupType, GROUP_TYPE), eq(groups.groupKey, GROUP_KEY)),
      );
    expect(row).toBeDefined();
    expect(row?.displayName).toBe("Acme Inc");
  });

  it("GET /v1/groups/{groupType}/{groupKey} returns the group", async () => {
    const res = await app.request(`/v1/groups/${GROUP_TYPE}/${GROUP_KEY}`, {
      headers: SECRET_HEADERS,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.group.groupKey).toBe(GROUP_KEY);
    expect(body.group.displayName).toBe("Acme Inc");
  });

  it("GET /v1/groups lists groups (the identified group appears)", async () => {
    const res = await app.request(
      `/v1/groups?groupType=${GROUP_TYPE}&limit=200`,
      { headers: SECRET_HEADERS },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.groups)).toBe(true);
    expect(
      body.groups.some((g: { groupKey: string }) => g.groupKey === GROUP_KEY),
    ).toBe(true);
  });

  it("POST members adds a contact (created:true, then created:false)", async () => {
    const first = await app.request(
      `/v1/groups/${GROUP_TYPE}/${GROUP_KEY}/members`,
      {
        method: "POST",
        headers: SECRET_HEADERS,
        body: JSON.stringify({ contactId, role: "admin" }),
      },
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.created).toBe(true);
    expect(firstBody.membership.contactId).toBe(contactId);
    expect(firstBody.membership.role).toBe("admin");
    expect(typeof firstBody.membership.joinedAt).toBe("string");

    // A second add of the same contact is idempotent — created:false.
    const second = await app.request(
      `/v1/groups/${GROUP_TYPE}/${GROUP_KEY}/members`,
      {
        method: "POST",
        headers: SECRET_HEADERS,
        body: JSON.stringify({ contactId }),
      },
    );
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.created).toBe(false);
  });

  it("GET members lists the group's members (the contact appears)", async () => {
    const res = await app.request(
      `/v1/groups/${GROUP_TYPE}/${GROUP_KEY}/members`,
      { headers: SECRET_HEADERS },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(
      body.members.some(
        (m: { contactId: string }) => m.contactId === contactId,
      ),
    ).toBe(true);
    const member = body.members.find(
      (m: { contactId: string }) => m.contactId === contactId,
    );
    expect(member.email).toBe(`${RUN}-member@example.com`);
    expect(member.externalId).toBe(`${RUN}-member`);
  });

  it("DELETE members removes the contact (removed:true)", async () => {
    const res = await app.request(
      `/v1/groups/${GROUP_TYPE}/${GROUP_KEY}/members/${contactId}`,
      { method: "DELETE", headers: SECRET_HEADERS },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.removed).toBe(true);

    // The membership is actually gone.
    const rows = await db
      .select()
      .from(groupMemberships)
      .where(eq(groupMemberships.contactId, contactId));
    expect(rows).toHaveLength(0);
  });

  it("GET a nonexistent group → 404", async () => {
    const res = await app.request(
      `/v1/groups/${GROUP_TYPE}/${RUN}-does-not-exist`,
      { headers: SECRET_HEADERS },
    );
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// (2b) MEMBER-ROUTE ROBUSTNESS — a bad contactId must never 500 (or mint an
//      orphan group): malformed → 400 (schema), well-formed-nonexistent → 404
//      with NO group created.
// ===========================================================================

const ABSENT_UUID = "00000000-0000-0000-0000-000000000000";

describe("/v1/groups member-route robustness", () => {
  it("add-member with a well-formed NONEXISTENT uuid → 404 and mints NO orphan group", async () => {
    const res = await app.request(
      `/v1/groups/${GROUP_TYPE}/${ORPHAN_CHECK_GROUP_KEY}/members`,
      {
        method: "POST",
        headers: SECRET_HEADERS,
        body: JSON.stringify({ contactId: ABSENT_UUID }),
      },
    );
    expect(res.status).toBe(404);

    // The would-be group was NOT created (no orphan) — assert via the API list
    // AND directly against the DB.
    const list = await app.request(
      `/v1/groups?groupType=${GROUP_TYPE}&limit=200`,
      { headers: SECRET_HEADERS },
    );
    const listBody = await list.json();
    expect(
      listBody.groups.some(
        (g: { groupKey: string }) => g.groupKey === ORPHAN_CHECK_GROUP_KEY,
      ),
    ).toBe(false);

    const rows = await db
      .select()
      .from(groups)
      .where(eq(groups.groupKey, ORPHAN_CHECK_GROUP_KEY));
    expect(rows).toHaveLength(0);
  });

  it("add-member with a NON-uuid contactId → 400 (schema rejects)", async () => {
    const res = await app.request(
      `/v1/groups/${GROUP_TYPE}/${GROUP_KEY}/members`,
      {
        method: "POST",
        headers: SECRET_HEADERS,
        body: JSON.stringify({ contactId: "not-a-uuid" }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("remove-member with a NON-uuid contactId → 400 (schema rejects)", async () => {
    const res = await app.request(
      `/v1/groups/${GROUP_TYPE}/${GROUP_KEY}/members/not-a-uuid`,
      { method: "DELETE", headers: SECRET_HEADERS },
    );
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// (3) Publishable association via /v1/events — a pk_ key associates a group by
//     attaching a `groups` map to an ingested event (association-only). The DB
//     shows the group row + membership after ingest (exercises Part B).
// ===========================================================================

describe("publishable /v1/events group association (Part B)", () => {
  it("pk_ POST /v1/events with groups → 202 and the group + membership exist", async () => {
    // The PUBLISHABLE path: a pk_ key (Origin-allowlisted, anon-only). It can
    // REFERENCE a group key here (association-only) but can never write group
    // properties or read groups — the auth-boundary suite proved /v1/groups
    // 403s this key.
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PK_KEY}`,
        Origin: ORIGIN,
      },
      body: JSON.stringify({
        name: "company.seen",
        anonymousId: EVENTS_ANON_ID,
        groups: { [GROUP_TYPE]: EVENTS_GROUP_KEY },
      }),
    });
    expect(res.status).toBe(202);

    // The group row was ensured by association (no property write).
    const [group] = await db
      .select()
      .from(groups)
      .where(
        and(
          eq(groups.groupType, GROUP_TYPE),
          eq(groups.groupKey, EVENTS_GROUP_KEY),
        ),
      );
    expect(group).toBeDefined();
    // Association-only: no properties were written by the ingest path.
    expect(group?.properties).toEqual({});

    // The event's anon contact was made a member of the group.
    const [contact] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.anonymousId, EVENTS_ANON_ID));
    expect(contact).toBeDefined();
    const memberships = await db
      .select()
      .from(groupMemberships)
      .where(
        and(
          eq(groupMemberships.groupId, group?.id ?? ""),
          eq(groupMemberships.contactId, contact?.id ?? ""),
        ),
      );
    expect(memberships).toHaveLength(1);
  });
});
