import type { DurationObject, PropertyCondition } from "@hogsend/core";
import { days, hours, minutes } from "@hogsend/core";
import {
  createJourneyContext,
  type JourneyBoundary,
  JourneyExitedError,
  runWithJourneyBoundary,
} from "@hogsend/engine";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NY = "America/New_York";
// 2026-06-01 10:00 in America/New_York (EDT) === 14:00 UTC. Frozen so the
// deadline/remainder math is exact (no wall-clock drift between `now()` reads).
const FIXED = new Date("2026-06-01T14:00:00.000Z");

const dialect = new PgDialect();
/** Compile a captured drizzle `SQL`/`and(...)` to `{ sql, params }` so a test
 * can assert the eq-pushdown params and the studio-exclusion literal appear. */
function compile(cond: unknown): { sql: string; params: unknown[] } {
  const q = dialect.sqlToQuery(cond as SQL);
  return { sql: q.sql, params: q.params };
}

interface ScanRow {
  id: string;
  properties: Record<string, unknown> | null;
  occurredAt: Date;
}

/**
 * A db stub covering the three chains `ctx.digest` drives:
 *  • `query.journeyStates.findFirst` — recordOnce/peekRecord context reads
 *    (returns the SAME mutable `context`, so a pre-seed simulates a prior
 *    recordOnce write / replay).
 *  • `update().set().where()` — awaited directly by recordOnce writes (no
 *    `.returning`) AND `.returning()`-guarded by the sleep status flips (the
 *    `returningQueue` scripts enter/resume row counts).
 *  • `select({status}).from().where().limit(1)` — the no-sleep wake-path status
 *    read (returns the seeded `status`).
 *  • `select({...}).from().where().orderBy().limit(n)` — the flush scan; the
 *    captured `where`/`orderBy`/`limit` are exposed for assertions and the
 *    seeded rows are SLICED to `n` (so cap+1 truncation detection is exercised).
 */
function makeDigestDb(opts?: {
  context?: Record<string, unknown>;
  scanRows?: ScanRow[];
  returningQueue?: Array<Array<{ id: string }>>;
  status?: string;
}) {
  const context = opts?.context ?? {};
  const scanRows = opts?.scanRows ?? [];
  const status = opts?.status ?? "active";
  const returningQueue = opts?.returningQueue ?? [
    [{ id: "state-1" }],
    [{ id: "state-1" }],
  ];
  const setCalls: Array<Record<string, unknown>> = [];
  const scan: {
    where?: unknown;
    orderBy: unknown[];
    limit?: number;
    called: number;
  } = {
    orderBy: [],
    called: 0,
  };
  let returningCall = 0;

  const update = vi.fn(() => ({
    set: (vals: Record<string, unknown>) => {
      setCalls.push(vals);
      return {
        where: () => {
          const p = Promise.resolve<Array<{ id: string }>>([]) as Promise<
            Array<{ id: string }>
          > & { returning: () => Promise<Array<{ id: string }>> };
          p.returning = () =>
            Promise.resolve(returningQueue[returningCall++] ?? []);
          return p;
        },
      };
    },
  }));

  const select = vi.fn((cols: Record<string, unknown>) => ({
    from: () => ({
      where: (cond: unknown) => {
        // The no-sleep status read selects only `status` (no `orderBy`); the
        // scan selects `properties` and chains `orderBy().limit()`.
        if (!("properties" in cols)) {
          return { limit: () => Promise.resolve([{ status }]) };
        }
        scan.where = cond;
        scan.called += 1;
        return {
          orderBy: (...args: unknown[]) => {
            scan.orderBy = args;
            return {
              limit: (n: number) => {
                scan.limit = n;
                return Promise.resolve(scanRows.slice(0, n));
              },
            };
          },
        };
      },
    }),
  }));

  const findFirst = vi.fn(async () => ({ context, status }));

  const db = {
    query: { journeyStates: { findFirst } },
    update,
    select,
  } as unknown as Parameters<typeof createJourneyContext>[0]["db"];

  return { db, update, select, findFirst, setCalls, scan };
}

