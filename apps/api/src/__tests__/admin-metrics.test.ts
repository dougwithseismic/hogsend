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

const { emailSends } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");

const container = createHogsendClient();
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
};

// A template whose only row is sent but NOT delivered (deliveredAt null) yet
// opened — exercises the open-rate denominator fallback to `sent`.
const OPEN_RATE_TEMPLATE = "admin-metrics-open-rate-template";
let openRateEmailId: string;

beforeAll(async () => {
  const base = new Date("2026-02-01T00:00:00.000Z");
  const rows = await db
    .insert(emailSends)
    .values({
      templateKey: OPEN_RATE_TEMPLATE,
      fromEmail: "from@hogsend.com",
      toEmail: "openrate@example.com",
      subject: "Open rate fallback test",
      status: "opened",
      createdAt: base,
      sentAt: new Date(base.getTime() + 1000),
      // deliveredAt intentionally null
      openedAt: new Date(base.getTime() + 3000),
    })
    .returning({ id: emailSends.id });
  openRateEmailId = rows[0]?.id ?? "";
});

afterAll(async () => {
  if (openRateEmailId) {
    await db.delete(emailSends).where(eq(emailSends.id, openRateEmailId));
  }
});

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

  it("returns per-template metrics with clickToDeliveryRate", async () => {
    const res = await app.request("/v1/admin/metrics/emails", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.templates).toBeInstanceOf(Array);
    for (const t of body.templates) {
      expect(typeof t.deliveryRate).toBe("number");
      expect(typeof t.openRate).toBe("number");
      expect(typeof t.clickRate).toBe("number");
      expect(typeof t.clickToDeliveryRate).toBe("number");
    }
  });

  it("computes openRate off sent when delivered is 0 (denominator fallback)", async () => {
    const res = await app.request("/v1/admin/metrics/emails", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    const row = body.templates.find(
      (t: { templateKey: string }) => t.templateKey === OPEN_RATE_TEMPLATE,
    );
    expect(row).toBeDefined();
    expect(row.sent).toBe(1);
    expect(row.delivered).toBe(0);
    expect(row.opened).toBe(1);
    // delivered=0 -> denominator falls back to sent=1, so openRate is 1, not 0.
    expect(row.openRate).toBe(1);
    // clickToDeliveryRate guards on delivered>0, so it stays 0.
    expect(row.clickToDeliveryRate).toBe(0);
  });

  it("accepts from/to window and includeUntemplated params", async () => {
    const res = await app.request(
      "/v1/admin/metrics/emails?from=2020-01-01T00:00:00.000Z&to=2020-12-31T00:00:00.000Z&includeUntemplated=true",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.templates).toBeInstanceOf(Array);
  });

  it("includeUntemplated=false excludes untemplated rows (not coerced to true)", async () => {
    const res = await app.request(
      "/v1/admin/metrics/emails?includeUntemplated=false",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    // The "(none)" bucket is only produced when untemplated rows are included.
    const untemplated = body.templates.find(
      (t: { templateKey: string }) => t.templateKey === "(none)",
    );
    expect(untemplated).toBeUndefined();
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
