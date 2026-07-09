import type { Database } from "@hogsend/db";
import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

// Run against the docker TimescaleDB (mirrors admin-journeys.test.ts). Set
// BEFORE importing the engine so the DB singleton picks it up.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const {
  createApp,
  createHogsendClient,
  createJourneyContext,
  createLogger,
  deriveJourneyKey,
  logTransition,
  parseJourneySendSite,
} = await import("@hogsend/engine");
const { journeyLogs, journeyStates } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const { journeys } = await import("../journeys/index.js");

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
  journeys,
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

const JOURNEY_ID = "activation-welcome";
const USER_ID = "journey-logs-writer-test-user";

async function seedState(): Promise<string> {
  const [row] = await db
    .insert(journeyStates)
    .values({
      userId: USER_ID,
      userEmail: "journey-logs@example.com",
      journeyId: JOURNEY_ID,
      currentNodeId: "start",
      status: "active",
      context: {},
    })
    .returning({ id: journeyStates.id });
  if (!row) throw new Error("failed to seed journey state");
  return row.id;
}

afterAll(async () => {
  // Deleting the state cascades to its journey_logs (FK onDelete: cascade).
  await db.delete(journeyStates).where(eq(journeyStates.userId, USER_ID));
});

describe("journey_logs transition writer (Phase 2)", () => {
  it("writes transition rows and surfaces them through the admin state-detail route", async () => {
    const stateId = await seedState();

    // 1. Direct writer — the enrollment + send transitions.
    logTransition({
      db,
      journeyStateId: stateId,
      from: null,
      to: "start",
      action: "entered",
    });
    logTransition({
      db,
      journeyStateId: stateId,
      to: "send:day-2",
      action: "send",
      detail: { template: "welcome", emailSendId: "abc-123" },
    });

    // 2. REAL runtime path — drive `ctx.checkpoint()` through an actual
    //    JourneyContext against the real DB and assert the instrumented write.
    const ctx = createJourneyContext({
      db,
      hatchet: mockHatchet,
      hatchetCtx: {
        sleepFor: async () => {},
        waitFor: async () => ({}),
        now: async () => new Date(),
      },
      registry: container.registry,
      logger: createLogger("error"),
      stateId,
      userId: USER_ID,
      userEmail: "journey-logs@example.com",
      journeyContext: {},
      resolvedTimezone: "UTC",
    });
    await ctx.checkpoint("phase-2-node");

    // checkpoint must have advanced currentNodeId (unchanged existing behavior).
    const [refreshed] = await db
      .select({ currentNodeId: journeyStates.currentNodeId })
      .from(journeyStates)
      .where(eq(journeyStates.id, stateId));
    expect(refreshed?.currentNodeId).toBe("phase-2-node");

    // Give the fire-and-forget inserts a tick to land.
    await new Promise((r) => setTimeout(r, 200));

    // 3. Assert rows exist directly in journey_logs.
    const rows = await db
      .select()
      .from(journeyLogs)
      .where(eq(journeyLogs.journeyStateId, stateId));
    const byAction = new Map(rows.map((r) => [r.action, r]));

    expect(byAction.get("entered")?.toNodeId).toBe("start");
    expect(byAction.get("entered")?.fromNodeId).toBeNull();
    expect(byAction.get("checkpoint")?.toNodeId).toBe("phase-2-node");
    expect(byAction.get("send")?.toNodeId).toBe("send:day-2");
    expect(
      (byAction.get("send")?.detail as Record<string, unknown> | null)
        ?.template,
    ).toBe("welcome");

    // 4. Reader parity — the admin instance drawer's `logs[]` is now non-empty.
    const res = await app.request(
      `/v1/admin/journeys/${JOURNEY_ID}/states/${stateId}`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      logs: Array<{ action: string; toNodeId: string | null }>;
    };
    expect(body.logs.length).toBeGreaterThanOrEqual(3);
    expect(
      body.logs.some((l) => l.action === "entered" && l.toNodeId === "start"),
    ).toBe(true);
    expect(
      body.logs.some(
        (l) => l.action === "checkpoint" && l.toNodeId === "phase-2-node",
      ),
    ).toBe(true);
  });

  it("swallows a synchronous build failure without throwing", () => {
    const throwingDb = {
      insert() {
        throw new Error("boom (synchronous build)");
      },
    } as unknown as Database;
    expect(() =>
      logTransition({
        db: throwingDb,
        journeyStateId: "x",
        to: "y",
        action: "entered",
      }),
    ).not.toThrow();
  });

  it("swallows a rejected insert without an unhandled rejection", async () => {
    const rejectingDb = {
      insert() {
        return {
          values() {
            // A thenable that rejects — logTransition must attach `.catch`.
            return {
              catch(fn: (e: unknown) => void) {
                return Promise.reject(new Error("db down")).catch(fn);
              },
            };
          },
        };
      },
    } as unknown as Database;
    expect(() =>
      logTransition({
        db: rejectingDb,
        journeyStateId: "x",
        to: "y",
        action: "failed",
      }),
    ).not.toThrow();
    // Let the swallowed rejection settle so no unhandled-rejection surfaces.
    await new Promise((r) => setTimeout(r, 50));
  });

  it("recovers the send <site> from the idempotency key (Phase-3 join key)", () => {
    // The SEND log's `to = send:<site>` must equal what buildJourneyGraph emits.
    // Round-trip the exact key derivation used by the mailer.
    const anchor = "run-abc";
    const template = "nps-survey";

    // (a) site inherited from the nearest wait label.
    const k1 = deriveJourneyKey({
      kind: "send",
      anchor,
      site: "day-2",
      discriminant: template,
    });
    expect(
      parseJourneySendSite({ key: k1, anchor, discriminant: template }),
    ).toBe("day-2");

    // (b) site is an explicit idempotencyLabel that itself contains a colon
    //     (e.g. a synthetic `wait-event:<event>` label) — split-on-`:` would
    //     break here, prefix/suffix stripping does not.
    const k2 = deriveJourneyKey({
      kind: "send",
      anchor,
      site: "wait-event:nps.reminder",
      discriminant: template,
    });
    expect(
      parseJourneySendSite({ key: k2, anchor, discriminant: template }),
    ).toBe("wait-event:nps.reminder");

    // (c) a non-journeySend / caller-supplied key yields undefined (falls back).
    expect(
      parseJourneySendSite({
        key: "some-external-key",
        anchor,
        discriminant: template,
      }),
    ).toBeUndefined();
    expect(
      parseJourneySendSite({ key: undefined, anchor, discriminant: template }),
    ).toBeUndefined();
  });
});
