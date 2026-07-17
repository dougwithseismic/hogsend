/**
 * Impact experiments D1 — admin exposure: journeys list + detail carry the
 * CURRENT definition's version/versionHash (registry meta — depends on the
 * 1a schema fix retaining the fields through JourneyRegistry.register), and
 * recentStates carry the per-row stamps via serializeState's spread.
 *
 * Also covers the 1c "Admin exposure" deferral: journeys list + detail carry
 * meta.goal (the conversion definition id the /lift + /impact readouts
 * default to) for a journey that declares one, and omit it (undefined) for
 * one that doesn't.
 */
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { afterAll, describe, expect, it, vi } from "vitest";

type CapturedFn = (input: unknown, ctx: unknown) => Promise<unknown>;
// `vi.mock` calls are hoisted above module-scope `const`s, so the shared
// factory must live inside `vi.hoisted` (a bare `const hatchetMock = () =>
// ({...})` referenced by name below throws a TDZ ReferenceError at hoist
// time — this is the fix, not a behavior change from the brief's harness).
const { mockFns, hatchetMock } = vi.hoisted(() => {
  const mockFns: Record<string, CapturedFn> = {};
  const hatchetMock = () => ({
    hatchet: {
      durableTask: vi.fn((cfg: { name: string; fn: CapturedFn }) => {
        mockFns[cfg.name] = cfg.fn;
        return { run: vi.fn(), runNoWait: vi.fn(), runAndWait: vi.fn() };
      }),
      task: vi.fn((cfg: { name: string; fn: CapturedFn }) => {
        mockFns[cfg.name] = cfg.fn;
        return { run: vi.fn(), runNoWait: vi.fn(async () => ({})) };
      }),
      events: { push: vi.fn(async () => {}) },
      runs: { cancel: vi.fn(async () => {}), get: vi.fn() },
      worker: vi.fn(),
    },
  });
  return { mockFns, hatchetMock };
});
vi.mock("../../../../packages/engine/src/lib/hatchet.ts", hatchetMock);
vi.mock("../../../../packages/engine/src/lib/hatchet.js", hatchetMock);

const { contacts, journeyStates, userEvents } = await import("@hogsend/db");
const { like } = await import("drizzle-orm");
const { createApp, createHogsendClient, defineConversion, defineJourney } =
  await import("@hogsend/engine");

const RUN = `jvadmin-${Date.now()}`;
const JOURNEY_ID = `${RUN}-journey`;
const GOAL_JOURNEY_ID = `${RUN}-goal-journey`;
const GOAL_ID = `${RUN}-sale`;

const journey = defineJourney({
  meta: {
    id: JOURNEY_ID,
    name: "Admin stamp journey",
    enabled: true,
    trigger: { event: `${RUN}.enroll` },
    entryLimit: "unlimited",
    suppress: { hours: 0 },
    version: "2026-07-admin-v1",
  },
  run: async () => {},
});

// `journey` above declares no `goal` — used to assert the field is absent
// (not just falsy) on a journey that doesn't declare one.
const goalConversion = defineConversion({
  id: GOAL_ID,
  name: "Admin goal conversion",
  trigger: { event: `${RUN}.sold` },
});

const goalJourney = defineJourney({
  meta: {
    id: GOAL_JOURNEY_ID,
    name: "Admin goal journey",
    enabled: true,
    trigger: { event: `${RUN}.goal-enroll` },
    entryLimit: "unlimited",
    suppress: { hours: 0 },
    goal: GOAL_ID,
  },
  run: async () => {},
});

const container = createHogsendClient({
  journeys: [journey, goalJourney],
  conversions: [goalConversion],
});
const app = createApp(container);
const { db } = container;
const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

afterAll(async () => {
  await db
    .delete(journeyStates)
    .where(like(journeyStates.journeyId, `${RUN}-%`));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}-%`));
});

describe("admin exposure of version identity (D1)", () => {
  it("exposes version + versionHash on list/detail and stamps on recentStates", async () => {
    // Create one stamped enrollment first.
    const fn = mockFns[`journey-${JOURNEY_ID}`];
    if (!fn) throw new Error("journey fn was not captured");
    const result = await fn(
      {
        userId: `${RUN}-user`,
        userEmail: `${RUN}-user@example.com`,
        properties: {},
      },
      {
        workflowRunId: () => `${RUN}-r1`,
        sleepFor: async () => ({}),
        waitFor: async () => ({}),
        now: async () => new Date(),
      },
    );
    expect(result).toMatchObject({ status: "completed" });

    const list = await app.request("/v1/admin/journeys?limit=100", {
      headers: AUTH_HEADER,
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      journeys: Array<{
        id: string;
        version?: string;
        versionHash?: string;
        goal?: string;
      }>;
    };
    const entry = listBody.journeys.find((j) => j.id === JOURNEY_ID);
    expect(entry?.version).toBe("2026-07-admin-v1");
    expect(entry?.versionHash).toBe(journey.meta.versionHash);
    expect(entry?.goal).toBeUndefined();

    const goalEntry = listBody.journeys.find((j) => j.id === GOAL_JOURNEY_ID);
    expect(goalEntry?.goal).toBe(GOAL_ID);

    const detail = await app.request(`/v1/admin/journeys/${JOURNEY_ID}`, {
      headers: AUTH_HEADER,
    });
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      journey: {
        version?: string;
        versionHash?: string;
        goal?: string;
        recentStates: Array<{
          journeyVersionHash: string | null;
          journeyVersionLabel: string | null;
        }>;
      };
    };
    expect(detailBody.journey.version).toBe("2026-07-admin-v1");
    expect(detailBody.journey.versionHash).toBe(journey.meta.versionHash);
    expect(detailBody.journey.goal).toBeUndefined();
    expect(detailBody.journey.recentStates.length).toBeGreaterThan(0);
    expect(detailBody.journey.recentStates[0]?.journeyVersionHash).toBe(
      journey.meta.versionHash,
    );
    expect(detailBody.journey.recentStates[0]?.journeyVersionLabel).toBe(
      "2026-07-admin-v1",
    );

    const goalDetail = await app.request(
      `/v1/admin/journeys/${GOAL_JOURNEY_ID}`,
      { headers: AUTH_HEADER },
    );
    expect(goalDetail.status).toBe(200);
    const goalDetailBody = (await goalDetail.json()) as {
      journey: { goal?: string };
    };
    expect(goalDetailBody.journey.goal).toBe(GOAL_ID);
  });
});
