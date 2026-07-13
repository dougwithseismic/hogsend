import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, funnelProgress, userEvents } = await import("@hogsend/db");
const { defineFunnel } = await import("@hogsend/core");
const { eq, inArray } = await import("drizzle-orm");
const { createHogsendClient, ingestEvent } = await import("@hogsend/engine");

const RUN = `fnl-${Date.now()}`;
const USER = `${RUN}-user`;

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
const { db, registry, hatchet, logger } = container;

afterAll(async () => {
  await db
    .delete(funnelProgress)
    .where(eq(funnelProgress.funnelId, `${RUN}-self-serve`));
  await db.delete(userEvents).where(inArray(userEvents.userId, [USER]));
  await db.delete(contacts).where(eq(contacts.externalId, USER));
});

const send = (opts: {
  event: string;
  at: string;
  properties?: Record<string, unknown>;
}) =>
  ingestEvent({
    db,
    registry,
    hatchet,
    logger,
    event: {
      event: opts.event,
      userId: USER,
      eventProperties: opts.properties ?? {},
      occurredAt: opts.at,
      idempotencyKey: `${RUN}:${opts.event}:${opts.at}`,
      source: "server",
    },
  });

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
});
