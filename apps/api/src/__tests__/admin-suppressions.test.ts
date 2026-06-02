import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

const { emailPreferences } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");

const container = createHogsendClient();
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

const BOUNCED_USER = "admin-suppressions-bounced-user";
const BOUNCED_EMAIL = "bounced@suppressions.example.com";
const UNSUB_USER = "admin-suppressions-unsub-user";
const UNSUB_EMAIL = "unsub@suppressions.example.com";
const COMPLAINED_USER = "admin-suppressions-complained-user";
const COMPLAINED_EMAIL = "complained@suppressions.example.com";

const ALL_USERS = [BOUNCED_USER, UNSUB_USER, COMPLAINED_USER];

beforeAll(async () => {
  await db
    .insert(emailPreferences)
    .values([
      {
        userId: BOUNCED_USER,
        email: BOUNCED_EMAIL,
        bounceCount: 2,
        suppressed: false,
        unsubscribedAll: false,
        lastBounceAt: new Date(),
      },
      {
        userId: UNSUB_USER,
        email: UNSUB_EMAIL,
        bounceCount: 0,
        suppressed: false,
        unsubscribedAll: true,
      },
      {
        userId: COMPLAINED_USER,
        email: COMPLAINED_EMAIL,
        bounceCount: 0,
        suppressed: true,
        unsubscribedAll: false,
        suppressedAt: new Date(),
      },
    ])
    .onConflictDoNothing();
});

afterAll(async () => {
  for (const userId of ALL_USERS) {
    await db
      .delete(emailPreferences)
      .where(eq(emailPreferences.userId, userId));
  }
});

describe("GET /v1/admin/suppressions", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request("/v1/admin/suppressions");
    expect(res.status).toBe(401);
  });

  it("returns the suppression list shape", async () => {
    const res = await app.request("/v1/admin/suppressions?limit=200", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.suppressions).toBeInstanceOf(Array);
    expect(typeof body.total).toBe("number");
    expect(body.limit).toBe(200);
    expect(body.offset).toBe(0);

    const sample = body.suppressions[0];
    expect(sample).toHaveProperty("id");
    expect(sample).toHaveProperty("userId");
    expect(sample).toHaveProperty("email");
    expect(sample).toHaveProperty("unsubscribedAll");
    expect(sample).toHaveProperty("suppressed");
    expect(sample).toHaveProperty("bounceCount");
  });

  it("filters to bounced recipients", async () => {
    const res = await app.request(
      "/v1/admin/suppressions?type=bounced&limit=200",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    const emails = body.suppressions.map((s: { email: string }) => s.email);
    expect(emails).toContain(BOUNCED_EMAIL);
    expect(emails).not.toContain(UNSUB_EMAIL);
    expect(emails).not.toContain(COMPLAINED_EMAIL);
    for (const row of body.suppressions) {
      expect(row.bounceCount).toBeGreaterThan(0);
    }
  });

  it("filters to unsubscribed recipients", async () => {
    const res = await app.request(
      "/v1/admin/suppressions?type=unsubscribed&limit=200",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    const emails = body.suppressions.map((s: { email: string }) => s.email);
    expect(emails).toContain(UNSUB_EMAIL);
    expect(emails).not.toContain(BOUNCED_EMAIL);
    for (const row of body.suppressions) {
      expect(row.unsubscribedAll).toBe(true);
    }
  });

  it("filters to complained recipients", async () => {
    const res = await app.request(
      "/v1/admin/suppressions?type=complained&limit=200",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    const emails = body.suppressions.map((s: { email: string }) => s.email);
    expect(emails).toContain(COMPLAINED_EMAIL);
    expect(emails).not.toContain(BOUNCED_EMAIL);
    for (const row of body.suppressions) {
      expect(row.suppressed).toBe(true);
      expect(row.bounceCount).toBe(0);
    }
  });
});