function makeDigestCtx(opts: {
  db: Parameters<typeof createJourneyContext>[0]["db"];
  sleepFor?: ReturnType<typeof vi.fn>;
  logger?: { info: unknown; warn: unknown; error: unknown };
  triggerEvent?: string;
  triggerWhere?: PropertyCondition[];
  journeyId?: string;
  entryLimit?: "once" | "once_per_period" | "unlimited";
  entryPeriod?: DurationObject;
}) {
  return createJourneyContext({
    db: opts.db,
    // biome-ignore lint/suspicious/noExplicitAny: minimal test stub
    hatchet: {} as any,
    hatchetCtx: {
      sleepFor: (opts.sleepFor ?? vi.fn()) as unknown as (
        d: unknown,
      ) => Promise<unknown>,
      waitFor: vi.fn() as unknown as (
        c: unknown,
      ) => Promise<Record<string, unknown>>,
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal test stub
    registry: {} as any,
    logger: (opts.logger ?? {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      // biome-ignore lint/suspicious/noExplicitAny: minimal test stub
    }) as any,
    stateId: "state-1",
    userId: "user-1",
    userEmail: "user@example.com",
    journeyContext: {},
    resolvedTimezone: NY,
    triggerEvent: opts.triggerEvent,
    triggerWhere: opts.triggerWhere,
    journeyId: opts.journeyId,
    entryLimit: opts.entryLimit,
    entryPeriod: opts.entryPeriod,
  });
}

function makeBoundary(overrides?: Partial<JourneyBoundary>): JourneyBoundary {
  return {
    stateId: "state-1",
    runAnchor: "run-1",
    currentLabel: undefined,
    seenKeys: new Set<string>(),
    seenRecordLabels: new Set<string>(),
    memoize: async <T>(_deps: unknown[], fn: () => Promise<T> | T) => fn(),
    ...overrides,
  };
}

/** Pre-seed a recorded digest result under `context.__digest__.<nodeId>:result`. */
function seedResult(nodeId: string, result: unknown): Record<string, unknown> {
  return { __digest__: { [`${nodeId}:result`]: result } };
}

/** Pre-seed a recorded deadline under `context.__digest__.<nodeId>:deadline`. */
function seedDeadline(nodeId: string, iso: string): Record<string, unknown> {
  return { __digest__: { [`${nodeId}:deadline`]: iso } };
}

describe("ctx.digest", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("first run: records the deadline, sleeps ~window, flips waiting→active, scans + records the result chronologically", async () => {
    const scanRows: ScanRow[] = [
      {
        id: "e1",
        properties: { projectId: "a" },
        occurredAt: new Date(FIXED.getTime() - 60_000),
      },
      {
        id: "e2",
        properties: { projectId: "b" },
        occurredAt: new Date(FIXED.getTime() - 30_000),
      },
    ];
    const sleepFor = vi.fn().mockResolvedValue(undefined);
    const dbh = makeDigestDb({ scanRows });
    const ctx = makeDigestCtx({ db: dbh.db, sleepFor });

    const res = await ctx.digest({ window: hours(1), event: "signup" });

    // Deadline recorded (a context write) + result recorded (a second one).
    const contextWrites = dbh.setCalls.filter((c) => "context" in c);
    expect(contextWrites.length).toBe(2);

    // Slept ~the full window (frozen clock → exact).
    expect(sleepFor).toHaveBeenCalledTimes(1);
    expect(sleepFor.mock.calls[0]?.[0]).toBe(3_600_000);

    // waiting → active, tagged with the digest node id.
    expect(
      dbh.setCalls.some(
        (c) => c.status === "waiting" && c.currentNodeId === "digest:signup",
      ),
    ).toBe(true);
    expect(dbh.setCalls.some((c) => c.status === "active")).toBe(true);

    // The flush scan ran and the returned result mirrors it, oldest → newest.
    expect(dbh.scan.called).toBe(1);
    expect(res.count).toBe(2);
    expect(res.truncated).toBe(false);
    expect(res.events.map((e) => e.properties?.projectId)).toEqual(["a", "b"]);
    expect(new Date(res.events[0]?.occurredAt ?? 0).getTime()).toBeLessThan(
      new Date(res.events[1]?.occurredAt ?? 0).getTime(),
    );
    expect(res.flushedAt).toBe(FIXED.toISOString());
  });

  it("replay mid-window: a pre-seeded deadline sleeps only the remainder, not the full window", async () => {
    const tenMinOut = new Date(FIXED.getTime() + 600_000).toISOString();
    const sleepFor = vi.fn().mockResolvedValue(undefined);
    const dbh = makeDigestDb({
      context: seedDeadline("digest:signup", tenMinOut),
    });
    const ctx = makeDigestCtx({ db: dbh.db, sleepFor });

    await ctx.digest({ window: hours(1), event: "signup" });

    expect(sleepFor).toHaveBeenCalledTimes(1);
    // The 10-minute remainder, NOT the 1-hour window.
    expect(sleepFor.mock.calls[0]?.[0]).toBe(600_000);
    // No new deadline write (read-first found the seeded one).
    expect(dbh.setCalls.filter((c) => "context" in c).length).toBe(1); // result only
  });

  it("replay after flush: a pre-seeded result returns verbatim, never sleeps, never flips status, still advances the boundary label", async () => {
    const recorded = {
      events: [
        { properties: { projectId: "z" }, occurredAt: FIXED.toISOString() },
      ],
      count: 1,
      truncated: false,
      flushedAt: FIXED.toISOString(),
    };
    const sleepFor = vi.fn().mockResolvedValue(undefined);
    const dbh = makeDigestDb({
      context: seedResult("digest:signup", recorded),
    });
    const ctx = makeDigestCtx({ db: dbh.db, sleepFor });
    const boundary = makeBoundary();

    const res = await runWithJourneyBoundary(boundary, () =>
      ctx.digest({ window: hours(1), event: "signup" }),
    );

    expect(res).toEqual(recorded);
    expect(sleepFor).not.toHaveBeenCalled();
    expect(dbh.update).not.toHaveBeenCalled();
    // The digest site is still inherited by a subsequent auto-keyed send.
    expect(boundary.currentLabel).toBe("digest:signup");
  });

  it("defaults `event` to the trigger event", async () => {
    const dbh = makeDigestDb();
    const ctx = makeDigestCtx({
      db: dbh.db,
      sleepFor: vi.fn().mockResolvedValue(undefined),
      triggerEvent: "user.signed_up",
    });

    await ctx.digest({ window: hours(1) });

    // The scan filters on the resolved event name.
    expect(compile(dbh.scan.where).params).toContain("user.signed_up");
    expect(
      dbh.setCalls.some((c) => c.currentNodeId === "digest:user.signed_up"),
    ).toBe(true);
  });

  it("throws TypeError before any db call when no event and no trigger event", async () => {
    const dbh = makeDigestDb();
    const ctx = makeDigestCtx({ db: dbh.db });

    await expect(ctx.digest({ window: hours(1) })).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(dbh.findFirst).not.toHaveBeenCalled();
    expect(dbh.update).not.toHaveBeenCalled();
  });

  it("throws RangeError before any db call for a >720h window and for a zero/negative window", async () => {
    const dbh = makeDigestDb();
    const ctx = makeDigestCtx({ db: dbh.db });

    await expect(
      ctx.digest({ window: { hours: 721 }, event: "e" }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      ctx.digest({ window: { hours: 0 }, event: "e" }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      ctx.digest({ window: { minutes: -1 }, event: "e" }),
    ).rejects.toBeInstanceOf(RangeError);

    expect(dbh.findFirst).not.toHaveBeenCalled();
    expect(dbh.update).not.toHaveBeenCalled();
  });

  it("applies the trigger `where` when digesting the trigger event with no explicit `where`", async () => {
    const triggerWhere: PropertyCondition[] = [
      { type: "property", property: "plan", operator: "eq", value: "pro" },
    ];
    const dbh = makeDigestDb();
    const ctx = makeDigestCtx({
      db: dbh.db,
      sleepFor: vi.fn().mockResolvedValue(undefined),
      triggerEvent: "signup",
      triggerWhere,
    });

    await ctx.digest({ window: hours(1) });

    const { params } = compile(dbh.scan.where);
    expect(params).toContain("plan");
    expect(params).toContain("pro");
  });

  it("uses an explicit `where` instead of the trigger `where`", async () => {
    const triggerWhere: PropertyCondition[] = [
      { type: "property", property: "plan", operator: "eq", value: "pro" },
    ];
    const dbh = makeDigestDb();
    const ctx = makeDigestCtx({
      db: dbh.db,
      sleepFor: vi.fn().mockResolvedValue(undefined),
      triggerEvent: "signup",
      triggerWhere,
    });

    await ctx.digest({
      window: hours(1),
      where: [
        { type: "property", property: "tier", operator: "eq", value: "gold" },
      ],
    });

    const { params } = compile(dbh.scan.where);
    expect(params).toContain("tier");
    expect(params).toContain("gold");
    expect(params).not.toContain("plan");
  });

  it("excludes Studio-source events in the scan SQL", async () => {
    const dbh = makeDigestDb();
    const ctx = makeDigestCtx({
      db: dbh.db,
      sleepFor: vi.fn().mockResolvedValue(undefined),
    });

    await ctx.digest({ window: hours(1), event: "signup" });

    expect(compile(dbh.scan.where).sql).toContain("IS DISTINCT FROM 'studio'");
  });

  it("orders occurred_at ASC then id ASC and truncates to the cap (earliest kept)", async () => {
    const scanRows: ScanRow[] = [
      {
        id: "e1",
        properties: { n: 1 },
        occurredAt: new Date(FIXED.getTime() - 3000),
      },
      {
        id: "e2",
        properties: { n: 2 },
        occurredAt: new Date(FIXED.getTime() - 2000),
      },
      {
        id: "e3",
        properties: { n: 3 },
        occurredAt: new Date(FIXED.getTime() - 1000),
      },
    ];
    const dbh = makeDigestDb({ scanRows });
    const ctx = makeDigestCtx({
      db: dbh.db,
      sleepFor: vi.fn().mockResolvedValue(undefined),
    });

    const res = await ctx.digest({
      window: hours(1),
      event: "signup",
      maxEvents: 2,
    });

    // ORDER BY occurred_at ASC, id ASC.
    const [byOccurred, byId] = dbh.scan.orderBy.map((a) =>
      compile(a).sql.toLowerCase(),
    );
    expect(byOccurred).toContain("occurred_at");
    expect(byOccurred).toContain("asc");
    expect(byId).toContain('"id"');
    expect(byId).toContain("asc");

    // Cap 2 with 3 matches → earliest 2, truncated. Where-less fetch = cap + 1.
    expect(dbh.scan.limit).toBe(3);
    expect(res.count).toBe(2);
    expect(res.truncated).toBe(true);
    expect(res.events.map((e) => e.properties?.n)).toEqual([1, 2]);
  });

  it("does not truncate when exactly `cap` rows match (where-less)", async () => {
    const scanRows: ScanRow[] = [
      {
        id: "e1",
        properties: { n: 1 },
        occurredAt: new Date(FIXED.getTime() - 2000),
      },
      {
        id: "e2",
        properties: { n: 2 },
        occurredAt: new Date(FIXED.getTime() - 1000),
      },
    ];
    const dbh = makeDigestDb({ scanRows });
    const ctx = makeDigestCtx({
      db: dbh.db,
      sleepFor: vi.fn().mockResolvedValue(undefined),
    });

    const res = await ctx.digest({
      window: hours(1),
      event: "signup",
      maxEvents: 2,
    });

    // fetch cap + 1 = 3, only 2 rows exist → not truncated.
    expect(dbh.scan.limit).toBe(3);
    expect(res.count).toBe(2);
    expect(res.truncated).toBe(false);
    expect(res.events.length).toBe(2);
  });

  it("fetches cap-relative headroom (min(cap*10, 2000)) when a `where` is present", async () => {
    const dbh = makeDigestDb();
    const ctx = makeDigestCtx({
      db: dbh.db,
      sleepFor: vi.fn().mockResolvedValue(undefined),
    });

    await ctx.digest({
      window: hours(1),
      event: "signup",
      maxEvents: 2,
      where: [
        { type: "property", property: "plan", operator: "eq", value: "pro" },
      ],
    });

    // With a `where` the fetch is a superset re-verified in JS → cap*10, not cap+1.
    expect(dbh.scan.limit).toBe(20);
  });

  it('re-verifies eq in JS: a stored string "50" does NOT match .eq(50)', async () => {
    // The SQL `->>` pushdown compares TEXT and would match "50"; the JS re-verify
    // is strict (`"50" === 50` → false), so the row is excluded.
    const scanRows: ScanRow[] = [
      {
        id: "e1",
        properties: { n: "50" },
        occurredAt: new Date(FIXED.getTime() - 1000),
      },
    ];
    const dbh = makeDigestDb({ scanRows });
    const ctx = makeDigestCtx({
      db: dbh.db,
      sleepFor: vi.fn().mockResolvedValue(undefined),
    });

    const res = await ctx.digest({
      window: hours(1),
      event: "signup",
      where: [{ type: "property", property: "n", operator: "eq", value: 50 }],
    });

    expect(res.count).toBe(0);
    expect(res.events).toEqual([]);
  });

  it("re-verifies eq in JS: an eq-null condition matches a jsonb-null property", async () => {
    // A null-eq is not SQL-pushdownable (`->> p = 'null'` never matches SQL NULL),
    // so it is resolved entirely by the JS path (`null === null` → true).
    const scanRows: ScanRow[] = [
      {
        id: "e1",
        properties: { x: null },
        occurredAt: new Date(FIXED.getTime() - 1000),
      },
    ];
    const dbh = makeDigestDb({ scanRows });
    const ctx = makeDigestCtx({
      db: dbh.db,
      sleepFor: vi.fn().mockResolvedValue(undefined),
    });

    const res = await ctx.digest({
      window: hours(1),
      event: "signup",
      // `value: null` is intentionally outside the PropertyCondition value type.
      where: [
        { type: "property", property: "x", operator: "eq", value: null },
      ] as unknown as PropertyCondition[],
    });

    expect(res.count).toBe(1);
    // The eq-null was NOT pushed into SQL (only non-null eq narrows the fetch).
    expect(compile(dbh.scan.where).params).not.toContain("null");
  });

  it("mid-window exit: a terminal status during the sleep throws JourneyExitedError and records no result", async () => {
    // enter flips (row returned), resume finds 0 rows (exited mid-window).
    const dbh = makeDigestDb({
      returningQueue: [[{ id: "state-1" }], []],
    });
    const ctx = makeDigestCtx({
      db: dbh.db,
      sleepFor: vi.fn().mockResolvedValue(undefined),
    });

    await expect(
      ctx.digest({ window: hours(1), event: "signup" }),
    ).rejects.toBeInstanceOf(JourneyExitedError);

    // Only the deadline was recorded — the flush/result write never runs.
    expect(dbh.setCalls.filter((c) => "context" in c).length).toBe(1);
    expect(dbh.scan.called).toBe(0);
  });

  it("no-sleep wake on a terminal row: elapsed deadline + `exited` status throws before any scan/result write", async () => {
    const elapsed = new Date(FIXED.getTime() - 600_000).toISOString();
    const dbh = makeDigestDb({
      context: seedDeadline("digest:signup", elapsed),
      status: "exited",
    });
    const ctx = makeDigestCtx({
      db: dbh.db,
      sleepFor: vi.fn().mockResolvedValue(undefined),
    });

    await expect(
      ctx.digest({ window: hours(1), event: "signup" }),
    ).rejects.toBeInstanceOf(JourneyExitedError);

    // The status backstop fired: no scan, no status flip, no result write.
    expect(dbh.scan.called).toBe(0);
    expect(dbh.update).not.toHaveBeenCalled();
    expect(dbh.setCalls.filter((c) => "context" in c).length).toBe(0);
  });

  it("no-sleep wake on a parked row: elapsed deadline + `waiting` status flips to active then flushes", async () => {
    const elapsed = new Date(FIXED.getTime() - 600_000).toISOString();
    const dbh = makeDigestDb({
      context: seedDeadline("digest:signup", elapsed),
      status: "waiting",
      scanRows: [
        {
          id: "e1",
          properties: { n: 1 },
          occurredAt: new Date(FIXED.getTime() - 1000),
        },
      ],
    });
    const ctx = makeDigestCtx({
      db: dbh.db,
      sleepFor: vi.fn().mockResolvedValue(undefined),
    });

    const res = await ctx.digest({ window: hours(1), event: "signup" });

    // waiting → active flip fired, no sleep, then the flush scanned + recorded.
    expect(dbh.setCalls.some((c) => c.status === "active")).toBe(true);
    expect(dbh.scan.called).toBe(1);
    expect(res.count).toBe(1);
    expect(dbh.setCalls.filter((c) => "context" in c).length).toBe(1); // result
  });

  it("throws on same-label reuse in one run; distinct labels are fine", async () => {
    // Collision path.
    const dbhA = makeDigestDb();
    const ctxA = makeDigestCtx({
      db: dbhA.db,
      sleepFor: vi.fn().mockResolvedValue(undefined),
    });
    const boundaryA = makeBoundary();
    await runWithJourneyBoundary(boundaryA, async () => {
      await ctxA.digest({ window: hours(1), event: "signup" });
      await expect(
        ctxA.digest({ window: hours(1), event: "signup" }),
      ).rejects.toThrow(/used twice in one journey run/);
    });

    // Distinct labels — no collision.
    const dbhB = makeDigestDb({
      returningQueue: [
        [{ id: "state-1" }],
        [{ id: "state-1" }],
        [{ id: "state-1" }],
        [{ id: "state-1" }],
      ],
    });
    const ctxB = makeDigestCtx({
      db: dbhB.db,
      sleepFor: vi.fn().mockResolvedValue(undefined),
    });
    const boundaryB = makeBoundary();
    await runWithJourneyBoundary(boundaryB, async () => {
      await ctxB.digest({ window: hours(1), event: "signup", label: "a" });
      await expect(
        ctxB.digest({ window: hours(1), event: "signup", label: "b" }),
      ).resolves.toBeDefined();
    });
  });

  it("warns (once) when a `once` journey digests its own trigger event", async () => {
    const warn = vi.fn();
    const dbh = makeDigestDb({
      context: seedResult("digest:evt", {
        events: [],
        count: 0,
        truncated: false,
        flushedAt: FIXED.toISOString(),
      }),
    });
    const ctx = makeDigestCtx({
      db: dbh.db,
      logger: { info: vi.fn(), warn, error: vi.fn() },
      triggerEvent: "evt",
      entryLimit: "once",
      journeyId: "j-once-a",
    });

    // Result pre-seeded → fast path; the warning still fires at step 3.
    await ctx.digest({ window: hours(1) });
    await ctx.digest({ window: hours(1) });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("entryLimit");
  });

  it("warns when once_per_period entryPeriod exceeds the digest window", async () => {
    const warn = vi.fn();
    const dbh = makeDigestDb({
      context: seedResult("digest:evt", {
        events: [],
        count: 0,
        truncated: false,
        flushedAt: FIXED.toISOString(),
      }),
    });
    const ctx = makeDigestCtx({
      db: dbh.db,
      logger: { info: vi.fn(), warn, error: vi.fn() },
      triggerEvent: "evt",
      entryLimit: "once_per_period",
      entryPeriod: days(2),
      journeyId: "j-period-b",
    });

    await ctx.digest({ window: hours(1) });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("entryPeriod");
  });

  it("does not warn when the entryPeriod is within the digest window", async () => {
    const warn = vi.fn();
    const dbh = makeDigestDb({
      context: seedResult("digest:evt", {
        events: [],
        count: 0,
        truncated: false,
        flushedAt: FIXED.toISOString(),
      }),
    });
    const ctx = makeDigestCtx({
      db: dbh.db,
      logger: { info: vi.fn(), warn, error: vi.fn() },
      triggerEvent: "evt",
      entryLimit: "once_per_period",
      entryPeriod: minutes(30),
      journeyId: "j-period-ok",
    });

    await ctx.digest({ window: hours(1) });

    expect(warn).not.toHaveBeenCalled();
  });
});
