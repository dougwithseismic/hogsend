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
    task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
    events: { push: vi.fn() },
    runs: { cancel: vi.fn(), get: vi.fn() },
    worker: vi.fn(),
  },
}));

vi.mock("../workflows/send-email.js", () => ({
  sendEmailTask: { run: vi.fn(), runNoWait: vi.fn() },
}));

const { createApp, createHogsendClient } = await import("@hogsend/engine");

const app = createApp(createHogsendClient());
const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

function replay(body: unknown) {
  return app.request("/v1/admin/events/replay", {
    method: "POST",
    headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/admin/events/replay", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request("/v1/admin/events/replay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filter: { event: "x" } }),
    });
    expect(res.status).toBe(401);
  });

  // Regression: an empty body must NOT silently replay the most-recent events
  // through the ingestion pipeline. Refuse it.
  it("rejects an unscoped replay (empty body)", async () => {
    const res = await replay({});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/eventIds|filter/);
  });

  it("rejects an empty eventIds array with no filter", async () => {
    const res = await replay({ eventIds: [] });
    expect(res.status).toBe(400);
  });

  it("rejects a filter object with no populated fields", async () => {
    const res = await replay({ filter: {} });
    expect(res.status).toBe(400);
  });

  // A scoped replay is allowed (matches nothing here → replays 0, no error).
  it("allows a scoped replay", async () => {
    const res = await replay({
      filter: { event: "admin-bulk-replay-no-such-event" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.replayed).toBe(0);
  });
});
