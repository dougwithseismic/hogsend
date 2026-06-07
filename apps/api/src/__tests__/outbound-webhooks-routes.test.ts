import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// DB-touching test: point at the real docker TimescaleDB, overriding the
// vitest.config placeholder DATABASE_URL (mirrors the other admin-route tests).
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// The admin `/{id}/test` route enqueues the MODULE-LEVEL `deliverWebhookTask`
// (built from the engine's `lib/hatchet.ts` singleton at import time), NOT the
// container's hatchet — so an `overrides.hatchet` seam would never intercept it.
// Mock the singleton itself (both the engine path and the API's re-export), the
// same way the emit test does. `runNoWaitSpy` is the no-op spy the route's
// fire-and-forget enqueue lands on; mocking it also prevents a live gRPC dial.
const { runNoWaitSpy, hatchetMock } = vi.hoisted(() => {
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
  return { runNoWaitSpy: runNoWait, hatchetMock: factory };
});

vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

const { createApp, createHogsendClient } = await import("@hogsend/engine");
const { webhookDeliveries, webhookEndpoints } = await import("@hogsend/db");
const { eq, like } = await import("drizzle-orm");

const container = createHogsendClient();
const app = createApp(container);
const { db } = container;

const ADMIN_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};

// A namespaced URL prefix so cleanup is exact and concurrent runs never collide.
const RUN = `owr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const url = (label: string) => `https://example.com/${RUN}/${label}`;

beforeEach(() => {
  runNoWaitSpy.mockClear();
});

afterAll(async () => {
  // Deliveries cascade on the endpoint delete, but the `/test` route may have
  // left rows whose endpoint was hard-deleted in the same run — clean both.
  const endpoints = await db
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(like(webhookEndpoints.url, `https://example.com/${RUN}/%`));
  for (const ep of endpoints) {
    await db
      .delete(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, ep.id));
  }
  await db
    .delete(webhookEndpoints)
    .where(like(webhookEndpoints.url, `https://example.com/${RUN}/%`));
});

/** Create an endpoint via the admin route; returns the parsed JSON body. */
async function createEndpoint(body: Record<string, unknown>) {
  const res = await app.request("/v1/admin/webhooks", {
    method: "POST",
    headers: ADMIN_HEADER,
    body: JSON.stringify(body),
  });
  return { res, json: await res.json() };
}

// ===========================================================================
// POST / — create returns the full secret EXACTLY ONCE
// ===========================================================================

