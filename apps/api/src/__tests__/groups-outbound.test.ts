import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// DB-touching test: the intent-layer `/v1/groups` routes fire `group.*` outbound
// events via the fire-and-forget emit spine, which inserts `webhook_deliveries`
// rows against this connection — point at the docker TimescaleDB.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// The emit spine enqueues the MODULE-LEVEL `deliverWebhookTask` (built from the
// engine's `lib/hatchet.ts` singleton at import time), NOT the container hatchet
// — so mock the singleton itself (both the engine path and the API re-export),
// exactly like outbound-webhooks-emit/routes. This also prevents a live gRPC
// dial while the route's fire-and-forget emit inserts the delivery row.
const { hatchetMock } = vi.hoisted(() => {
  const runNoWait = vi.fn(async (_input: { deliveryId: string }) => ({}));
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
        runNoWait,
      })),
      events: { push: vi.fn() },
      runs: { cancel: vi.fn(), get: vi.fn() },
      worker: vi.fn(),
    },
  });
  return { hatchetMock: factory };
});

vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

const {
  apiKeys,
  contacts,
  groupMemberships,
  groups,
  webhookDeliveries,
  webhookEndpoints,
} = await import("@hogsend/db");
const { and, eq } = await import("drizzle-orm");
const { createApp, createHogsendClient, WEBHOOK_EVENT_TYPES } = await import(
  "@hogsend/engine"
);

const container = createHogsendClient();
const app = createApp(container);
const { db } = container;

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

const RUN = `grpout-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const GROUP_TYPE = "company";
const GROUP_KEY = `${RUN}-acme`;
const SECRET_KEY = `hsk_test_${RUN}_secret`;
const SECRET_HEADERS = {
  Authorization: `Bearer ${SECRET_KEY}`,
  "Content-Type": "application/json",
};

let secretKeyId = "";
let endpointId = "";
let contactId = "";

/** All delivery rows for the seeded endpoint with a given eventType. */
async function deliveriesFor(eventType: string) {
  return db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.endpointId, endpointId),
        eq(webhookDeliveries.eventType, eventType),
      ),
    );
}

/**
 * The route emits are fire-and-forget (`void emitOutbound(...)`), so the
 * `app.request()` returns before the emit's async DB insert lands — poll until
 * the delivery row appears (or a generous timeout).
 */
async function waitForDelivery(eventType: string, timeoutMs = 3000) {
  const start = Date.now();
  let rows = await deliveriesFor(eventType);
  while (rows.length === 0 && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 25));
    rows = await deliveriesFor(eventType);
  }
  return rows;
}

beforeAll(async () => {
  // A secret ingest-scoped key — the ONLY class allowed to reach /v1/groups.
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

  // An endpoint subscribed to exactly the 3 group events (org NULL → selected
  // by the single-tenant emit filter).
  const [endpointRow] = await db
    .insert(webhookEndpoints)
    .values({
      url: `https://example.com/${RUN}/group-sink`,
      secret: "whsec_dGVzdHNlY3JldGZvcmVtaXRwb2ludGNvdmVyYWdldGVzdA==",
      secretPrefix: "whsec_dGVzd",
      eventTypes: [
        "group.identified",
        "group.member_added",
        "group.member_removed",
      ],
      disabled: false,
    })
    .returning({ id: webhookEndpoints.id });
  endpointId = endpointRow?.id ?? "";

  // A live contact to add/remove as a member.
  const [contactRow] = await db
    .insert(contacts)
    .values({ externalId: `${RUN}-member`, email: `${RUN}-member@example.com` })
    .returning({ id: contacts.id });
  contactId = contactRow?.id ?? "";
});

afterAll(async () => {
  if (endpointId) {
    await db
      .delete(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, endpointId));
    await db
      .delete(webhookEndpoints)
      .where(eq(webhookEndpoints.id, endpointId));
  }
  const groupRows = await db
    .select({ id: groups.id })
    .from(groups)
    .where(
      and(eq(groups.groupType, GROUP_TYPE), eq(groups.groupKey, GROUP_KEY)),
    );
  for (const { id } of groupRows) {
    await db.delete(groupMemberships).where(eq(groupMemberships.groupId, id));
  }
  await db.delete(groups).where(eq(groups.groupKey, GROUP_KEY));
  await db.delete(contacts).where(eq(contacts.externalId, `${RUN}-member`));
  if (secretKeyId) await db.delete(apiKeys).where(eq(apiKeys.id, secretKeyId));
});

