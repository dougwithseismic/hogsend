import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

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

vi.mock("../workflows/send-email.js", () => ({
  sendEmailTask: { run: vi.fn(), runNoWait: vi.fn() },
}));

const { user } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");

const container = createHogsendClient();
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

const TEST_USER_ID = "admin-auth-test-user";

afterAll(async () => {
  await db.delete(user).where(eq(user.id, TEST_USER_ID));
});

// --- Bootstrap probe ---

describe("GET /v1/auth/status", () => {
  it("is public and reports whether setup is needed", async () => {
    const res = await app.request("/v1/auth/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.needsSetup).toBe("boolean");
  });
});

// --- Auth bridge on /v1/admin/* ---

describe("requireAdmin on /v1/admin/*", () => {
  it("rejects requests with neither a key nor a session", async () => {
    const res = await app.request("/v1/admin/metrics/overview");
    expect(res.status).toBe(401);
  });

  it("accepts a valid API key (CLI path)", async () => {
    const res = await app.request("/v1/admin/metrics/overview", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
  });

  it("rejects an invalid API key", async () => {
    const res = await app.request("/v1/admin/metrics/overview", {
      headers: { Authorization: "Bearer not-a-real-key" },
    });
    expect(res.status).toBe(401);
  });
});

// --- Closed signup ---

describe("closed signup", () => {
  it("blocks sign-up once a user exists", async () => {
    await db
      .insert(user)
      .values({
        id: TEST_USER_ID,
        name: "Existing Admin",
        email: "existing-admin@admin-auth-test.example",
      })
      .onConflictDoNothing();

    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "second-user@admin-auth-test.example",
        password: "supersecret123",
        name: "Second User",
      }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("closed");
  });

  it("stays closed even when a setup token is presented", async () => {
    await db
      .insert(user)
      .values({
        id: TEST_USER_ID,
        name: "Existing Admin",
        email: "existing-admin@admin-auth-test.example",
      })
      .onConflictDoNothing();

    // Once an admin exists, the setup token is irrelevant: the closed-signup
    // 403 takes over. A presented token must not re-open the door.
    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hogsend-setup-token": "any-token-should-not-matter",
      },
      body: JSON.stringify({
        email: "third-user@admin-auth-test.example",
        password: "supersecret123",
        name: "Third User",
      }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("closed");
  });
});
