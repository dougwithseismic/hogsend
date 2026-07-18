import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { createApp, createHogsendClient } = await import("@hogsend/engine");
const { contacts, journeyStates, userEvents } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const { journeys } = await import("../journeys/index.js");
const { conversions } = await import("../conversions/index.js");
const { templates } = await import("../emails/index.js");
// The real app lists (incl. `product-updates`) — wired so the marketing
// template's `product-updates` category resolves to a defined list (matching
// src/index.ts; the container boot-guard rejects a category with no list).
const { lists } = await import("../lists/index.js");

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
  conversions,
  lists,
  email: { templates },
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
};

// The enroll endpoint drives the real ingest pipeline (resolveOrCreateContact +
// user_events insert) against the docker DB; clean up the rows it creates.
const ENROLL_USER = "test-enroll-user";

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

describe("GET /v1/admin/journeys/:id/templates", () => {
  it("returns 404 for unknown journey", async () => {
    const res = await app.request("/v1/admin/journeys/nonexistent/templates", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(404);
  });

  it("returns an empty template list for a journey with no sends", async () => {
    const res = await app.request(
      "/v1/admin/journeys/activation-welcome/templates",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.templates).toBeInstanceOf(Array);
  });
});

describe("GET /v1/admin/journeys/:id/graph", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request("/v1/admin/journeys/feedback-nps/graph");
    expect(res.status).toBe(401);
  });

  it("returns 404 for unknown journey", async () => {
    const res = await app.request("/v1/admin/journeys/nonexistent/graph", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(404);
  });

  it("returns the graph IR + per-node metrics for a real journey", async () => {
    const res = await app.request("/v1/admin/journeys/feedback-nps/graph", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = await res.json();

    // Graph shape — a real journey source parses to a non-degraded chain with
    // start + terminal nodes.
    expect(body.graph.journeyId).toBe("feedback-nps");
    expect(body.graph.nodes).toBeInstanceOf(Array);
    expect(body.graph.edges).toBeInstanceOf(Array);
    const nodeIds = body.graph.nodes.map((n: { id: string }) => n.id);
    expect(nodeIds).toContain("start");
    expect(nodeIds).toContain("end-completed");
    // feedback-nps sends + waits, so it must extract more than just start→end.
    expect(body.graph.nodes.length).toBeGreaterThan(2);

    // Metrics shape.
    expect(typeof body.metrics.enrolled).toBe("number");
    expect(typeof body.metrics.terminals.completed).toBe("number");
    expect(typeof body.metrics.terminals.failed).toBe("number");
    expect(typeof body.metrics.terminals.exited).toBe("number");

    // Every graph node id has a metric entry (defaulted to zeros).
    for (const id of nodeIds) {
      const metric = body.metrics.nodes[id];
      expect(metric).toBeDefined();
      expect(typeof metric.live).toBe("number");
      expect(typeof metric.failed).toBe("number");
    }

    // Static const-name → registry key resolution: feedback-nps sends
    // `Templates.FEEDBACK_NPS_SURVEY` (member-expr, no literal key), which must
    // resolve to the registered `feedback-nps-survey` key with NO runtime data
    // — so both send nodes preview immediately.
    const sendNodes = body.graph.nodes.filter(
      (n: { type: string }) => n.type === "send",
    );
    expect(sendNodes.length).toBeGreaterThanOrEqual(2);
    for (const node of sendNodes) {
      expect(body.metrics.nodes[node.id].templateKey).toBe(
        "feedback-nps-survey",
      );
    }
  });

  it("resolves member-expr send templates statically, incl. prefix fallback", async () => {
    const res = await app.request(
      "/v1/admin/journeys/activation-nudge-series/graph",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    type GNode = {
      id: string;
      type: string;
      subtitle?: string;
    };
    const keyFor = (subtitle: string): string | undefined => {
      const node = (body.graph.nodes as GNode[]).find(
        (n) => n.type === "send" && n.subtitle === subtitle,
      );
      return node ? body.metrics.nodes[node.id].templateKey : undefined;
    };

    // Exact kebab matches.
    expect(keyFor("ACTIVATION_QUICKSTART")).toBe("activation-quickstart");
    expect(keyFor("ACTIVATION_FEATURE_HIGHLIGHT")).toBe(
      "activation-feature-highlight",
    );
    // Prefix fallback: kebab'd const isn't a key, longest segment-prefix is.
    // ACTIVATION_NUDGE_SERIES → activation-nudge-series → `activation-nudge`.
    expect(keyFor("ACTIVATION_NUDGE_SERIES")).toBe("activation-nudge");
    // ACTIVATION_COMMUNITY_ALT → activation-community-alt → `activation-community`.
    expect(keyFor("ACTIVATION_COMMUNITY_ALT")).toBe("activation-community");
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
  afterAll(async () => {
    await db.delete(userEvents).where(eq(userEvents.userId, ENROLL_USER));
    await db.delete(journeyStates).where(eq(journeyStates.userId, ENROLL_USER));
    await db.delete(contacts).where(eq(contacts.externalId, ENROLL_USER));
  });

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
    (mockHatchet.events.push as ReturnType<typeof vi.fn>).mockClear();

    const res = await app.request(
      "/v1/admin/journeys/activation-welcome/enroll",
      {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: ENROLL_USER,
          userEmail: "enroll@example.com",
          properties: { source: "admin" },
        }),
      },
    );
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body.enrolled).toBe(true);
    expect(body.event).toBeTruthy();
    expect(body.userId).toBe(ENROLL_USER);

    // The public `properties` request field (decision #14) maps to the
    // IngestEvent's `eventProperties` bag, which `ingestEvent` forwards onto the
    // Hatchet push under the (unchanged) `properties` wire key. Assert the
    // trigger event was dispatched carrying the supplied property — proving the
    // public-name → eventProperties mapping survived the D2 split.
    const push = mockHatchet.events.push as ReturnType<typeof vi.fn>;
    const triggerCall = push.mock.calls.find((call) => call[0] === body.event);
    expect(triggerCall).toBeDefined();
    const payload = triggerCall?.[1] as {
      userId?: string;
      properties?: Record<string, unknown>;
    };
    expect(payload?.userId).toBe(ENROLL_USER);
    expect(payload?.properties?.source).toBe("admin");
  });
});
