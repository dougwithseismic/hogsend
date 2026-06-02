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
    task: vi.fn(() => ({
      run: vi.fn(),
      runNoWait: vi.fn(),
    })),
    events: { push: vi.fn() },
    runs: { cancel: vi.fn(), get: vi.fn() },
    worker: vi.fn(),
  },
}));

vi.mock("../workflows/send-email.js", () => ({
  sendEmailTask: { run: vi.fn(), runNoWait: vi.fn() },
}));

const { emailSends, journeyStates, linkClicks, trackedLinks } = await import(
  "@hogsend/db"
);
const { eq } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");

const container = createHogsendClient();
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
};

const TEST_TEMPLATE = "admin-emails-test-template";
const TEST_JOURNEY = "admin-emails-test-journey";
const TEST_USER = "admin-emails-test-user";

let journeyStateId: string;
let openedEmailId: string;
let plainEmailId: string;
let trackedLinkId: string;
let createdLinkClickIds: string[] = [];

beforeAll(async () => {
  const journeyRows = await db
    .insert(journeyStates)
    .values({
      userId: TEST_USER,
      userEmail: "opened@example.com",
      journeyId: TEST_JOURNEY,
      currentNodeId: "start",
      status: "active",
    })
    .returning({ id: journeyStates.id });
  journeyStateId = journeyRows[0]?.id ?? "";

  const base = new Date("2026-01-01T00:00:00.000Z");

  const openedRows = await db
    .insert(emailSends)
    .values({
      journeyStateId,
      templateKey: TEST_TEMPLATE,
      fromEmail: "from@hogsend.com",
      toEmail: "opened@example.com",
      subject: "Opened test email",
      category: "transactional",
      status: "opened",
      createdAt: base,
      sentAt: new Date(base.getTime() + 1000),
      deliveredAt: new Date(base.getTime() + 2000),
      openedAt: new Date(base.getTime() + 3000),
      clickedAt: new Date(base.getTime() + 4000),
    })
    .returning({ id: emailSends.id });
  openedEmailId = openedRows[0]?.id ?? "";

  const plainRows = await db
    .insert(emailSends)
    .values({
      templateKey: TEST_TEMPLATE,
      fromEmail: "from@hogsend.com",
      toEmail: "plain@example.com",
      subject: "Plain test email",
      status: "sent",
      createdAt: new Date(base.getTime() + 10000),
      sentAt: new Date(base.getTime() + 11000),
    })
    .returning({ id: emailSends.id });
  plainEmailId = plainRows[0]?.id ?? "";

  const linkRows = await db
    .insert(trackedLinks)
    .values({
      emailSendId: openedEmailId,
      originalUrl: "https://example.com/clicked",
      clickCount: 1,
    })
    .returning({ id: trackedLinks.id });
  trackedLinkId = linkRows[0]?.id ?? "";

  const clickRows = await db
    .insert(linkClicks)
    .values({
      trackedLinkId,
      ipAddress: "9.9.9.9",
      userAgent: "TestAgent/1.0",
      clickedAt: new Date(base.getTime() + 4000),
    })
    .returning({ id: linkClicks.id });
  createdLinkClickIds = clickRows.map((r) => r.id);
});

afterAll(async () => {
  for (const id of createdLinkClickIds) {
    await db.delete(linkClicks).where(eq(linkClicks.id, id));
  }
  if (trackedLinkId) {
    await db.delete(trackedLinks).where(eq(trackedLinks.id, trackedLinkId));
  }
  if (openedEmailId) {
    await db.delete(emailSends).where(eq(emailSends.id, openedEmailId));
  }
  if (plainEmailId) {
    await db.delete(emailSends).where(eq(emailSends.id, plainEmailId));
  }
  if (journeyStateId) {
    await db.delete(journeyStates).where(eq(journeyStates.id, journeyStateId));
  }
});

// --- List ---

