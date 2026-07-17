/**
 * Impact experiments D1 — blueprint enrollments stamp a graph-content hash
 * with v{row.version} as the label; a graph edit + version bump forks the
 * stamp. The interpreter enrolls through executeJourneyRun, so this proves
 * the blueprintMetaFromRow attach end-to-end against real Postgres.
 */
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { afterAll, describe, expect, it, vi } from "vitest";

type CapturedFn = (input: unknown, ctx: unknown) => Promise<unknown>;
const mockFns: Record<string, CapturedFn> = {};
const { hatchetMock } = vi.hoisted(() => ({
  hatchetMock: () => ({
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
  }),
}));
vi.mock("../../../../packages/engine/src/lib/hatchet.ts", hatchetMock);
vi.mock("../../../../packages/engine/src/lib/hatchet.js", hatchetMock);

const { contacts, journeyBlueprints, journeyStates, userEvents } = await import(
  "@hogsend/db"
);
const { and, eq, like } = await import("drizzle-orm");
const { blueprintMetaFromRow, createHogsendClient, setJourneyRegistry } =
  await import("@hogsend/engine");
const { JourneyRegistry } = await import("@hogsend/core/registry");

const container = createHogsendClient();
// Interpreter completion paths read the journey-registry singleton; pin an
// empty one (the journey-blueprint-interpreter.test.ts harness pattern).
setJourneyRegistry(new JourneyRegistry());
const { db } = container;

const RUN = `jvbp-${Date.now()}`;
const BP_ID = `${RUN}-bp`;

const graph = (startTitle: string) => ({
  journeyId: BP_ID,
  nodes: [
    { id: "start", type: "start", title: startTitle },
    { id: "end-ok", type: "end-completed", title: "Done" },
  ],
  edges: [{ id: "e1", source: "start", target: "end-ok" }],
});

const bpInput = (userId: string, blueprintVersion: number) => ({
  blueprintId: BP_ID,
  blueprintVersion,
  userId,
  userEmail: `${userId}@example.com`,
  triggerProperties: {},
});
const ctx = (runId: string) => ({
  workflowRunId: () => runId,
  sleepFor: async () => ({}),
  waitFor: async () => ({}),
  now: async () => new Date(),
});
const interpreter = (): CapturedFn => {
  const fn = mockFns["journey-blueprint-interpreter"];
  if (!fn) throw new Error("interpreter fn was not captured");
  return fn;
};
const stateRow = async (userId: string) => {
  const rows = await db
    .select()
    .from(journeyStates)
    .where(
      and(eq(journeyStates.journeyId, BP_ID), eq(journeyStates.userId, userId)),
    );
  return rows[0];
};

afterAll(async () => {
  await db
    .delete(journeyStates)
    .where(like(journeyStates.journeyId, `${RUN}-%`));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}-%`));
  await db
    .delete(journeyBlueprints)
    .where(like(journeyBlueprints.id, `${RUN}-%`));
});

describe("blueprint version stamping (D1)", () => {
  it("stamps v{row.version} + the graph-content hash, and forks on a bump", async () => {
    await db.insert(journeyBlueprints).values({
      id: BP_ID,
      name: `Blueprint ${BP_ID}`,
      status: "enabled",
      version: 1,
      triggerEvent: `${RUN}.bp.enroll`,
      entryLimit: "unlimited",
      suppress: {},
      graph: graph("start-v1") as never,
      source: "api",
    });

    const u1 = `${RUN}-bp-u1`;
    const r1 = await interpreter()(bpInput(u1, 1), ctx(`${RUN}-bp-r1`));
    expect(r1).toMatchObject({ status: "completed" });

    const [rowV1] = await db
      .select()
      .from(journeyBlueprints)
      .where(eq(journeyBlueprints.id, BP_ID));
    if (!rowV1) throw new Error("blueprint row missing");
    const expectedV1 = blueprintMetaFromRow(rowV1);
    const stateV1 = await stateRow(u1);
    expect(stateV1?.journeyVersionLabel).toBe("v1");
    expect(stateV1?.journeyVersionHash).toBe(expectedV1.versionHash);
    expect(stateV1?.journeyVersionHash).toMatch(/^[0-9a-f]{12}$/);

    // Graph edit + version bump (what updateBlueprint does): the next
    // enrollment stamps the NEW content identity.
    await db
      .update(journeyBlueprints)
      .set({ version: 2, graph: graph("start-v2") as never })
      .where(eq(journeyBlueprints.id, BP_ID));

    const u2 = `${RUN}-bp-u2`;
    const r2 = await interpreter()(bpInput(u2, 2), ctx(`${RUN}-bp-r2`));
    expect(r2).toMatchObject({ status: "completed" });
    const stateV2 = await stateRow(u2);
    expect(stateV2?.journeyVersionLabel).toBe("v2");
    expect(stateV2?.journeyVersionHash).toMatch(/^[0-9a-f]{12}$/);
    expect(stateV2?.journeyVersionHash).not.toBe(stateV1?.journeyVersionHash);
  });
});
