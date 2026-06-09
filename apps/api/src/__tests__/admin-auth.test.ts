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

// --- Closed signup (public sign-up disabled at the better-auth layer) ---

describe("closed signup", () => {
  it("blocks sign-up for everyone (no unauthenticated path creates a user)", async () => {
    // No setup-token gate any more: the now-ungated POST is rejected by
    // better-auth itself (`disableSignUp`) with 400
    // EMAIL_PASSWORD_SIGN_UP_DISABLED, regardless of whether a user exists.
    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "second-user@admin-auth-test.example",
        password: "supersecret123",
        name: "Second User",
      }),
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(
      "EMAIL_PASSWORD_SIGN_UP_DISABLED",
    );
  });

  it("stays closed even when a stray setup-token header is presented", async () => {
    // The setup token is gone — a presented header must not re-open the door.
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

    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(
      "EMAIL_PASSWORD_SIGN_UP_DISABLED",
    );
  });
});
