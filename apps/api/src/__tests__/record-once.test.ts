/**
 * Durable set-once foundation (`recordOnce`) for the replay-safety primitives
 * `ctx.once` / `ctx.digest` / `ctx.throttle`.
 *
 * The load-bearing property is FIRST-writer-wins under a concurrent race: a
 * zombie double-writer (a partitioned worker's original execution racing its
 * replay) must NOT clobber a value the winner already handed to author code.
 * These tests drive `recordOnce` against REAL Postgres (the Docker instance on
 * :5434), including a deterministically-interleaved race, plus the `ctx.once`
 * delegation and the `registerRecordLabel` collision guard.
 */

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { journeyStates } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const {
  createHogsendClient,
  createJourneyContext,
  recordOnce,
  registerRecordLabel,
} = await import("@hogsend/engine");
type JourneyBoundary = import("@hogsend/engine").JourneyBoundary;

// Mock Hatchet — createJourneyContext only touches it lazily (durable waits); the
// ctx.once delegation path never reaches it, but the container needs one.
const mockHatchet = {
  durableTask: vi.fn(() => ({
    run: vi.fn(),
    runNoWait: vi.fn(),
    runAndWait: vi.fn(),
  })),
  task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
  events: { push: vi.fn().mockResolvedValue(undefined) },
  runs: { cancel: vi.fn(), get: vi.fn() },
  worker: vi.fn(),
} as unknown as ReturnType<typeof createHogsendClient>["hatchet"];

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const { db } = container;
type RecordDb = Parameters<typeof recordOnce>[0]["db"];

const RUN = `rec-${Date.now()}`;

/** Seed a real journey_states row and return its id (used as stateId). */
async function seedState(userId: string): Promise<string> {
  const [row] = await db
    .insert(journeyStates)
    .values({
      userId,
      userEmail: `${userId}@example.com`,
      journeyId: `${RUN}-journey`,
      currentNodeId: "start",
      status: "active",
    })
    .returning({ id: journeyStates.id });
  return row?.id ?? "";
}

/** Read a state row's whole context jsonb bag. */
async function readContext(stateId: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ context: journeyStates.context })
    .from(journeyStates)
    .where(eq(journeyStates.id, stateId));
  return (row?.context ?? {}) as Record<string, unknown>;
}

let seeded = 0;
async function freshState(): Promise<string> {
  seeded += 1;
  return seedState(`${RUN}-${seeded}`);
}