// ===========================================================================
// Catalog sync — the 3 new names exist in the engine source of truth.
// ===========================================================================

describe("WEBHOOK_EVENT_TYPES catalog", () => {
  it("contains the 3 group.* outbound events", () => {
    expect(WEBHOOK_EVENT_TYPES).toContain("group.identified");
    expect(WEBHOOK_EVENT_TYPES).toContain("group.member_added");
    expect(WEBHOOK_EVENT_TYPES).toContain("group.member_removed");
  });
});

// ===========================================================================
// Intent-layer route fan-out — POST /v1/groups + member mutations emit group.*
// ===========================================================================

describe("/v1/groups intent-layer outbound fan-out (Part A)", () => {
  it("POST /v1/groups (identify) emits group.identified with the serialized group", async () => {
    const res = await app.request("/v1/groups", {
      method: "POST",
      headers: SECRET_HEADERS,
      body: JSON.stringify({
        groupType: GROUP_TYPE,
        groupKey: GROUP_KEY,
        displayName: "Acme Inc",
        properties: { plan: "enterprise" },
      }),
    });
    expect(res.status).toBe(200);

    const rows = await waitForDelivery("group.identified");
    expect(rows).toHaveLength(1);
    const envelope = rows[0]?.payload as {
      type: string;
      data: { groupType: string; groupKey: string; displayName: string | null };
    };
    expect(envelope.type).toBe("group.identified");
    expect(envelope.data.groupType).toBe(GROUP_TYPE);
    expect(envelope.data.groupKey).toBe(GROUP_KEY);
    expect(envelope.data.displayName).toBe("Acme Inc");
  });

  it("POST members emits group.member_added only when created:true", async () => {
    const first = await app.request(
      `/v1/groups/${GROUP_TYPE}/${GROUP_KEY}/members`,
      {
        method: "POST",
        headers: SECRET_HEADERS,
        body: JSON.stringify({ contactId, role: "admin" }),
      },
    );
    expect(first.status).toBe(200);
    expect((await first.json()).created).toBe(true);

    const rows = await waitForDelivery("group.member_added");
    expect(rows).toHaveLength(1);
    const envelope = rows[0]?.payload as {
      type: string;
      data: { contactId: string; role: string | null; groupId: string };
    };
    expect(envelope.type).toBe("group.member_added");
    expect(envelope.data.contactId).toBe(contactId);
    expect(envelope.data.role).toBe("admin");
    expect(typeof envelope.data.groupId).toBe("string");

    // A re-add (created:false) must NOT emit a second row.
    const second = await app.request(
      `/v1/groups/${GROUP_TYPE}/${GROUP_KEY}/members`,
      {
        method: "POST",
        headers: SECRET_HEADERS,
        body: JSON.stringify({ contactId }),
      },
    );
    expect((await second.json()).created).toBe(false);
    // Give any (erroneous) emit a chance to land, then assert still exactly one.
    await new Promise((r) => setTimeout(r, 250));
    expect(await deliveriesFor("group.member_added")).toHaveLength(1);
  });

  it("DELETE members emits group.member_removed only when removed:true", async () => {
    const res = await app.request(
      `/v1/groups/${GROUP_TYPE}/${GROUP_KEY}/members/${contactId}`,
      { method: "DELETE", headers: SECRET_HEADERS },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).removed).toBe(true);

    const rows = await waitForDelivery("group.member_removed");
    expect(rows).toHaveLength(1);
    const envelope = rows[0]?.payload as {
      type: string;
      data: { contactId: string; groupId: string };
    };
    expect(envelope.type).toBe("group.member_removed");
    expect(envelope.data.contactId).toBe(contactId);
    expect(typeof envelope.data.groupId).toBe("string");

    // A second delete (removed:false — membership already gone) must NOT emit.
    const second = await app.request(
      `/v1/groups/${GROUP_TYPE}/${GROUP_KEY}/members/${contactId}`,
      { method: "DELETE", headers: SECRET_HEADERS },
    );
    expect((await second.json()).removed).toBe(false);
    await new Promise((r) => setTimeout(r, 250));
    expect(await deliveriesFor("group.member_removed")).toHaveLength(1);
  });
});
