import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, funnelProgress, userEvents } = await import("@hogsend/db");
const { defineFunnel } = await import("@hogsend/core");
const { eq, inArray } = await import("drizzle-orm");
const { createApp, createHogsendClient, ingestEvent } = await import(
  "@hogsend/engine"
);

const RUN = `fnl-${Date.now()}`;
const USER = `${RUN}-user`;
/** Second contact for the exposed-vs-unexposed split (never exposed). */
const USER2 = `${RUN}-user2`;
const JOURNEY = `${RUN}-welcome`;

/**
 * Event-ladder funnel (impact plan §3.3): pure `events` stages, no CRM
 * sources at all — the B2C shape. The subscribed stage carries a `where`
 * (only paid plans count).
 */
const selfServe = defineFunnel({
  id: `${RUN}-self-serve`,
  stages: ["signed_up", "activated", "subscribed"],
  events: {
    signed_up: { event: "user.signup" },
    activated: { event: "activation.completed" },
    subscribed: {
      event: "subscription.started",
      where: (b) => b.prop("plan").neq("free"),
    },
  },
});

const mockHatchet = {
  durableTask: vi.fn(() => ({
    run: vi.fn(),
    runNoWait: vi.fn(),
    runAndWait: vi.fn(),
  })),
  task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
  events: { push: vi.fn() },
  runs: { cancel: vi.fn(), get: vi.fn() },
  worker: vi.fn(),
} as unknown as HogsendClient["hatchet"];

const container = createHogsendClient({
  funnels: [selfServe],
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db, registry, hatchet, logger } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

afterAll(async () => {
  await db
    .delete(funnelProgress)
    .where(eq(funnelProgress.funnelId, `${RUN}-self-serve`));
  await db.delete(userEvents).where(inArray(userEvents.userId, [USER, USER2]));
  await db.delete(contacts).where(inArray(contacts.externalId, [USER, USER2]));
});

const send = (opts: {
  event: string;
  at: string;
  properties?: Record<string, unknown>;
  userId?: string;
  source?: string;
}) => {
  const userId = opts.userId ?? USER;
  return ingestEvent({
    db,
    registry,
    hatchet,
    logger,
    event: {
      event: opts.event,
      userId,
      eventProperties: opts.properties ?? {},
      occurredAt: opts.at,
      idempotencyKey: `${RUN}:${userId}:${opts.event}:${opts.at}`,
      source: opts.source ?? "server",
    },
  });
};

describe("event-ladder funnel progression (impact plan 3.3)", () => {
  it("writes first-reach rows per stage, honors where, and dedups repeats", async () => {
    await send({ event: "user.signup", at: "2026-07-01T09:00:00.000Z" });
    // A free-plan subscription must NOT reach `subscribed` (where gate).
    await send({
      event: "subscription.started",
      at: "2026-07-02T09:00:00.000Z",
      properties: { plan: "free" },
    });
    await send({
      event: "activation.completed",
      at: "2026-07-03T09:00:00.000Z",
    });
    // Paid upgrade reaches `subscribed`.
    await send({
      event: "subscription.started",
      at: "2026-07-05T09:00:00.000Z",
      properties: { plan: "pro" },
    });
    // A REPEAT activation later must not move first-reach.
    await send({
      event: "activation.completed",
      at: "2026-07-08T09:00:00.000Z",
    });

    const rows = await db
      .select()
      .from(funnelProgress)
      .where(eq(funnelProgress.funnelId, `${RUN}-self-serve`))
      .orderBy(funnelProgress.stageRank);

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => [r.stage, r.stageRank])).toEqual([
      ["signed_up", 0],
      ["activated", 1],
      ["subscribed", 2],
    ]);
    // First reach: the ORIGINAL activation instant, not the repeat's.
    expect(rows[1]?.reachedAt.toISOString()).toBe("2026-07-03T09:00:00.000Z");
    // The where-gated stage was reached by the PAID event, not the free one.
    expect(rows[2]?.reachedAt.toISOString()).toBe("2026-07-05T09:00:00.000Z");
    expect(rows.every((r) => r.userKey === USER)).toBe(true);
  });

  it("rejects an events key outside the stage ladder at definition time", () => {
    expect(() =>
      defineFunnel({
        id: `${RUN}-bad`,
        stages: ["a", "b"],
        events: { c: { event: "x" } },
      }),
    ).toThrow(/events\.c is not in its stages/);
  });

  it("serves progression + velocity with exposed-vs-unexposed splits (3.4)", async () => {
    // USER (from the first test) reached all three stages. Give them a
    // journey-stamped touch BEFORE activation; USER2 signs up, never
    // activates, never touched.
    await send({
      event: "email.link_clicked",
      at: "2026-07-02T09:00:00.000Z",
      source: "tracking",
      properties: { journeyId: JOURNEY, templateKey: "welcome" },
    });
    await send({
      event: "user.signup",
      at: "2026-07-01T12:00:00.000Z",
      userId: USER2,
    });

    const res = await app.request(
      `/v1/admin/funnels/${RUN}-self-serve/progression?days=365&journeyId=${JOURNEY}`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stages: Array<{ stage: string; rank: number; reached: number }>;
      transitions: Array<{
        from: string;
        to: string;
        all: {
          entered: number;
          converted: number;
          rate: number;
          medianDays: number | null;
        };
        exposed?: {
          entered: number;
          converted: number;
          medianDays: number | null;
        };
        unexposed?: { entered: number; converted: number };
      }>;
      correlational: true;
    };

    expect(body.correlational).toBe(true);
    expect(body.stages).toEqual([
      { stage: "signed_up", rank: 0, reached: 2 },
      { stage: "activated", rank: 1, reached: 1 },
      { stage: "subscribed", rank: 2, reached: 1 },
    ]);

    const first = body.transitions[0];
    expect(first).toMatchObject({ from: "signed_up", to: "activated" });
    expect(first?.all).toMatchObject({ entered: 2, converted: 1, rate: 0.5 });
    // Velocity: signup 07-01 09:00 → activation 07-03 09:00 = 2 days.
    expect(first?.all.medianDays).toBeCloseTo(2, 5);
    // Exposure split: USER touched by the journey before activating;
    // USER2 untouched and unconverted.
    expect(first?.exposed).toMatchObject({ entered: 1, converted: 1 });
    expect(first?.exposed?.medianDays).toBeCloseTo(2, 5);
    expect(first?.unexposed).toMatchObject({ entered: 1, converted: 0 });

    const unknown = await app.request(
      "/v1/admin/funnels/nope/progression?days=30",
      { headers: AUTH_HEADER },
    );
    expect(unknown.status).toBe(404);
  });
});
