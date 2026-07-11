/**
 * GET /v1/admin/api-keys/self — the credential-identity probe (Phase 1 of
 * the @hogsend/mcp plan: the report tool's "you are calling as X" read).
 * Proves both requireAdmin paths surface the identity they resolved: a
 * Bearer API key echoes id/name/scopes and NEVER the key material, a
 * session cookie echoes the signed-in admin's email, and an
 * unauthenticated request never reaches the handler.
 */
import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { apiKeys, user } = await import("@hogsend/db");
const { eq, like } = await import("drizzle-orm");
const { createAdminUser, createApp, createHogsendClient } = await import(
  "@hogsend/engine"
);

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
} as unknown as HogsendClient["hatchet"];

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };
const JSON_HEADERS = { ...AUTH_HEADER, "Content-Type": "application/json" };

// Run-scoped prefix so parallel test files against the shared docker DB
// never collide; everything created here is swept in afterAll.
const RUN = `aks-${Date.now()}`;
const SESSION_EMAIL = `${RUN}@api-keys-self-test.example`;
const SESSION_PASSWORD = "selfTestPassword123";

afterAll(async () => {
  await db.delete(apiKeys).where(like(apiKeys.name, `${RUN}%`));
  // Sessions cascade on user delete (auth schema onDelete: "cascade").
  await db.delete(user).where(eq(user.email, SESSION_EMAIL));
});

describe("GET /v1/admin/api-keys/self", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await app.request("/v1/admin/api-keys/self");
    expect(res.status).toBe(401);
  });

  it("identifies the legacy env key (ADMIN_API_KEY path)", async () => {
    const res = await app.request("/v1/admin/api-keys/self", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      actor: "api-key",
      id: "legacy",
      name: "legacy",
      scopes: ["full-admin"],
    });
  });

  it("identifies a DB-backed key by id/name/scopes and never returns key material", async () => {
    const minted = await app.request("/v1/admin/api-keys", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: `${RUN}-mcp`, scopes: ["full-admin"] }),
    });
    expect(minted.status).toBe(201);
    const created = await minted.json();

    const res = await app.request("/v1/admin/api-keys/self", {
      headers: { Authorization: `Bearer ${created.key}` },
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(JSON.parse(raw)).toEqual({
      actor: "api-key",
      id: created.id,
      name: `${RUN}-mcp`,
      scopes: ["full-admin"],
    });
    // Identity only — neither the secret nor even its prefix may appear.
    expect(raw).not.toContain(created.key);
    expect(raw).not.toContain(created.keyPrefix);
  });

  it("is behind the admin scope gate — a read-scoped key is rejected", async () => {
    const minted = await app.request("/v1/admin/api-keys", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: `${RUN}-read`, scopes: ["read"] }),
    });
    expect(minted.status).toBe(201);
    const created = await minted.json();

    const res = await app.request("/v1/admin/api-keys/self", {
      headers: { Authorization: `Bearer ${created.key}` },
    });
    expect(res.status).toBe(403);
  });

  it("identifies a session (cookie path) by email", async () => {
    // Public sign-up is disabled — seed via the same internal-adapter path
    // the CLI / env bootstrap use, then sign in for a real session cookie.
    await createAdminUser({
      auth: container.auth,
      email: SESSION_EMAIL,
      name: "Self Test Admin",
      password: SESSION_PASSWORD,
    });

    const signIn = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: SESSION_EMAIL,
        password: SESSION_PASSWORD,
      }),
    });
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(cookie).toBeTruthy();

    const res = await app.request("/v1/admin/api-keys/self", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      actor: "session",
      email: SESSION_EMAIL,
    });
  });
});