describe("POST /v1/admin/webhooks (create)", () => {
  it("creates an endpoint and returns 201 + the full secret once", async () => {
    const { res, json } = await createEndpoint({
      url: url("create"),
      eventTypes: ["contact.created", "email.sent"],
      description: "test endpoint",
    });

    expect(res.status).toBe(201);
    expect(json.id).toBeTruthy();
    expect(json.url).toBe(url("create"));
    expect(json.eventTypes).toEqual(["contact.created", "email.sent"]);
    expect(json.status).toBe("enabled");
    expect(json.description).toBe("test endpoint");
    // The full secret is returned ONLY here (create) — and is whsec_-prefixed.
    expect(typeof json.secret).toBe("string");
    expect(json.secret.startsWith("whsec_")).toBe(true);
    expect(json.secretPrefix).toBe(json.secret.slice(0, 12));

    // The persisted row stores the plaintext secret (re-signed every delivery).
    const [row] = await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, json.id));
    expect(row?.secret).toBe(json.secret);
    expect(row?.disabled).toBe(false);
  });

  it("rejects an empty eventTypes array (min 1)", async () => {
    const { res } = await createEndpoint({ url: url("empty"), eventTypes: [] });
    expect(res.status).toBe(400);
  });

  it("rejects an event type outside the catalog", async () => {
    const { res } = await createEndpoint({
      url: url("badevent"),
      eventTypes: ["contact.created", "not.a.real.event"],
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-URL url", async () => {
    const { res } = await createEndpoint({
      url: "not-a-url",
      eventTypes: ["contact.created"],
    });
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// GET / and GET /{id} — secret NEVER leaks
// ===========================================================================

describe("GET /v1/admin/webhooks (list + get) — secret-once invariant", () => {
  it("never includes `secret` on list or get (only secretPrefix)", async () => {
    const { json: created } = await createEndpoint({
      url: url("noleak"),
      eventTypes: ["bucket.entered"],
    });

    // GET one — no secret, prefix present.
    const getRes = await app.request(`/v1/admin/webhooks/${created.id}`, {
      headers: ADMIN_HEADER,
    });
    expect(getRes.status).toBe(200);
    const got = await getRes.json();
    expect(got.secret).toBeUndefined();
    expect(got.secretPrefix).toBe(created.secretPrefix);
    expect(got.status).toBe("enabled");

    // LIST — find our row, assert no secret on any element.
    const listRes = await app.request("/v1/admin/webhooks?limit=100&offset=0", {
      headers: ADMIN_HEADER,
    });
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(typeof list.total).toBe("number");
    const mine = list.endpoints.find(
      (e: { id: string }) => e.id === created.id,
    );
    expect(mine).toBeDefined();
    expect(mine.secret).toBeUndefined();
    expect(mine.secretPrefix).toBe(created.secretPrefix);
  });

  it("returns 404 for an unknown endpoint id", async () => {
    const res = await app.request(
      "/v1/admin/webhooks/00000000-0000-0000-0000-000000000000",
      { headers: ADMIN_HEADER },
    );
    expect(res.status).toBe(404);
  });

  it("excludes disabled endpoints when includeDisabled=false", async () => {
    const { json: created } = await createEndpoint({
      url: url("disabled-filter"),
      eventTypes: ["contact.created"],
      disabled: true,
    });
    expect(created.status).toBe("disabled");

    const res = await app.request(
      "/v1/admin/webhooks?limit=100&includeDisabled=false",
      { headers: ADMIN_HEADER },
    );
    const list = await res.json();
    const mine = list.endpoints.find(
      (e: { id: string }) => e.id === created.id,
    );
    expect(mine).toBeUndefined();
  });
});

// ===========================================================================
// PATCH /{id} — update fields; status derives from disabled; no secret
// ===========================================================================

describe("PATCH /v1/admin/webhooks/{id}", () => {
  it("updates eventTypes + disabled and serializes status, never returning secret", async () => {
    const { json: created } = await createEndpoint({
      url: url("patch"),
      eventTypes: ["contact.created"],
    });

    const res = await app.request(`/v1/admin/webhooks/${created.id}`, {
      method: "PATCH",
      headers: ADMIN_HEADER,
      body: JSON.stringify({
        eventTypes: ["email.opened", "email.clicked"],
        disabled: true,
        description: null,
      }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.eventTypes).toEqual(["email.opened", "email.clicked"]);
    expect(updated.status).toBe("disabled");
    expect(updated.description).toBeNull();
    expect(updated.secret).toBeUndefined();

    const [row] = await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, created.id));
    expect(row?.disabled).toBe(true);
    expect(row?.eventTypes).toEqual(["email.opened", "email.clicked"]);
  });

  it("returns 404 patching an unknown id", async () => {
    const res = await app.request(
      "/v1/admin/webhooks/00000000-0000-0000-0000-000000000000",
      {
        method: "PATCH",
        headers: ADMIN_HEADER,
        body: JSON.stringify({ disabled: true }),
      },
    );
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// POST /{id}/rotate-secret — new secret, returned once, hard cutover
// ===========================================================================

describe("POST /v1/admin/webhooks/{id}/rotate-secret", () => {
  it("issues a new secret (returned once) and replaces the stored one (hard cutover)", async () => {
    const { json: created } = await createEndpoint({
      url: url("rotate"),
      eventTypes: ["journey.completed"],
    });
    const oldSecret = created.secret;

    const res = await app.request(
      `/v1/admin/webhooks/${created.id}/rotate-secret`,
      { method: "POST", headers: ADMIN_HEADER },
    );
    expect(res.status).toBe(200);
    const rotated = await res.json();
    expect(rotated.id).toBe(created.id);
    expect(typeof rotated.secret).toBe("string");
    expect(rotated.secret.startsWith("whsec_")).toBe(true);
    expect(rotated.secret).not.toBe(oldSecret);
    expect(rotated.secretPrefix).toBe(rotated.secret.slice(0, 12));

    // The stored secret is the NEW one (the old is invalid immediately).
    const [row] = await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, created.id));
    expect(row?.secret).toBe(rotated.secret);
    expect(row?.secret).not.toBe(oldSecret);
  });

  it("returns 404 rotating an unknown id", async () => {
    const res = await app.request(
      "/v1/admin/webhooks/00000000-0000-0000-0000-000000000000/rotate-secret",
      { method: "POST", headers: ADMIN_HEADER },
    );
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// POST /{id}/test — out-of-band webhook.test, enqueue-and-202
// ===========================================================================

describe("POST /v1/admin/webhooks/{id}/test", () => {
  it("inserts a webhook.test delivery row + enqueues delivery, returns 202", async () => {
    const { json: created } = await createEndpoint({
      url: url("test"),
      // Deliberately NOT subscribed to webhook.test (it is out-of-band).
      eventTypes: ["contact.created"],
    });

    const res = await app.request(`/v1/admin/webhooks/${created.id}/test`, {
      method: "POST",
      headers: ADMIN_HEADER,
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.enqueued).toBe(true);
    expect(body.eventType).toBe("webhook.test");

    // The synthetic delivery row was written for THIS endpoint with the
    // out-of-band webhook.test envelope (NOT via emitOutbound — no subscription
    // filter applied).
    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, created.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("webhook.test");
    const payload = rows[0]?.payload as {
      type: string;
      data: { message: string; endpointId: string };
    };
    expect(payload.type).toBe("webhook.test");
    expect(payload.data.message).toBe("Hogsend test event");
    expect(payload.data.endpointId).toBe(created.id);

    // The durable delivery task was enqueued for that row.
    expect(runNoWaitSpy).toHaveBeenCalled();
    expect(runNoWaitSpy.mock.calls.at(-1)?.[0]?.deliveryId).toBe(rows[0]?.id);
  });

  it("returns 404 testing an unknown id", async () => {
    const res = await app.request(
      "/v1/admin/webhooks/00000000-0000-0000-0000-000000000000/test",
      { method: "POST", headers: ADMIN_HEADER },
    );
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// DELETE /{id} — hard delete cascades deliveries
// ===========================================================================

describe("DELETE /v1/admin/webhooks/{id}", () => {
  it("hard-deletes the endpoint and cascades its deliveries", async () => {
    const { json: created } = await createEndpoint({
      url: url("delete"),
      eventTypes: ["contact.created"],
    });

    // Seed a delivery row so we can prove the FK cascade drops it.
    await db.insert(webhookDeliveries).values({
      endpointId: created.id,
      webhookId: "msg_delete_cascade",
      eventType: "contact.created",
      payload: { id: "msg_delete_cascade", type: "contact.created", data: {} },
      status: "pending",
      attemptCount: 0,
    });

    const res = await app.request(`/v1/admin/webhooks/${created.id}`, {
      method: "DELETE",
      headers: ADMIN_HEADER,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toBe(true);

    const endpointRows = await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, created.id));
    expect(endpointRows).toHaveLength(0);

    // Deliveries cascade-dropped with the endpoint.
    const deliveryRows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.endpointId, created.id));
    expect(deliveryRows).toHaveLength(0);
  });

  it("returns 404 deleting an unknown id", async () => {
    const res = await app.request(
      "/v1/admin/webhooks/00000000-0000-0000-0000-000000000000",
      { method: "DELETE", headers: ADMIN_HEADER },
    );
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// Auth — /v1/admin/webhooks inherits requireAdmin from the admin router root
// ===========================================================================

describe("/v1/admin/webhooks auth (requireAdmin)", () => {
  it("returns 401 with NO key", async () => {
    const res = await app.request("/v1/admin/webhooks");
    expect(res.status).toBe(401);
  });

  it("returns 401 with an unknown key", async () => {
    const res = await app.request("/v1/admin/webhooks", {
      headers: { Authorization: "Bearer not-a-real-admin-key" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 with the admin key", async () => {
    const res = await app.request("/v1/admin/webhooks?limit=1", {
      headers: ADMIN_HEADER,
    });
    expect(res.status).toBe(200);
  });
});
