/**
 * Impact experiments D1 — version stamping at the journey insert sites.
 * Enrollment + held_out rows are stamped with the definition's
 * versionHash/version at INSERT; replay recovery NEVER restamps (the row
 * keeps its ENTRY-time version while replay executes current code); the
 * public insertEnrollment stays back-compatible without the new opts.
 * Harness: engine hatchet singleton mocked with fns captured BY NAME
 * (journey-blueprint-interpreter pattern) so the real guard chain runs
 * against real Postgres.
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
const { and, eq, like } = await import("drizzle-orm");
const { createHogsendClient, defineJourney, holdoutBucket, insertEnrollment } =
  await import("@hogsend/engine");

const RUN = `jvstamp-${Date.now()}`;
const STAMP_ID = `${RUN}-stamp`;
const REPLAY_ID = `${RUN}-replay`;

const stampJourney = defineJourney({
  meta: {
    id: STAMP_ID,
    name: "Stamp journey",
    enabled: true,
    trigger: { event: `${RUN}.enroll` },
    entryLimit: "unlimited",
    suppress: { hours: 0 },
    holdout: { percent: 50 },
    version: "2026-07-stamp-v1",
  },
  run: async () => {},
});

const replayV1 = defineJourney({
  meta: {
    id: REPLAY_ID,
    name: "Replay journey",
    enabled: true,
    trigger: { event: `${RUN}.replay` },
    entryLimit: "once",
    suppress: { hours: 0 },
    version: "v1-original",
  },
  run: async () => {},
});

const container = createHogsendClient({
  journeys: [stampJourney, replayV1],
});
const { db } = container;

/** Probe deterministic buckets on each side of the 50% line. */
function findUser(held: boolean): string {
  for (let i = 0; i < 2000; i++) {
    const candidate = `${RUN}-u${i}`;
    const bucket = holdoutBucket({ userId: candidate, journeyId: STAMP_ID });
    if (held ? bucket < 5000 : bucket >= 5000) return candidate;
  }
  throw new Error("no candidate found");
}
const HELD_USER = findUser(true);
const ENTERED_USER = findUser(false);

const input = (userId: string) => ({
  userId,
  userEmail: `${userId}@example.com`,
  properties: {},
});
const ctx = (runId: string) => ({
  workflowRunId: () => runId,
  sleepFor: async () => ({}),
  waitFor: async () => ({}),
  now: async () => new Date(),
});
const journeyFn = (id: string): CapturedFn => {
  const fn = mockFns[`journey-${id}`];
  if (!fn) throw new Error(`journey fn for ${id} was not captured`);
  return fn;
};
const stateRows = (journeyId: string, userId: string) =>
  db
    .select()
    .from(journeyStates)
    .where(
      and(
        eq(journeyStates.journeyId, journeyId),
        eq(journeyStates.userId, userId),
      ),
    );

afterAll(async () => {
  await db
    .delete(journeyStates)
    .where(like(journeyStates.journeyId, `${RUN}-%`));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}-%`));
});

describe("enrollment + held_out stamping (D1)", () => {
  it("stamps the enrollment row with meta.versionHash / meta.version", async () => {
    const result = await journeyFn(STAMP_ID)(
      input(ENTERED_USER),
      ctx(`${RUN}-r-enter`),
    );
    expect(result).toMatchObject({ status: "completed" });
    const rows = await stateRows(STAMP_ID, ENTERED_USER);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.journeyVersionHash).toBe(stampJourney.meta.versionHash);
    expect(rows[0]?.journeyVersionHash).toMatch(/^[0-9a-f]{12}$/);
    expect(rows[0]?.journeyVersionLabel).toBe("2026-07-stamp-v1");
  });

  it("stamps the held_out row identically (same-hash control matching)", async () => {
    const result = await journeyFn(STAMP_ID)(
      input(HELD_USER),
      ctx(`${RUN}-r-held`),
    );
    expect(result).toMatchObject({ status: "skipped", reason: "held_out" });
    const rows = await stateRows(STAMP_ID, HELD_USER);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "held_out",
      journeyVersionHash: stampJourney.meta.versionHash,
      journeyVersionLabel: "2026-07-stamp-v1",
    });
  });
});

describe("replay recovery never restamps", () => {
  it("keeps the ENTRY-time stamp when a redeploy changed the definition", async () => {
    const userId = `${RUN}-replayer`;
    const runId = `${RUN}-r-replay`;
    const first = await journeyFn(REPLAY_ID)(input(userId), ctx(runId));
    expect(first).toMatchObject({ status: "completed" });
    const [before] = await stateRows(REPLAY_ID, userId);
    expect(before?.journeyVersionHash).toBe(replayV1.meta.versionHash);
    expect(before?.journeyVersionLabel).toBe("v1-original");

    // "Redeploy": same id, changed body + label — registers a new task fn
    // under the same journey-<id> key, closing over a FORKED meta.
    const replayV2 = defineJourney({
      meta: {
        id: REPLAY_ID,
        name: "Replay journey",
        enabled: true,
        trigger: { event: `${RUN}.replay` },
        entryLimit: "once",
        suppress: { hours: 0 },
        version: "v2-redeploy",
      },
      run: async () => {
        return;
      },
    });
    expect(replayV2.meta.versionHash).not.toBe(replayV1.meta.versionHash);

    // Replay of the SAME logical run: recovery-first (guards bypassed),
    // no second row, no UPDATE of the version columns.
    const replayed = await journeyFn(REPLAY_ID)(input(userId), ctx(runId));
    expect(replayed).toMatchObject({ status: "completed" });
    const after = await stateRows(REPLAY_ID, userId);
    expect(after).toHaveLength(1);
    expect(after[0]?.journeyVersionHash).toBe(replayV1.meta.versionHash);
    expect(after[0]?.journeyVersionLabel).toBe("v1-original");

    // A DISTINCT new run against the `once` journey: entry-limit skip —
    // still one row, still the original stamp.
    const fresh = await journeyFn(REPLAY_ID)(
      input(userId),
      ctx(`${RUN}-r-new`),
    );
    expect(fresh).toMatchObject({ status: "skipped" });
    expect(await stateRows(REPLAY_ID, userId)).toHaveLength(1);
  });
});

describe("insertEnrollment public API back-compat", () => {
  it("defaults the version columns to NULL without opts; stamps when passed", async () => {
    const bare = await insertEnrollment({
      db,
      userId: `${RUN}-direct-bare`,
      userEmail: `${RUN}-direct-bare@example.com`,
      journeyId: `${RUN}-direct`,
      context: {},
    });
    expect(bare?.journeyVersionHash).toBeNull();
    expect(bare?.journeyVersionLabel).toBeNull();

    const stamped = await insertEnrollment({
      db,
      userId: `${RUN}-direct-stamped`,
      userEmail: `${RUN}-direct-stamped@example.com`,
      journeyId: `${RUN}-direct`,
      context: {},
      journeyVersionHash: "abcdefabcdef",
      journeyVersionLabel: "direct-v1",
    });
    expect(stamped?.journeyVersionHash).toBe("abcdefabcdef");
    expect(stamped?.journeyVersionLabel).toBe("direct-v1");
  });
});
