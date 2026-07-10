import { durationToMs } from "@hogsend/core";
import {
  countRecentSends,
  createJourneyContext,
  days,
  hours,
  type JourneyBoundary,
  runWithJourneyBoundary,
} from "@hogsend/engine";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

const dialect = new PgDialect();
/** Compile a captured drizzle `SQL`/`and(...)` to `{ sql, params }`. */
function compile(cond: unknown): { sql: string; params: unknown[] } {
  const q = dialect.sqlToQuery(cond as SQL);
  return { sql: q.sql, params: q.params };
}

/**
 * A db double covering the three chains `ctx.throttle` drives:
 *  • `query.journeyStates.findFirst` — recordOnce read-first / read-back (returns
 *    the SAME `context`, empty by default so the verdict is computed fresh).
 *  • `select({n}).from().where(cond)` — the `countRecentSends` COUNT; resolves a
 *    fixed `n` and captures the AND-condition `cond` for assertions.
 *  • `update().set().where()` — recordOnce's write; `setCalls` captures the
 *    context-write SQL so a test can decode the recorded `(key → verdict)`.
 */
function makeThrottleDb(opts?: {
  count?: number;
  context?: Record<string, unknown>;
}) {
  const context = opts?.context ?? {};
  const countValue = opts?.count ?? 0;
  const setCalls: Array<Record<string, unknown>> = [];
  const captured: { where?: unknown } = {};

  const update = vi.fn(() => ({
    set: (vals: Record<string, unknown>) => {
      setCalls.push(vals);
      return { where: () => Promise.resolve([]) };
    },
  }));

  const select = vi.fn(() => ({
    from: () => ({
      where: (cond: unknown) => {
        captured.where = cond;
        return Promise.resolve([{ n: countValue }]);
      },
    }),
  }));

  const findFirst = vi.fn(async () => ({ context }));

  const db = {
    query: { journeyStates: { findFirst } },
    update,
    select,
  } as unknown as Parameters<typeof createJourneyContext>[0]["db"];

  return { db, update, select, findFirst, setCalls, captured };
}

