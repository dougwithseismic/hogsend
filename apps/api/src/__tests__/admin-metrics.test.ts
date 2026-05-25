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

const { createApp } = await import("../app.js");
const { createContainer } = await import("../container.js");

const container = createContainer();
const app = createApp(container);

const AUTH_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
};

// --- Overview ---

describe("GET /v1/admin/metrics/overview", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request("/v1/admin/metrics/overview");
    expect(res.status).toBe(401);
  });

  it("returns system-wide metrics", async () => {
    const res = await app.request("/v1/admin/metrics/overview", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(typeof body.totalContacts).toBe("number");
    expect(typeof body.activeJourneys).toBe("number");
    expect(typeof body.emailsSent24h).toBe("number");
    expect(typeof body.emailsSent7d).toBe("number");
    expect(typeof body.emailsSent30d).toBe("number");
    expect(typeof body.bounceRate30d).toBe("number");
    expect(typeof body.unsubscribeRate).toBe("number");
  });
});

// --- Journey Metrics ---

describe("GET /v1/admin/metrics/journeys", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request("/v1/admin/metrics/journeys");
    expect(res.status).toBe(401);
  });

  it("returns per-journey metrics", async () => {
    const res = await app.request("/v1/admin/metrics/journeys", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.journeys).toBeInstanceOf(Array);
    for (const j of body.journeys) {
      expect(typeof j.journeyId).toBe("string");
      expect(typeof j.name).toBe("string");
      expect(typeof j.enrolled).toBe("number");
      expect(typeof j.completed).toBe("number");
      expect(typeof j.failed).toBe("number");
      expect(typeof j.exited).toBe("number");
      expect(typeof j.active).toBe("number");
      expect(typeof j.completionRate).toBe("number");
    }
  });
});

// --- Journey Funnel ---

describe("GET /v1/admin/metrics/journeys/:id", () => {
  it("returns 404 for nonexistent journey", async () => {
    const res = await app.request(
      "/v1/admin/metrics/journeys/nonexistent-journey",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(404);
  });
});

// --- Email Metrics ---

describe("GET /v1/admin/metrics/emails", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request("/v1/admin/metrics/emails");
    expect(res.status).toBe(401);
  });

  it("returns per-template metrics", async () => {
    const res = await app.request("/v1/admin/metrics/emails", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.templates).toBeInstanceOf(Array);
  });
});

// --- Deliverability ---

describe("GET /v1/admin/metrics/emails/deliverability", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request("/v1/admin/metrics/emails/deliverability");
    expect(res.status).toBe(401);
  });

  it("returns time-series deliverability data", async () => {
    const res = await app.request("/v1/admin/metrics/emails/deliverability", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.points).toBeInstanceOf(Array);
  });

  it("supports period parameter", async () => {
    const res = await app.request(
      "/v1/admin/metrics/emails/deliverability?period=week",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.points).toBeInstanceOf(Array);
  });
});

// --- Event Volume ---

describe("GET /v1/admin/metrics/events", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request("/v1/admin/metrics/events");
    expect(res.status).toBe(401);
  });

  it("returns event volume data", async () => {
    const res = await app.request("/v1/admin/metrics/events", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.events).toBeInstanceOf(Array);
  });

  it("supports granularity parameter", async () => {
    const res = await app.request("/v1/admin/metrics/events?granularity=hour", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.events).toBeInstanceOf(Array);
  });
});
