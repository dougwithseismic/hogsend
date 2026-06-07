import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Hatchet is module-mocked so `POST /v1/events` (which pushes through the ingest
// pipeline on a successful auth) never reaches a live gRPC engine. The scope
// gate runs BEFORE the handler, so the 401/403 paths never touch Hatchet anyway.
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

const { apiKeys, contacts, userEvents } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");

// Inject the mock hatchet into the CONTAINER (the engine builds its own hatchet
// client; module-mocking the API's `../lib/hatchet.js` does not reach it). On a
// successful auth, `POST /v1/events` ingests through this hatchet, so the push
// must be a no-op spy rather than a live gRPC dial.
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

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const app = createApp(container);
const { db } = container;

// Same sha256 hashing the engine's `hashApiKey` uses (node:crypto). Inserting
// `api_keys` rows directly with a known plaintext lets us mint scoped keys
// without going through the admin create route (which would itself need auth).
function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

const READ_KEY = "hsk_test_authscope_readonly_key";
const INGEST_KEY = "hsk_test_authscope_ingest_key";

let readKeyId: string;
let ingestKeyId: string;

beforeAll(async () => {
  const [readRow] = await db
    .insert(apiKeys)
    .values({
      name: "auth-scope read-only",
      keyPrefix: READ_KEY.slice(0, 8),
      keyHash: hashKey(READ_KEY),
      scopes: ["read"],
    })
    .returning({ id: apiKeys.id });
  readKeyId = readRow?.id ?? "";

  const [ingestRow] = await db
    .insert(apiKeys)
    .values({
      name: "auth-scope ingest",
      keyPrefix: INGEST_KEY.slice(0, 8),
      keyHash: hashKey(INGEST_KEY),
      scopes: ["ingest"],
    })
    .returning({ id: apiKeys.id });
  ingestKeyId = ingestRow?.id ?? "";
});

afterAll(async () => {
  await db
    .delete(userEvents)
    .where(eq(userEvents.userId, "auth-scope-test-user"));
  await db
    .delete(contacts)
    .where(eq(contacts.externalId, "auth-scope-test-user"));
  if (readKeyId) await db.delete(apiKeys).where(eq(apiKeys.id, readKeyId));
  if (ingestKeyId) await db.delete(apiKeys).where(eq(apiKeys.id, ingestKeyId));
});

function eventBody() {
  return JSON.stringify({
    name: "auth.scope.test",
    userId: "auth-scope-test-user",
    eventProperties: { probe: true },
  });
}

describe("data-plane auth + scope gate (D5)", () => {
  it("returns 401 with NO key", async () => {
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: eventBody(),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 with an unknown key", async () => {
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer hsk_not_a_real_key",
      },
      body: eventBody(),
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 for a read-only key on /v1/events (orthogonal ingest NOT implied by `read`)", async () => {
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${READ_KEY}`,
      },
      body: eventBody(),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("scope");
  });

  it("returns 202 for an ingest-scoped key", async () => {
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INGEST_KEY}`,
      },
      body: eventBody(),
    });
    expect(res.status).toBe(202);
  });

  it("returns 202 for the legacy full-admin key (full-admin implies ingest)", async () => {
    const res = await app.request("/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
      },
      body: eventBody(),
    });
    expect(res.status).toBe(202);
  });

  it("read-only key is also rejected on /v1/contacts (gate is at the sub-app, not per-route)", async () => {
    const res = await app.request("/v1/contacts", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${READ_KEY}`,
      },
      body: JSON.stringify({ userId: "auth-scope-test-user" }),
    });
    expect(res.status).toBe(403);
  });
});
