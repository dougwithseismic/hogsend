/**
 * API key management end to end through the admin routes: mint a secret key
 * and a publishable key, use each where it belongs, expire, revoke, and rotate
 * (`POST /v1/admin/api-keys/:id/rotate`). Every key is minted over HTTP with
 * the legacy ADMIN_API_KEY, the bootstrap path the docs describe, and probed
 * on `GET /v1/lists` (behind `requirePublishableOrIngest`, no writes).
 */
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { apiKeys } = await import("@hogsend/db");
const { eq, like } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");
const { countQueries } = await import("./query-counter.js");

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
const { db, dbClient } = container;

const RUN = `akl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ORIGIN = "https://keys-lifecycle.example.com";
const ADMIN = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
  "Content-Type": "application/json",
};

type Minted = {
  id: string;
  name: string;
  key: string;
  keyPrefix: string;
  scopes: string[];
  allowedOrigins: string[] | null;
  expiresAt: string | null;
};
type Rotated = Minted & { rotatedFrom: { id: string; expiresAt: string } };

async function mint(body: Record<string, unknown>): Promise<Minted> {
  const res = await app.request("/v1/admin/api-keys", {
    method: "POST",
    headers: ADMIN,
    body: JSON.stringify({ ...body, name: `${RUN} ${body.name ?? "key"}` }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Minted;
}

async function rotate(
  id: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  return app.request(`/v1/admin/api-keys/${id}/rotate`, {
    method: "POST",
    headers: body
      ? ADMIN
      : { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Probe a key on a browser-reachable ingest route (no writes). */
async function probe(key: string, origin?: string): Promise<number> {
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (origin) headers.Origin = origin;
  const res = await app.request("/v1/lists", { headers });
  return res.status;
}

afterAll(async () => {
  await db.delete(apiKeys).where(like(apiKeys.name, `${RUN}%`));
});

describe("secret vs publishable keys", () => {
  it("mints a secret hsk_ key that works server-side with no Origin", async () => {
    const k = await mint({ name: "secret", scopes: ["ingest"] });
    expect(k.key.startsWith("hsk_")).toBe(true);
    expect(k.keyPrefix).toBe(k.key.slice(0, 8));
    expect(k.scopes).toEqual(["ingest"]);
    expect(k.allowedOrigins).toBeNull();
    expect(await probe(k.key)).toBe(200);
  });

  it("mints a publishable pk_ key with its scope forced to ingest-public", async () => {
    const k = await mint({
      name: "publishable",
      publishable: true,
      // Submitted scopes are ignored for a publishable key.
      scopes: ["full-admin"],
      allowedOrigins: [ORIGIN],
    });
    expect(k.key.startsWith("pk_")).toBe(true);
    expect(k.scopes).toEqual(["ingest-public"]);
    expect(k.allowedOrigins).toEqual([ORIGIN]);

    expect(await probe(k.key, ORIGIN)).toBe(200);
    // Fail-closed Origin allowlist.
    expect(await probe(k.key)).toBe(403);
    expect(await probe(k.key, "https://elsewhere.example.com")).toBe(403);
    // A publishable key never reaches the admin plane or secret-only routes.
    const admin = await app.request("/v1/admin/api-keys", {
      headers: { Authorization: `Bearer ${k.key}`, Origin: ORIGIN },
    });
    expect(admin.status).toBe(403);
  });

  it("reads a publishable key once, then serves it from the auth cache", async () => {
    const k = await mint({
      name: "cached publishable",
      publishable: true,
      allowedOrigins: [ORIGIN],
    });
    const first = await countQueries(dbClient, () => probe(k.key, ORIGIN));
    expect(first.result).toBe(200);
    const touchesKeys = (statements: { sql: string }[]) =>
      statements.filter((st) => /"api_keys"/.test(st.sql));
    // A cold key: one read, plus the debounced lastUsedAt write.
    expect(touchesKeys(first.statements)).toHaveLength(2);

    const second = await countQueries(dbClient, () => probe(k.key, ORIGIN));
    expect(second.result).toBe(200);
    expect(touchesKeys(second.statements)).toHaveLength(0);
  });

  it("refuses a publishable key with no allowedOrigins", async () => {
    const res = await app.request("/v1/admin/api-keys", {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ name: `${RUN} no-origins`, publishable: true }),
    });
    expect(res.status).toBe(400);
  });

  it("an ingest key cannot manage keys", async () => {
    const k = await mint({ name: "ingest-no-admin", scopes: ["ingest"] });
    const res = await app.request("/v1/admin/api-keys", {
      headers: { Authorization: `Bearer ${k.key}` },
    });
    expect(res.status).toBe(403);
  });
});

describe("expiry and revocation", () => {
  it("rejects a key past its expiresAt", async () => {
    const k = await mint({
      name: "expired",
      scopes: ["ingest"],
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(await probe(k.key)).toBe(401);
  });

  it("revocation takes effect at once on the instance that served it", async () => {
    const k = await mint({ name: "revoked", scopes: ["ingest"] });
    // Warm the 60s auth cache, then revoke.
    expect(await probe(k.key)).toBe(200);
    const del = await app.request(`/v1/admin/api-keys/${k.id}`, {
      method: "DELETE",
      headers: ADMIN,
    });
    expect(del.status).toBe(200);
    expect(await probe(k.key)).toBe(401);
  });
});

describe("POST /v1/admin/api-keys/:id/rotate", () => {
  it("mints a same-shape replacement and gives the old key a 24h grace by default", async () => {
    const old = await mint({
      name: "rotate-secret",
      scopes: ["read", "ingest"],
    });
    expect(await probe(old.key)).toBe(200);

    const before = Date.now();
    const res = await rotate(old.id);
    expect(res.status).toBe(201);
    const next = (await res.json()) as Rotated;

    expect(next.id).not.toBe(old.id);
    expect(next.key).not.toBe(old.key);
    expect(next.key.startsWith("hsk_")).toBe(true);
    expect(next.name).toBe(old.name);
    expect(next.scopes).toEqual(["read", "ingest"]);
    expect(next.allowedOrigins).toBeNull();
    expect(next.expiresAt).toBeNull();
    expect(next.rotatedFrom.id).toBe(old.id);

    const graceEnd = new Date(next.rotatedFrom.expiresAt).getTime();
    const day = 24 * 60 * 60 * 1000;
    expect(graceEnd).toBeGreaterThanOrEqual(before + day - 1000);
    expect(graceEnd).toBeLessThanOrEqual(Date.now() + day + 1000);

    // Both work during the grace period.
    expect(await probe(next.key)).toBe(200);
    expect(await probe(old.key)).toBe(200);

    const [row] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, old.id))
      .limit(1);
    expect(row?.revokedAt).toBeNull();
    expect(row?.expiresAt?.toISOString()).toBe(next.rotatedFrom.expiresAt);
  });

  it("gracePeriodSeconds: 0 retires the old key immediately", async () => {
    const old = await mint({ name: "rotate-now", scopes: ["ingest"] });
    // Warm the auth cache so the test also covers the eviction.
    expect(await probe(old.key)).toBe(200);
    const res = await rotate(old.id, { gracePeriodSeconds: 0 });
    expect(res.status).toBe(201);
    const next = (await res.json()) as Rotated;
    await new Promise((r) => setTimeout(r, 5));
    expect(await probe(old.key)).toBe(401);
    expect(await probe(next.key)).toBe(200);
  });

  it("rotates a publishable key into a publishable key with the same allowlist", async () => {
    const old = await mint({
      name: "rotate-pk",
      publishable: true,
      allowedOrigins: [ORIGIN],
    });
    const res = await rotate(old.id, { gracePeriodSeconds: 3600 });
    expect(res.status).toBe(201);
    const next = (await res.json()) as Rotated;
    expect(next.key.startsWith("pk_")).toBe(true);
    expect(next.scopes).toEqual(["ingest-public"]);
    expect(next.allowedOrigins).toEqual([ORIGIN]);
    expect(await probe(next.key, ORIGIN)).toBe(200);
    expect(await probe(next.key)).toBe(403);
    expect(await probe(old.key, ORIGIN)).toBe(200);
  });

  it("never extends an earlier expiry on the old key", async () => {
    const soon = new Date(Date.now() + 10 * 60_000);
    const old = await mint({
      name: "rotate-soon",
      scopes: ["ingest"],
      expiresAt: soon.toISOString(),
    });
    const res = await rotate(old.id, { gracePeriodSeconds: 86_400 });
    expect(res.status).toBe(201);
    const next = (await res.json()) as Rotated;
    expect(new Date(next.rotatedFrom.expiresAt).getTime()).toBe(soon.getTime());
  });

  it("sets an expiry on the replacement when asked", async () => {
    const old = await mint({ name: "rotate-expiring", scopes: ["ingest"] });
    const until = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    const res = await rotate(old.id, { expiresAt: until.toISOString() });
    expect(res.status).toBe(201);
    const next = (await res.json()) as Rotated;
    expect(next.expiresAt).toBe(until.toISOString());
  });

  it("404s an unknown or revoked key", async () => {
    const unknown = await rotate("00000000-0000-4000-8000-000000000000");
    expect(unknown.status).toBe(404);

    const k = await mint({ name: "rotate-revoked", scopes: ["ingest"] });
    await app.request(`/v1/admin/api-keys/${k.id}`, {
      method: "DELETE",
      headers: ADMIN,
    });
    expect((await rotate(k.id)).status).toBe(404);
  });

  it("rejects an out-of-range grace period", async () => {
    const k = await mint({ name: "rotate-bad-grace", scopes: ["ingest"] });
    const res = await rotate(k.id, { gracePeriodSeconds: -1 });
    expect(res.status).toBe(400);
    const tooLong = await rotate(k.id, {
      gracePeriodSeconds: 31 * 24 * 60 * 60,
    });
    expect(tooLong.status).toBe(400);
  });

  it("requires full-admin", async () => {
    const k = await mint({ name: "rotate-target", scopes: ["ingest"] });
    const res = await app.request(`/v1/admin/api-keys/${k.id}/rotate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${k.key}` },
    });
    expect(res.status).toBe(403);
  });
});