describe("GET /v1/admin/emails", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request("/v1/admin/emails");
    expect(res.status).toBe(401);
  });

  it("returns paginated email list with identity fields", async () => {
    const res = await app.request("/v1/admin/emails?limit=100", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.emails).toBeInstanceOf(Array);
    expect(typeof body.total).toBe("number");
    expect(typeof body.limit).toBe("number");
    expect(typeof body.offset).toBe("number");

    const opened = body.emails.find(
      (e: { id: string }) => e.id === openedEmailId,
    );
    expect(opened).toBeDefined();
    expect(opened.userId).toBe(TEST_USER);
    expect(opened.journeyId).toBe(TEST_JOURNEY);

    const plain = body.emails.find(
      (e: { id: string }) => e.id === plainEmailId,
    );
    expect(plain).toBeDefined();
    expect(plain.userId).toBeNull();
    expect(plain.journeyId).toBeNull();
  });

  it("filters by engagement=opened (isNotNull openedAt)", async () => {
    const res = await app.request(
      `/v1/admin/emails?limit=100&templateKey=${TEST_TEMPLATE}&engagement=opened`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    const ids = body.emails.map((e: { id: string }) => e.id);
    expect(ids).toContain(openedEmailId);
    expect(ids).not.toContain(plainEmailId);
  });

  it("filters by journeyId via the joined journey_states columns", async () => {
    const res = await app.request(
      `/v1/admin/emails?limit=100&journeyId=${TEST_JOURNEY}`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    const ids = body.emails.map((e: { id: string }) => e.id);
    expect(ids).toContain(openedEmailId);
    expect(ids).not.toContain(plainEmailId);
  });

  it("filters by userId via the joined journey_states columns", async () => {
    const res = await app.request(
      `/v1/admin/emails?limit=100&userId=${TEST_USER}`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    const ids = body.emails.map((e: { id: string }) => e.id);
    expect(ids).toContain(openedEmailId);
    expect(ids).not.toContain(plainEmailId);
  });

  it("filters by category", async () => {
    const res = await app.request(
      "/v1/admin/emails?limit=100&category=transactional",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    const ids = body.emails.map((e: { id: string }) => e.id);
    expect(ids).toContain(openedEmailId);
    expect(ids).not.toContain(plainEmailId);
  });

  it("orders by createdAt asc/desc (sort + order applied)", async () => {
    // opened row created before plain row, so asc => opened precedes plain,
    // desc => plain precedes opened.
    const ascRes = await app.request(
      "/v1/admin/emails?limit=100&sort=createdAt&order=asc",
      { headers: AUTH_HEADER },
    );
    const asc = await ascRes.json();
    const ascIds = asc.emails.map((e: { id: string }) => e.id);
    expect(ascIds.indexOf(openedEmailId)).toBeLessThan(
      ascIds.indexOf(plainEmailId),
    );

    const descRes = await app.request(
      "/v1/admin/emails?limit=100&sort=createdAt&order=desc",
      { headers: AUTH_HEADER },
    );
    const desc = await descRes.json();
    const descIds = desc.emails.map((e: { id: string }) => e.id);
    expect(descIds.indexOf(plainEmailId)).toBeLessThan(
      descIds.indexOf(openedEmailId),
    );
  });
});

// --- Detail ---

describe("GET /v1/admin/emails/{id}", () => {
  it("returns 404 for unknown id", async () => {
    const res = await app.request(
      "/v1/admin/emails/00000000-0000-0000-0000-000000000000",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(404);
  });

  it("returns detail shape with chronological events including a click", async () => {
    const res = await app.request(`/v1/admin/emails/${openedEmailId}`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.email.id).toBe(openedEmailId);
    expect(body.email.userId).toBe(TEST_USER);
    expect(body.email.journeyId).toBe(TEST_JOURNEY);
    expect(body.trackedLinks).toBeInstanceOf(Array);
    expect(body.events).toBeInstanceOf(Array);

    const types = body.events.map((e: { type: string }) => e.type);
    expect(types).toContain("queued");
    expect(types).toContain("sent");
    expect(types).toContain("delivered");
    expect(types).toContain("opened");
    expect(types).toContain("clicked");

    const clicked = body.events.find(
      (e: { type: string }) => e.type === "clicked",
    );
    expect(clicked.url).toBe("https://example.com/clicked");
    expect(clicked.ipAddress).toBe("9.9.9.9");
    expect(clicked.userAgent).toBe("TestAgent/1.0");

    const timestamps = body.events.map((e: { timestamp: string }) =>
      new Date(e.timestamp).getTime(),
    );
    const sorted = [...timestamps].sort((a, b) => a - b);
    expect(timestamps).toEqual(sorted);
  });
});