/** Build a real journey context wired to the container db + mock hatchet. */
function makeCtx(stateId: string, userId: string) {
  return createJourneyContext({
    db: db as Parameters<typeof createJourneyContext>[0]["db"],
    hatchet: mockHatchet as Parameters<
      typeof createJourneyContext
    >[0]["hatchet"],
    hatchetCtx: {
      sleepFor: vi.fn() as unknown as (d: unknown) => Promise<unknown>,
      waitFor: vi.fn() as unknown as (
        c: unknown,
      ) => Promise<Record<string, unknown>>,
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
    registry: { get: () => undefined } as any,
    // biome-ignore lint/suspicious/noExplicitAny: minimal logger stub
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    stateId,
    userId,
    userEmail: `${userId}@example.com`,
    journeyContext: {},
    resolvedTimezone: "UTC",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  for (let i = 1; i <= seeded; i += 1) {
    await db
      .delete(journeyStates)
      .where(eq(journeyStates.userId, `${RUN}-${i}`));
  }
});

describe("recordOnce — durable set-once", () => {
  it("computes + persists on first call, returns stored value on second (no recompute)", async () => {
    const stateId = await freshState();
    const compute = vi.fn(async () => "V1");

    const first = await recordOnce({
      db: db as RecordDb,
      stateId,
      namespace: "__once__",
      key: "k",
      compute,
    });
    expect(first).toBe("V1");
    expect(compute).toHaveBeenCalledTimes(1);

    const bag = await readContext(stateId);
    expect((bag.__once__ as Record<string, unknown>).k).toBe("V1");

    const second = await recordOnce({
      db: db as RecordDb,
      stateId,
      namespace: "__once__",
      key: "k",
      compute,
    });
    expect(second).toBe("V1");
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("returns a pre-seeded value and never invokes compute", async () => {
    const stateId = await freshState();
    await db
      .update(journeyStates)
      .set({ context: { __once__: { k: "A" } } })
      .where(eq(journeyStates.id, stateId));

    const compute = vi.fn(async () => "B");
    const result = await recordOnce({
      db: db as RecordDb,
      stateId,
      namespace: "__once__",
      key: "k",
      compute,
    });
    expect(result).toBe("A");
    expect(compute).not.toHaveBeenCalled();
  });

  it("FIRST-writer-wins under a deterministic race — both racers observe the winner", async () => {
    const stateId = await freshState();

    // Latches force the interleaving: A passes its read (empty), parks in
    // compute; B then runs to completion (read empty → write "B" → resolve);
    // only THEN does A compute "A" and write. A's write must NOT clobber "B".
    let aEnteredCompute: () => void = () => {};
    const aReached = new Promise<void>((res) => {
      aEnteredCompute = res;
    });
    let releaseA: () => void = () => {};
    const aGate = new Promise<void>((res) => {
      releaseA = res;
    });

    const computeA = vi.fn(async () => {
      aEnteredCompute();
      await aGate;
      return "A";
    });
    const computeB = vi.fn(async () => "B");

    const pA = recordOnce({
      db: db as RecordDb,
      stateId,
      namespace: "__once__",
      key: "race",
      compute: computeA,
    });
    // A has read the (empty) bag and is parked in compute — B has not started.
    await aReached;
    const bResult = await recordOnce({
      db: db as RecordDb,
      stateId,
      namespace: "__once__",
      key: "race",
      compute: computeB,
    });
    // B fully committed "B". Now let A compute + write; its merge keeps "B".
    releaseA();
    const aResult = await pA;

    expect(bResult).toBe("B");
    expect(aResult).toBe("B");
    expect(computeA).toHaveBeenCalledTimes(1);
    expect(computeB).toHaveBeenCalledTimes(1);

    const bag = await readContext(stateId);
    expect((bag.__once__ as Record<string, unknown>).race).toBe("B");
  });

  it("isolates namespaces — same key in __once__ and __digest__ never clobber", async () => {
    const stateId = await freshState();

    const onceVal = await recordOnce({
      db: db as RecordDb,
      stateId,
      namespace: "__once__",
      key: "shared",
      compute: async () => "once-value",
    });
    const digestVal = await recordOnce({
      db: db as RecordDb,
      stateId,
      namespace: "__digest__",
      key: "shared",
      compute: async () => "digest-value",
    });

    expect(onceVal).toBe("once-value");
    expect(digestVal).toBe("digest-value");

    const bag = await readContext(stateId);
    expect((bag.__once__ as Record<string, unknown>).shared).toBe("once-value");
    expect((bag.__digest__ as Record<string, unknown>).shared).toBe(
      "digest-value",
    );
  });

  it("round-trips a non-trivial JSON value deeply", async () => {
    const stateId = await freshState();
    const value = {
      events: [
        { occurredAt: "2026-01-01T00:00:00.000Z", properties: { a: 1 } },
      ],
      count: 1,
    };

    const compute = vi.fn(async () => value);
    await recordOnce({
      db: db as RecordDb,
      stateId,
      namespace: "__digest__",
      key: "flush",
      compute,
    });
    const second = await recordOnce({
      db: db as RecordDb,
      stateId,
      namespace: "__digest__",
      key: "flush",
      compute,
    });

    expect(second).toEqual(value);
    expect(compute).toHaveBeenCalledTimes(1);
  });
});

describe("registerRecordLabel — site-label collision guard", () => {
  function makeBoundary(): JourneyBoundary {
    return {
      stateId: "s",
      runAnchor: "s",
      currentLabel: undefined,
      seenKeys: new Set<string>(),
      seenRecordLabels: new Set<string>(),
      // biome-ignore lint/suspicious/noExplicitAny: memoize unused here
      memoize: (async (_deps: unknown[], fn: () => unknown) => fn()) as any,
    };
  }

  it("is a no-op when the boundary is undefined", () => {
    expect(() => registerRecordLabel(undefined, "digest:a")).not.toThrow();
  });

  it("accepts a fresh label, then throws on a duplicate on the SAME boundary", () => {
    const boundary = makeBoundary();
    expect(() => registerRecordLabel(boundary, "digest:a")).not.toThrow();
    expect(() => registerRecordLabel(boundary, "digest:a")).toThrow(
      /used twice in one journey run/,
    );
  });

  it("accepts the same label on a NEW boundary (replay semantics)", () => {
    const a = makeBoundary();
    const b = makeBoundary();
    registerRecordLabel(a, "digest:a");
    expect(() => registerRecordLabel(b, "digest:a")).not.toThrow();
  });
});

describe("ctx.once delegates to recordOnce", () => {
  it("computes on first call, returns the stored value on second (no recompute)", async () => {
    const stateId = await freshState();
    const ctx = makeCtx(stateId, `${RUN}-ctx`);

    const compute = vi.fn(async () => 42);
    expect(await ctx.once("answer", compute)).toBe(42);
    expect(await ctx.once("answer", compute)).toBe(42);
    expect(compute).toHaveBeenCalledTimes(1);

    const bag = await readContext(stateId);
    expect((bag.__once__ as Record<string, unknown>).answer).toBe(42);
  });

  it("returns a pre-seeded once value without recomputing", async () => {
    const stateId = await freshState();
    await db
      .update(journeyStates)
      .set({ context: { __once__: { picked: "A" } } })
      .where(eq(journeyStates.id, stateId));

    const ctx = makeCtx(stateId, `${RUN}-ctx`);
    const compute = vi.fn(async () => "B");
    expect(await ctx.once("picked", compute)).toBe("A");
    expect(compute).not.toHaveBeenCalled();
  });
});
