import { describe, expect, it, vi } from "vitest";

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
    runs: {
      cancel: vi.fn(),
      get: vi.fn(),
    },
    worker: vi.fn(),
  },
}));

vi.mock("../workflows/send-email.js", () => ({
  sendEmailTask: {
    run: vi.fn(),
    runNoWait: vi.fn(),
  },
}));

const { createApp, createHogsendClient } = await import("@hogsend/engine");

const container = createHogsendClient();
const app = createApp(container);

const AUTH_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
};

// --- Events ---

describe("GET /v1/admin/events", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request("/v1/admin/events");
    expect(res.status).toBe(401);
  });

  it("returns paginated event list", async () => {
    const res = await app.request("/v1/admin/events", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.events).toBeInstanceOf(Array);
    expect(typeof body.total).toBe("number");
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  it("supports pagination", async () => {
    const res = await app.request("/v1/admin/events?limit=5&offset=0", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.events.length).toBeLessThanOrEqual(5);
    expect(body.limit).toBe(5);
    expect(body.offset).toBe(0);
  });

  it("filters by event name", async () => {
    const res = await app.request(
      "/v1/admin/events?event=nonexistent-event-name",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.events).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("filters by userId", async () => {
    const res = await app.request(
      "/v1/admin/events?userId=nonexistent-user-id",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.events).toEqual([]);
    expect(body.total).toBe(0);
  });
});

describe("GET /v1/admin/events/:id", () => {
  it("returns 404 for nonexistent event", async () => {
    const res = await app.request(
      "/v1/admin/events/00000000-0000-0000-0000-000000000000",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(404);
  });
});

// --- Emails ---

describe("GET /v1/admin/emails", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request("/v1/admin/emails");
    expect(res.status).toBe(401);
  });

  it("returns paginated email list", async () => {
    const res = await app.request("/v1/admin/emails", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.emails).toBeInstanceOf(Array);
    expect(typeof body.total).toBe("number");
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  it("supports pagination", async () => {
    const res = await app.request("/v1/admin/emails?limit=3&offset=0", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.emails.length).toBeLessThanOrEqual(3);
    expect(body.limit).toBe(3);
    expect(body.offset).toBe(0);
  });

  it("filters by status", async () => {
    const res = await app.request("/v1/admin/emails?status=bounced", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    for (const email of body.emails) {
      expect(email.status).toBe("bounced");
    }
  });

  it("filters by templateKey", async () => {
    const res = await app.request(
      "/v1/admin/emails?templateKey=nonexistent-template",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.emails).toEqual([]);
    expect(body.total).toBe(0);
  });
});

describe("GET /v1/admin/emails/:id", () => {
  it("returns 404 for nonexistent email", async () => {
    const res = await app.request(
      "/v1/admin/emails/00000000-0000-0000-0000-000000000000",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(404);
  });
});

// --- Journey Logs ---

describe("GET /v1/admin/journey-logs/:stateId", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request(
      "/v1/admin/journey-logs/00000000-0000-0000-0000-000000000000",
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 for nonexistent state", async () => {
    const res = await app.request(
      "/v1/admin/journey-logs/00000000-0000-0000-0000-000000000000",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(404);
  });
});

// --- Timeline ---

describe("GET /v1/admin/contacts/:id/timeline", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request("/v1/admin/contacts/some-id/timeline");
    expect(res.status).toBe(401);
  });

  it("returns 404 for nonexistent contact", async () => {
    const res = await app.request(
      "/v1/admin/contacts/nonexistent-contact/timeline",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(404);
  });
});
