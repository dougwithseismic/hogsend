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

const { userEvents } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");

const container = createHogsendClient();
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

// A unique event name so the aggregate sees only this test's rows.
const NPS_EVENT = "survey-answers-test-nps";
const CHOICE_EVENT = "survey-answers-test-choice";
const TEST_USER = "survey-answers-test-user";

beforeAll(async () => {
  // NPS distribution: 2 promoters (10, 9), 1 passive (7), 2 detractors (3, 0).
  // total = 5, nps = (2 − 2) / 5 × 100 = 0, average = 29 / 5 = 5.8.
  const npsRows = [10, 9, 7, 3, 0].map((value) => ({
    userId: TEST_USER,
    event: NPS_EVENT,
    properties: { value, surveyId: "nps-1", source: "in_app" },
    source: "in_app",
  }));
  // A non-numeric choice survey → average + nps must be null.
  const choiceRows = ["blue", "blue", "red"].map((value) => ({
    userId: TEST_USER,
    event: CHOICE_EVENT,
    properties: { value, source: "in_app" },
    source: "in_app",
  }));
  await db.insert(userEvents).values([...npsRows, ...choiceRows]);
});

afterAll(async () => {
  await db.delete(userEvents).where(eq(userEvents.event, NPS_EVENT));
  await db.delete(userEvents).where(eq(userEvents.event, CHOICE_EVENT));
});

describe("GET /v1/admin/reporting/breakdown", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request(
      `/v1/admin/reporting/breakdown?event=${NPS_EVENT}`,
    );
    expect(res.status).toBe(401);
  });

  it("aggregates an NPS breakdown with computed average + nps", async () => {
    const res = await app.request(
      `/v1/admin/reporting/breakdown?event=${NPS_EVENT}&metric=nps`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.event).toBe(NPS_EVENT);
    expect(body.property).toBe("value");
    expect(body.total).toBe(5);

    const counts: Record<string, number> = Object.fromEntries(
      body.breakdown.map((b: { answer: string; count: number }) => [
        b.answer,
        b.count,
      ]),
    );
    expect(counts["10"]).toBe(1);
    expect(counts["9"]).toBe(1);
    expect(counts["7"]).toBe(1);
    expect(counts["3"]).toBe(1);
    expect(counts["0"]).toBe(1);

    expect(body.average).toBeCloseTo(5.8, 5);
    expect(body.nps).toBe(0);
  });

  it("returns null average + nps for non-numeric (choice) answers", async () => {
    const res = await app.request(
      `/v1/admin/reporting/breakdown?event=${CHOICE_EVENT}`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.total).toBe(3);
    const counts: Record<string, number> = Object.fromEntries(
      body.breakdown.map((b: { answer: string; count: number }) => [
        b.answer,
        b.count,
      ]),
    );
    expect(counts.blue).toBe(2);
    expect(counts.red).toBe(1);
    expect(body.average).toBeNull();
    expect(body.nps).toBeNull();
  });

  it("aggregates against a custom property key", async () => {
    const res = await app.request(
      `/v1/admin/reporting/breakdown?event=${NPS_EVENT}&property=surveyId`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.property).toBe("surveyId");
    expect(body.total).toBe(5);
    expect(body.breakdown).toEqual([{ answer: "nps-1", count: 5 }]);
    // surveyId is non-numeric → no average / nps.
    expect(body.average).toBeNull();
    expect(body.nps).toBeNull();
  });
});
