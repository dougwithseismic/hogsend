import { afterAll, describe, expect, it, vi } from "vitest";

// DB-touching test: point at the real docker TimescaleDB, overriding the
// vitest.config placeholder DATABASE_URL (mirrors the other admin-route tests).
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Hatchet seam: these routes never enqueue tasks, but createHogsendClient
// constructs the hatchet client — mock the API re-export so no gRPC dial can
// ever happen (same shape as admin-suppressions.test.ts).
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

const { providerCredentials } = await import("@hogsend/db");
const { eq, like } = await import("drizzle-orm");
const {
  createApp,
  createHogsendClient,
  getProviderCredential,
  ProviderCredentialDecryptError,
  saveProviderCredential,
} = await import("@hogsend/engine");

const container = createHogsendClient();
const app = createApp(container);
const { db } = container;

const ADMIN_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};

// RUN-namespaced provider ids so cleanup is exact and concurrent runs never
// collide.
const RUN = `pc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const pid = (label: string) => `${RUN}-${label}`;

// The canonical OAuth credential payload (SYNTHESIS §0): ISO expiresAt,
// required refreshToken + clientId, four-scope list, array-typed scoping.
const PAYLOAD = {
  accessToken: "pha_test_access_token_abc123",
  refreshToken: "phr_test_refresh_token_xyz789",
  expiresAt: new Date(Date.now() + 36_000_000).toISOString(),
  tokenEndpoint: "https://eu.posthog.com/oauth/token/",
  clientId: "https://hogsend.com/.well-known/hogsend-posthog-client.json",
  scopes: ["person:read", "person:write", "project:read", "hog_function:write"],
  scopedTeams: [199032],
  scopedOrganizations: ["019026d4-7c0e-0000-92b5-2f697b1e6f23"],
};

afterAll(async () => {
  await db
    .delete(providerCredentials)
    .where(like(providerCredentials.providerId, `${RUN}-%`));
});

async function put(providerId: string, body: Record<string, unknown>) {
  const res = await app.request(
    `/v1/admin/provider-credentials/${providerId}`,
    { method: "PUT", headers: ADMIN_HEADER, body: JSON.stringify(body) },
  );
  return { res, json: await res.json() };
}

function expectNoTokenLeak(json: unknown) {
  const raw = JSON.stringify(json);
  expect(raw).not.toContain(PAYLOAD.accessToken);
  expect(raw).not.toContain(PAYLOAD.refreshToken);
  expect(json).not.toHaveProperty("accessToken");
  expect(json).not.toHaveProperty("refreshToken");
  expect(json).not.toHaveProperty("payload");
}

describe("/v1/admin/provider-credentials", () => {
  it("PUT stores and returns meta only", async () => {
    const { res, json } = await put(pid("create"), { payload: PAYLOAD });
    expect(res.status).toBe(200);

    expect(json.providerId).toBe(pid("create"));
    expect(json.kind).toBe("oauth");
    expect(json.scopes).toEqual(PAYLOAD.scopes);
    expect(json.scopedTeams).toEqual([199032]);
    expect(json.expiresAt).toBe(new Date(PAYLOAD.expiresAt).toISOString());
    expectNoTokenLeak(json);
  });

  it("row is encrypted at rest", async () => {
    const [row] = await db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.providerId, pid("create")))
      .limit(1);

    expect(row).toBeDefined();
    expect(row?.kind).toBe("oauth");
    expect(row?.payload).not.toContain("pha_test");
    expect(row?.payload).not.toContain("phr_test");
    expect(row?.payload).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("PUT is an upsert, not a duplicate", async () => {
    const [before] = await db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.providerId, pid("create")))
      .limit(1);
    expect(before).toBeDefined();

    const { res } = await put(pid("create"), {
      payload: {
        ...PAYLOAD,
        accessToken: "pha_test_access_token_v2_def456",
        scopes: ["person:read"],
      },
    });
    expect(res.status).toBe(200);

    const rows = await db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.providerId, pid("create")));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(before?.id);
    expect(rows[0]?.updatedAt.getTime()).toBeGreaterThanOrEqual(
      rows[0]?.createdAt.getTime() ?? Number.POSITIVE_INFINITY,
    );

    const getRes = await app.request(
      `/v1/admin/provider-credentials/${pid("create")}`,
      { headers: ADMIN_HEADER },
    );
    expect(getRes.status).toBe(200);
    const getJson = await getRes.json();
    expect(getJson.scopes).toEqual(["person:read"]);
  });

  it("GET returns meta, 404 when absent", async () => {
    const res = await app.request(
      `/v1/admin/provider-credentials/${pid("create")}`,
      { headers: ADMIN_HEADER },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.providerId).toBe(pid("create"));
    expect(json.kind).toBe("oauth");
    expect(typeof json.expiresAt).toBe("string");
    expect(typeof json.createdAt).toBe("string");
    expect(typeof json.updatedAt).toBe("string");
    expectNoTokenLeak(json);

    const missing = await app.request(
      `/v1/admin/provider-credentials/${pid("missing")}`,
      { headers: ADMIN_HEADER },
    );
    expect(missing.status).toBe(404);
    const missingJson = await missing.json();
    expect(typeof missingJson.error).toBe("string");
  });

  it("DELETE removes, second DELETE 404s", async () => {
    await put(pid("del"), { payload: PAYLOAD });

    const res = await app.request(
      `/v1/admin/provider-credentials/${pid("del")}`,
      { method: "DELETE", headers: ADMIN_HEADER },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });

    const rows = await db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.providerId, pid("del")));
    expect(rows).toHaveLength(0);

    const again = await app.request(
      `/v1/admin/provider-credentials/${pid("del")}`,
      { method: "DELETE", headers: ADMIN_HEADER },
    );
    expect(again.status).toBe(404);
  });

  it("returns 401 without admin credentials", async () => {
    const res = await app.request(
      `/v1/admin/provider-credentials/${pid("create")}`,
    );
    expect(res.status).toBe(401);
  });

  it("lib round-trip preserves the payload exactly", async () => {
    await saveProviderCredential(db, {
      providerId: pid("lib"),
      payload: PAYLOAD,
    });

    const record = await getProviderCredential(db, pid("lib"));
    expect(record).not.toBeNull();
    expect(record?.payload).toEqual(PAYLOAD);

    const missing = await getProviderCredential(db, pid("lib-missing"));
    expect(missing).toBeNull();
  });

  it("decrypt failure is loud, DELETE still works", async () => {
    await db.insert(providerCredentials).values({
      providerId: pid("garbage"),
      kind: "oauth",
      payload: "bm90LXJlYWwtY2lwaGVydGV4dA",
    });

    await expect(getProviderCredential(db, pid("garbage"))).rejects.toThrow(
      ProviderCredentialDecryptError,
    );

    const res = await app.request(
      `/v1/admin/provider-credentials/${pid("garbage")}`,
      { headers: ADMIN_HEADER },
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toContain("cannot be decrypted");
    expectNoTokenLeak(json);

    // The escape hatch: DELETE never decrypts.
    const del = await app.request(
      `/v1/admin/provider-credentials/${pid("garbage")}`,
      { method: "DELETE", headers: ADMIN_HEADER },
    );
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ deleted: true });
  });

  it("rejects invalid payloads with 400", async () => {
    const badUrl = await put(pid("invalid"), {
      payload: { ...PAYLOAD, tokenEndpoint: "not-a-url" },
    });
    expect(badUrl.res.status).toBe(400);

    const { accessToken: _omitted, ...withoutAccessToken } = PAYLOAD;
    const missingToken = await put(pid("invalid"), {
      payload: withoutAccessToken,
    });
    expect(missingToken.res.status).toBe(400);
  });
});
