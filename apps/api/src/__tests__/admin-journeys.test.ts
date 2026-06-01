import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { createApp, createHogsendClient } = await import("@hogsend/engine");
const { journeys } = await import("../journeys/index.js");

// Hatchet now lives inside @hogsend/engine, so it is injected via the container
// override seam rather than module-mocked. This keeps the enroll endpoint from
// reaching for a real Hatchet connection during the test.
const mockHatchet = {
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
} as unknown as HogsendClient["hatchet"];

const container = createHogsendClient({
  journeys,
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);

const AUTH_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
};

describe("GET /v1/admin/journeys", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request("/v1/admin/journeys");
    expect(res.status).toBe(401);
  });

  it("lists all registered journeys", async () => {
    const res = await app.request("/v1/admin/journeys", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.journeys).toBeInstanceOf(Array);
    expect(body.journeys.length).toBeGreaterThan(0);
    expect(body.total).toBeGreaterThan(0);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);

    const journey = body.journeys[0];
    expect(journey.id).toBeTruthy();
    expect(journey.name).toBeTruthy();
    expect(journey.trigger.event).toBeTruthy();
    expect(journey.entryLimit).toBeTruthy();
    expect(journey.counts).toBeDefined();
    expect(typeof journey.counts.active).toBe("number");
    expect(typeof journey.counts.completed).toBe("number");
  });

  it("supports pagination", async () => {
    const res = await app.request("/v1/admin/journeys?limit=2&offset=0", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.journeys.length).toBeLessThanOrEqual(2);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(0);
  });

  it("filters by enabled status", async () => {
    const res = await app.request("/v1/admin/journeys?enabled=true", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    for (const journey of body.journeys) {
      expect(journey.enabled).toBe(true);
    }
  });
});

describe("GET /v1/admin/journeys/:id", () => {
  it("returns 404 for unknown journey", async () => {
    const res = await app.request("/v1/admin/journeys/nonexistent", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(404);
  });

  it("returns journey detail", async () => {
    const res = await app.request("/v1/admin/journeys/activation-welcome", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.journey.id).toBe("activation-welcome");
    expect(body.journey.name).toBeTruthy();
    expect(body.journey.trigger.event).toBeTruthy();
    expect(body.journey.counts).toBeDefined();
    expect(body.journey.recentStates).toBeInstanceOf(Array);
    expect(body.journey.suppress).toBeDefined();
  });
});

describe("PATCH /v1/admin/journeys/:id", () => {
  afterAll(async () => {
    await app.request("/v1/admin/journeys/activation-welcome", {
      method: "PATCH",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
  });

  it("returns 404 for unknown journey", async () => {
    const res = await app.request("/v1/admin/journeys/nonexistent", {
      method: "PATCH",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
  });

  it("disables a journey", async () => {
    const res = await app.request("/v1/admin/journeys/activation-welcome", {
      method: "PATCH",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.journey.id).toBe("activation-welcome");
    expect(body.journey.enabled).toBe(false);
    expect(body.journey.updatedAt).toBeTruthy();
  });

  it("re-enables a journey", async () => {
    const res = await app.request("/v1/admin/journeys/activation-welcome", {
      method: "PATCH",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.journey.enabled).toBe(true);
  });
});

describe("GET /v1/admin/journeys/:id/states", () => {
  it("returns 404 for unknown journey", async () => {
    const res = await app.request("/v1/admin/journeys/nonexistent/states", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(404);
  });

  it("returns empty state list for journey with no runs", async () => {
    const res = await app.request(
      "/v1/admin/journeys/activation-welcome/states",
      {
        headers: AUTH_HEADER,
      },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.states).toBeInstanceOf(Array);
    expect(body.total).toBeTypeOf("number");
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });
});

describe("GET /v1/admin/journeys/:id/states/:stateId", () => {
  it("returns 404 for nonexistent state", async () => {
    const res = await app.request(
      "/v1/admin/journeys/activation-welcome/states/00000000-0000-0000-0000-000000000000",
      {
        headers: AUTH_HEADER,
      },
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /v1/admin/journeys/:id/states/:stateId", () => {
  it("returns 404 for nonexistent state", async () => {
    const res = await app.request(
      "/v1/admin/journeys/activation-welcome/states/00000000-0000-0000-0000-000000000000",
      {
        method: "DELETE",
        headers: AUTH_HEADER,
      },
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/admin/journeys/:id/enroll", () => {
  it("returns 404 for unknown journey", async () => {
    const res = await app.request("/v1/admin/journeys/nonexistent/enroll", {
      method: "POST",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "user-1",
        userEmail: "test@example.com",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("enrolls a user by dispatching the trigger event", async () => {
    const res = await app.request(
      "/v1/admin/journeys/activation-welcome/enroll",
      {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: "test-enroll-user",
          userEmail: "enroll@example.com",
          properties: { source: "admin" },
        }),
      },
    );
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body.enrolled).toBe(true);
    expect(body.event).toBeTruthy();
    expect(body.userId).toBe("test-enroll-user");
  });
});