function makeThrottleCtx(db: Parameters<typeof createJourneyContext>[0]["db"]) {
  return createJourneyContext({
    db,
    // biome-ignore lint/suspicious/noExplicitAny: minimal test stub
    hatchet: {} as any,
    hatchetCtx: {
      sleepFor: vi.fn() as unknown as (d: unknown) => Promise<unknown>,
      waitFor: vi.fn() as unknown as (
        c: unknown,
      ) => Promise<Record<string, unknown>>,
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal test stub
    registry: {} as any,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      // biome-ignore lint/suspicious/noExplicitAny: minimal test stub
    } as any,
    stateId: "state-1",
    userId: "user-1",
    userEmail: "user@example.com",
    journeyContext: {},
    resolvedTimezone: "UTC",
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

/** Decode the recordOnce context writes into `{ key, value }` pairs — the write
 * SQL binds `jsonb_build_object(<key>::text, <json>::jsonb)`, so params = [key,
 * jsonValue]. */
function recordWrites(
  setCalls: Array<Record<string, unknown>>,
): Array<{ key: string; value: unknown }> {
  return setCalls
    .filter((c) => "context" in c)
    .map((c) => {
      const { params } = compile(c.context);
      return {
        key: params[0] as string,
        value: JSON.parse(params[1] as string),
      };
    });
}

describe("ctx.throttle (unit)", () => {
  it("count < limit → allowed with correct remaining; count >= limit → blocked, remaining 0", async () => {
    const under = makeThrottleDb({ count: 2 });
    const ctxUnder = makeThrottleCtx(under.db);
    const okVerdict = await ctxUnder.throttle({ limit: 3, window: days(7) });
    expect(okVerdict).toEqual({ allowed: true, count: 2, remaining: 1 });

    const at = makeThrottleDb({ count: 3 });
    const ctxAt = makeThrottleCtx(at.db);
    const atVerdict = await ctxAt.throttle({ limit: 3, window: days(7) });
    expect(atVerdict).toEqual({ allowed: false, count: 3, remaining: 0 });

    const over = makeThrottleDb({ count: 5 });
    const ctxOver = makeThrottleCtx(over.db);
    const overVerdict = await ctxOver.throttle({ limit: 3, window: days(7) });
    expect(overVerdict).toEqual({ allowed: false, count: 5, remaining: 0 });
  });

  it("counts by recipient email + non-failed status; a category narrows the COUNT, absent otherwise", async () => {
    // Without a category: recipient-email eq + ne(status,'failed'), NO category.
    const plain = makeThrottleDb({ count: 0 });
    await makeThrottleCtx(plain.db).throttle({ limit: 1, window: days(7) });
    const plainWhere = compile(plain.captured.where);
    expect(plainWhere.sql).toContain('"to_email"');
    expect(plainWhere.sql).toContain('"status"');
    // ne renders as `<>`; the excluded status is bound as a param.
    expect(plainWhere.sql).toContain("<>");
    expect(plainWhere.params).toContain("user@example.com");
    expect(plainWhere.params).toContain("failed");
    expect(plainWhere.sql).not.toContain('"category"');

    // With a category: the COUNT additionally filters `category = <category>`.
    const scoped = makeThrottleDb({ count: 0 });
    await makeThrottleCtx(scoped.db).throttle({
      limit: 1,
      window: days(7),
      category: "marketing",
    });
    const scopedWhere = compile(scoped.captured.where);
    expect(scopedWhere.sql).toContain('"category"');
    expect(scopedWhere.params).toContain("marketing");
  });

  it("throws RangeError before any db call for a bad limit or window", async () => {
    for (const bad of [
      { limit: 0, window: days(7) },
      { limit: 2.5, window: days(7) },
      { limit: -1, window: days(7) },
      { limit: 3, window: { hours: 0 } },
      { limit: 3, window: { minutes: -1 } },
    ]) {
      const dbh = makeThrottleDb();
      const ctx = makeThrottleCtx(dbh.db);
      await expect(ctx.throttle(bad)).rejects.toBeInstanceOf(RangeError);
      expect(dbh.findFirst).not.toHaveBeenCalled();
      expect(dbh.select).not.toHaveBeenCalled();
      expect(dbh.update).not.toHaveBeenCalled();
    }
  });

  it("identical duplicate site throws the collision error; a distinct label records an independent verdict", async () => {
    // Collision: two identical throttle calls at the same site (no label) derive
    // the same record key and throw the loud duplicate-label error.
    const dupDb = makeThrottleDb({ count: 1 });
    const dupCtx = makeThrottleCtx(dupDb.db);
    await runWithJourneyBoundary(makeBoundary(), async () => {
      await dupCtx.throttle({ limit: 3, window: days(7) });
      await expect(
        dupCtx.throttle({ limit: 3, window: days(7) }),
      ).rejects.toThrow(/used twice in one journey run/);
    });

    // Distinct labels: two independent records under different keys, both
    // verdicts persisted.
    const twoDb = makeThrottleDb({ count: 1 });
    const twoCtx = makeThrottleCtx(twoDb.db);
    await runWithJourneyBoundary(makeBoundary(), async () => {
      await twoCtx.throttle({ limit: 3, window: days(7), label: "nudge-a" });
      await twoCtx.throttle({ limit: 3, window: days(7), label: "nudge-b" });
    });
    const writes = recordWrites(twoDb.setCalls);
    const windowMs = durationToMs(days(7));
    const keys = writes.map((w) => w.key);
    expect(keys).toContain(`nudge-a:*:3/${windowMs}`);
    expect(keys).toContain(`nudge-b:*:3/${windowMs}`);
    expect(keys[0]).not.toBe(keys[1]);
    for (const w of writes) {
      expect(w.value).toEqual({ allowed: true, count: 1, remaining: 2 });
    }
  });

  it("site defaulting: no boundary → 'start'; a boundary currentLabel becomes the site", async () => {
    const windowMs = durationToMs(days(7));

    // No boundary → the site defaults to "start".
    const startDb = makeThrottleDb({ count: 0 });
    await makeThrottleCtx(startDb.db).throttle({ limit: 3, window: days(7) });
    expect(recordWrites(startDb.setCalls)[0]?.key).toBe(
      `start:*:3/${windowMs}`,
    );

    // A boundary currentLabel (set by a prior wait/checkpoint) becomes the site.
    const labelDb = makeThrottleDb({ count: 0 });
    const labelCtx = makeThrottleCtx(labelDb.db);
    await runWithJourneyBoundary(
      makeBoundary({ currentLabel: "after-wait" }),
      () => labelCtx.throttle({ limit: 3, window: days(7) }),
    );
    expect(recordWrites(labelDb.setCalls)[0]?.key).toBe(
      `after-wait:*:3/${windowMs}`,
    );
  });

  it("a 'transactional' category IS counted here (no exemption) — verdict reflects the stubbed count", async () => {
    const dbh = makeThrottleDb({ count: 5 });
    const ctx = makeThrottleCtx(dbh.db);

    const verdict = await ctx.throttle({
      limit: 3,
      window: days(7),
      category: "transactional",
    });

    // The COUNT ran, filtered by category (contrast: isFrequencyCapped exempts
    // "transactional" and never counts).
    expect(dbh.select).toHaveBeenCalled();
    const where = compile(dbh.captured.where);
    expect(where.sql).toContain('"category"');
    expect(where.params).toContain("transactional");
    // 5 >= 3 → blocked; the verdict reflects the counted transactional sends.
    expect(verdict).toEqual({ allowed: false, count: 5, remaining: 0 });
  });
});

describe("countRecentSends (direct)", () => {
  function makeCountDb(n: number) {
    const captured: { where?: unknown } = {};
    const db = {
      select: () => ({
        from: () => ({
          where: (cond: unknown) => {
            captured.where = cond;
            return Promise.resolve([{ n }]);
          },
        }),
      }),
      // biome-ignore lint/suspicious/noExplicitAny: minimal test double
    } as any;
    return { db, captured };
  }

  it("returns the stubbed count and omits/includes the category condition", async () => {
    const plain = makeCountDb(7);
    const n1 = await countRecentSends({
      db: plain.db,
      to: "a@b.com",
      since: new Date(Date.now() - durationToMs(hours(24))),
    });
    expect(n1).toBe(7);
    expect(compile(plain.captured.where).sql).not.toContain('"category"');
    expect(compile(plain.captured.where).params).toContain("a@b.com");

    const scoped = makeCountDb(4);
    const n2 = await countRecentSends({
      db: scoped.db,
      to: "a@b.com",
      since: new Date(Date.now() - durationToMs(hours(24))),
      category: "marketing",
    });
    expect(n2).toBe(4);
    expect(compile(scoped.captured.where).sql).toContain('"category"');
    expect(compile(scoped.captured.where).params).toContain("marketing");
  });
});
