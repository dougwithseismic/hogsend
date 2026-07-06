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

const { importJobs } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const { createApp, createHogsendClient, mapSuppressionRow } = await import(
  "@hogsend/engine"
);

const container = createHogsendClient();
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };
const JSON_HEADERS = { ...AUTH_HEADER, "Content-Type": "application/json" };

const createdJobIds: string[] = [];

afterAll(async () => {
  for (const id of createdJobIds) {
    await db.delete(importJobs).where(eq(importJobs.id, id));
  }
});

describe("POST /v1/admin/suppressions/import", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request("/v1/admin/suppressions/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "json", data: "[]" }),
    });
    expect(res.status).toBe(401);
  });

  it("queues a job and creates the import_jobs row", async () => {
    const res = await app.request("/v1/admin/suppressions/import", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        format: "json",
        data: JSON.stringify([
          { email: "a@example.com", reason: "bounced" },
          { email: "b@example.com" },
        ]),
        fileName: "suppressions.json",
      }),
    });
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(typeof body.jobId).toBe("string");
    expect(body.status).toBe("pending");
    createdJobIds.push(body.jobId);

    const rows = await db
      .select()
      .from(importJobs)
      .where(eq(importJobs.id, body.jobId));
    expect(rows).toHaveLength(1);
    // The engine's real Hatchet client runs against the fake vitest token, so
    // the fire-and-forget enqueue eventually rejects and the catch handler
    // marks the row `failed` — whether that has happened yet is a race.
    expect(["pending", "failed"]).toContain(rows[0]?.status);
    expect(rows[0]?.format).toBe("json");
    expect(rows[0]?.fileName).toBe("suppressions.json");
  });

  it("rejects a bad body with 400", async () => {
    const res = await app.request("/v1/admin/suppressions/import", {
      method: "POST",
      headers: JSON_HEADERS,
      // missing `data`, invalid `format`
      body: JSON.stringify({ format: "xml" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty data with 400", async () => {
    const res = await app.request("/v1/admin/suppressions/import", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ format: "csv", data: "" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/admin/suppressions/import/{jobId}", () => {
  it("returns the job status shape", async () => {
    const post = await app.request("/v1/admin/suppressions/import", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        format: "json",
        data: JSON.stringify([{ email: "c@example.com" }]),
      }),
    });
    const { jobId } = await post.json();
    createdJobIds.push(jobId);

    const res = await app.request(`/v1/admin/suppressions/import/${jobId}`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.id).toBe(jobId);
    // No worker runs in route tests; the fire-and-forget enqueue against the
    // fake vitest Hatchet token eventually rejects, at which point the route's
    // catch handler marks the job `failed` — a race with this GET.
    expect(["pending", "failed"]).toContain(body.status);
    expect(body).toHaveProperty("totalRows");
    expect(body.processedRows).toBe(0);
    expect(body.failedRows).toBe(0);
    expect(typeof body.createdAt).toBe("string");
    expect(typeof body.updatedAt).toBe("string");
  });

  it("returns 404 for an unknown job", async () => {
    const res = await app.request(
      "/v1/admin/suppressions/import/00000000-0000-4000-8000-000000000000",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(404);
  });

  it("returns 401 without auth", async () => {
    const res = await app.request(
      "/v1/admin/suppressions/import/00000000-0000-4000-8000-000000000000",
    );
    expect(res.status).toBe(401);
  });
});

describe("mapSuppressionRow", () => {
  it("maps unsubscribed (and defaults the reason) to unsubscribedAll", () => {
    expect(mapSuppressionRow({ email: "a@example.com" })).toEqual({
      email: "a@example.com",
      externalId: undefined,
      reason: "unsubscribed",
      update: { unsubscribedAll: true },
    });
    expect(
      mapSuppressionRow({ email: "a@example.com", reason: "unsubscribed" })
        .update,
    ).toEqual({ unsubscribedAll: true });
  });

  it("maps bounced to suppressed + bounce slate", () => {
    const mapped = mapSuppressionRow({
      email: "b@example.com",
      reason: "bounced",
      externalId: "user_1",
    });
    expect(mapped.externalId).toBe("user_1");
    expect(mapped.update).toEqual({
      suppressed: true,
      setSuppressedAt: true,
      recordBounce: true,
    });
  });

  it("maps complained to suppressed WITHOUT touching the bounce count", () => {
    const mapped = mapSuppressionRow({
      email: "c@example.com",
      reason: "complained",
    });
    expect(mapped.update).toEqual({ suppressed: true, setSuppressedAt: true });
    // No recordBounce — the derived "complained" view is
    // suppressed AND bounceCount = 0 (see suppressions.ts typeFilter).
    expect(mapped.update).not.toHaveProperty("recordBounce");
  });

  it("normalizes email (trim + lowercase) and accepts mixed-case reasons", () => {
    const mapped = mapSuppressionRow({
      email: "  MiXeD@Example.COM ",
      reason: " Bounced ",
    });
    expect(mapped.email).toBe("mixed@example.com");
    expect(mapped.reason).toBe("bounced");
  });

  it("throws on a missing or invalid email", () => {
    expect(() => mapSuppressionRow({})).toThrow(/no email/i);
    expect(() => mapSuppressionRow({ email: "   " })).toThrow(/no email/i);
    expect(() => mapSuppressionRow({ email: "not-an-email" })).toThrow(
      /invalid email/i,
    );
    expect(() => mapSuppressionRow({ email: "a@b" })).toThrow(/invalid email/i);
  });

  it("throws on an unknown reason", () => {
    expect(() =>
      mapSuppressionRow({ email: "a@example.com", reason: "deleted" }),
    ).toThrow(/invalid reason/i);
  });
});
