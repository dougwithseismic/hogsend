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

const { contacts, emailSends } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");

const container = createHogsendClient();
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

const TEST_TEMPLATE = "admin-reporting-test-template";
const TEST_USER = "admin-reporting-test-user";
const TEST_EMAIL = "reporting@example.com";

let sendAId: string;
let sendBId: string;

beforeAll(async () => {
  await db
    .insert(contacts)
    .values({ externalId: TEST_USER, email: TEST_EMAIL })
    .onConflictDoNothing();

  const day1 = new Date("2026-02-01T00:00:00.000Z");
  const day2 = new Date("2026-02-02T00:00:00.000Z");

  const a = await db
    .insert(emailSends)
    .values({
      templateKey: TEST_TEMPLATE,
      fromEmail: "from@hogsend.com",
      toEmail: TEST_EMAIL,
      userId: TEST_USER,
      userEmail: TEST_EMAIL,
      subject: "Reporting test A",
      status: "opened",
      createdAt: day1,
      sentAt: new Date(day1.getTime() + 1000),
      deliveredAt: new Date(day1.getTime() + 2000),
      openedAt: new Date(day1.getTime() + 3000),
      clickedAt: new Date(day1.getTime() + 4000),
    })
    .returning({ id: emailSends.id });
  sendAId = a[0]?.id ?? "";

  const b = await db
    .insert(emailSends)
    .values({
      templateKey: TEST_TEMPLATE,
      fromEmail: "from@hogsend.com",
      toEmail: TEST_EMAIL,
      userId: TEST_USER,
      userEmail: TEST_EMAIL,
      subject: "Reporting test B",
      status: "delivered",
      createdAt: day2,
      sentAt: new Date(day2.getTime() + 1000),
      deliveredAt: new Date(day2.getTime() + 2000),
    })
    .returning({ id: emailSends.id });
  sendBId = b[0]?.id ?? "";
});

afterAll(async () => {
  if (sendAId) await db.delete(emailSends).where(eq(emailSends.id, sendAId));
  if (sendBId) await db.delete(emailSends).where(eq(emailSends.id, sendBId));
  await db.delete(contacts).where(eq(contacts.externalId, TEST_USER));
});

describe("GET /v1/admin/reporting/templates/{templateKey}", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request(
      `/v1/admin/reporting/templates/${TEST_TEMPLATE}`,
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 for a template that has never sent", async () => {
    const res = await app.request(
      "/v1/admin/reporting/templates/never-sent-template-xyz",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(404);
  });

  it("returns windowed totals + a daily series", async () => {
    const res = await app.request(
      `/v1/admin/reporting/templates/${TEST_TEMPLATE}?granularity=day`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.templateKey).toBe(TEST_TEMPLATE);
    expect(body.totals.sent).toBe(2);
    expect(body.totals.delivered).toBe(2);
    expect(body.totals.opened).toBe(1);
    expect(body.totals.clicked).toBe(1);
    // clicks / delivered = 1 / 2
    expect(body.totals.clickToDeliveryRate).toBe(0.5);
    // opens / delivered = 1 / 2
    expect(body.totals.openRate).toBe(0.5);
    expect(body.series).toBeInstanceOf(Array);
    // two distinct days seeded
    expect(body.series.length).toBeGreaterThanOrEqual(2);
  });
});

describe("GET /v1/admin/reporting/contacts/{id}/activity", () => {
  it("returns 404 for an unknown contact", async () => {
    const res = await app.request(
      "/v1/admin/reporting/contacts/no-such-contact/activity",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(404);
  });

  it("returns the contact's email sends", async () => {
    const res = await app.request(
      `/v1/admin/reporting/contacts/${TEST_USER}/activity?limit=100`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.contact.externalId).toBe(TEST_USER);
    expect(body.contact.email).toBe(TEST_EMAIL);
    const ids = body.sends.map((s: { id: string }) => s.id);
    expect(ids).toContain(sendAId);
    expect(ids).toContain(sendBId);
  });
});

describe("GET /v1/admin/reporting/sends/export", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request("/v1/admin/reporting/sends/export");
    expect(res.status).toBe(401);
  });

  it("returns CSV of filtered sends as an attachment", async () => {
    const res = await app.request(
      `/v1/admin/reporting/sends/export?templateKey=${TEST_TEMPLATE}`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");

    const text = await res.text();
    const lines = text.split("\n");
    expect(lines[0]).toContain("id,createdAt,templateKey");
    expect(text).toContain(sendAId);
    expect(text).toContain(sendBId);
  });
});
