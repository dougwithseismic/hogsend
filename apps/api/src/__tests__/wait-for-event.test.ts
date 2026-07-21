import { days, durationToMs } from "@hogsend/core";
import { createJourneyContext, JourneyExitedError } from "@hogsend/engine";
import { describe, expect, it, vi } from "vitest";

const NY = "America/New_York";

/**
 * A db stub whose `update().set().where().returning()` chain resolves to the
 * next queued rows array — one entry per durable status flip (enter, resume).
 * `setCalls` records the `set(...)` payloads in order so tests can assert the
 * waiting → active transition.
 */
function makeWaitDbStub(
  returningQueue: Array<Array<{ id: string }>> = [
    [{ id: "state-1" }],
    [{ id: "state-1" }],
  ],
) {
  const setCalls: Array<Record<string, unknown>> = [];
  let call = 0;
  const update = vi.fn(() => ({
    set: (vals: Record<string, unknown>) => {
      setCalls.push(vals);
      return {
        where: () => ({
          returning: () => Promise.resolve(returningQueue[call++] ?? []),
        }),
      };
    },
  }));
  const db = { update } as unknown as Parameters<
    typeof createJourneyContext
  >[0]["db"];
  return { db, update, setCalls };
}

function makeCtx(opts: {
  db: Parameters<typeof createJourneyContext>[0]["db"];
  waitFor: ReturnType<typeof vi.fn>;
  userId?: string;
}) {
  return createJourneyContext({
    db: opts.db,
    // biome-ignore lint/suspicious/noExplicitAny: minimal test stub
    hatchet: {} as any,
    hatchetCtx: {
      sleepFor: vi.fn() as unknown as (d: unknown) => Promise<unknown>,
      waitFor: opts.waitFor as unknown as (
        c: unknown,
      ) => Promise<Record<string, unknown>>,
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal test stub
    registry: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: minimal test stub
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    stateId: "state-1",
    userId: opts.userId ?? "user-1",
    userEmail: "user@example.com",
    journeyContext: {},
    resolvedTimezone: NY,
  });
}

/** Pull the rendered conditions out of the `Or(...)` arg passed to `waitFor`. */
function conditionsFrom(waitFor: ReturnType<typeof vi.fn>) {
  const orArg = waitFor.mock.calls[0]?.[0] as {
    conditions: Array<{
      eventKey?: string;
      expression?: string;
      // Normalized to a whole-seconds Go string (see `toSleepDuration`); the
      // legacy number form is kept in the union for older captured shapes.
      sleepFor?: number | string;
    }>;
  };
  return orArg.conditions;
}

describe("ctx.waitForEvent", () => {
  it("resolves { timedOut: false } when the event branch fires", async () => {
    const waitFor = vi.fn().mockResolvedValue({ CREATE: { event: [{}] } });
    const { db, setCalls } = makeWaitDbStub();
    const ctx = makeCtx({ db, waitFor });

    const res = await ctx.waitForEvent({
      event: "activated",
      timeout: days(7),
    });

    expect(res).toEqual({ timedOut: false, actorUserId: "user-1" });
    expect(waitFor).toHaveBeenCalledTimes(1);
    expect(setCalls[0]).toMatchObject({
      status: "waiting",
      currentNodeId: "wait-event:activated",
    });
    expect(setCalls[1]).toMatchObject({ status: "active" });
  });

  it("resolves { timedOut: true } when the timeout branch fires", async () => {
    const waitFor = vi.fn().mockResolvedValue({ CREATE: { timeout: [{}] } });
    const { db, setCalls } = makeWaitDbStub();
    const ctx = makeCtx({ db, waitFor });

    const res = await ctx.waitForEvent({
      event: "activated",
      timeout: days(7),
    });

    expect(res).toEqual({ timedOut: true });
    expect(setCalls[0]).toMatchObject({ status: "waiting" });
    expect(setCalls[1]).toMatchObject({ status: "active" });
  });

  it("treats a missing CREATE envelope as a timeout (defensive)", async () => {
    const waitFor = vi.fn().mockResolvedValue({});
    const { db } = makeWaitDbStub();
    const ctx = makeCtx({ db, waitFor });

    const res = await ctx.waitForEvent({
      event: "activated",
      timeout: days(1),
    });

    expect(res).toEqual({ timedOut: true });
  });

  // The eviction-capable engine returns the `{ CREATE: { … } }` envelope; older
  // / version-unknown engines return the inner object UN-wrapped. Both must
  // discriminate identically.
  it("handles the pre-eviction un-wrapped envelope (event)", async () => {
    const waitFor = vi.fn().mockResolvedValue({ event: [{}] });
    const { db } = makeWaitDbStub();
    const ctx = makeCtx({ db, waitFor });

    const res = await ctx.waitForEvent({
      event: "activated",
      timeout: days(1),
    });

    expect(res).toEqual({ timedOut: false, actorUserId: "user-1" });
  });

  it("handles the pre-eviction un-wrapped envelope (timeout)", async () => {
    const waitFor = vi.fn().mockResolvedValue({ timeout: [{}] });
    const { db } = makeWaitDbStub();
    const ctx = makeCtx({ db, waitFor });

    const res = await ctx.waitForEvent({
      event: "activated",
      timeout: days(1),
    });

    expect(res).toEqual({ timedOut: true });
  });

  // The engine returns matches as `[{ id, data }]` where `data` is the pushed
  // ingest payload ({ userId, userEmail, properties }). The matched event's
  // properties must surface so journeys can branch on the answer.
  it("surfaces the matched event's properties (eviction envelope)", async () => {
    const waitFor = vi.fn().mockResolvedValue({
      CREATE: {
        event: [
          {
            id: "evt-1",
            data: {
              userId: "user-1",
              userEmail: "user@example.com",
              properties: { score: 9, emailSendId: "send-1" },
            },
          },
        ],
      },
    });
    const { db } = makeWaitDbStub();
    const ctx = makeCtx({ db, waitFor });

    const res = await ctx.waitForEvent({
      event: "nps.submitted",
      timeout: days(7),
    });

    expect(res.timedOut).toBe(false);
    expect(res.properties).toMatchObject({ score: 9 });
  });

  it("surfaces properties from an un-wrapped pre-eviction payload", async () => {
    const waitFor = vi.fn().mockResolvedValue({
      event: [{ userId: "user-1", properties: { answer: "yes" } }],
    });
    const { db } = makeWaitDbStub();
    const ctx = makeCtx({ db, waitFor });

    const res = await ctx.waitForEvent({
      event: "checkin.answered",
      timeout: days(1),
    });

    expect(res.timedOut).toBe(false);
    expect(res.properties).toMatchObject({ answer: "yes" });
  });

  it("omits properties when the match carries no payload", async () => {
    const waitFor = vi.fn().mockResolvedValue({ CREATE: { event: [{}] } });
    const { db } = makeWaitDbStub();
    const ctx = makeCtx({ db, waitFor });

    const res = await ctx.waitForEvent({
      event: "activated",
      timeout: days(1),
    });

    expect(res.timedOut).toBe(false);
    expect(res.properties).toBeUndefined();
  });

  it("resolves from a recent user_events row when lookback is set (no wait)", async () => {
    const waitFor = vi.fn();
    const { db } = makeWaitDbStub();
    // The lookback pre-check is a select chain — stub it to return a hit.
    (db as unknown as Record<string, unknown>).select = vi.fn(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () =>
              Promise.resolve([{ properties: { score: 7, source: "email" } }]),
          }),
        }),
      }),
    }));
    const ctx = makeCtx({ db, waitFor });

    const res = await ctx.waitForEvent({
      event: "nps.submitted",
      timeout: days(7),
      lookback: { hours: 1 },
    });

    expect(res.timedOut).toBe(false);
    expect(res.properties).toMatchObject({ score: 7 });
    // The durable wait was never established — the gap event satisfied it.
    expect(waitFor).not.toHaveBeenCalled();
  });

  it("falls through to the durable wait when lookback finds nothing", async () => {
    const waitFor = vi.fn().mockResolvedValue({ CREATE: { timeout: [{}] } });
    const { db } = makeWaitDbStub();
    (db as unknown as Record<string, unknown>).select = vi.fn(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
    }));
    const ctx = makeCtx({ db, waitFor });

    const res = await ctx.waitForEvent({
      event: "nps.submitted",
      timeout: days(1),
      lookback: { hours: 1 },
    });

    expect(res.timedOut).toBe(true);
    expect(waitFor).toHaveBeenCalledTimes(1);
  });

  it("rejects a timeout beyond the 720h execution limit before waiting", async () => {
    const waitFor = vi.fn();
    const { db } = makeWaitDbStub([]);
    const ctx = makeCtx({ db, waitFor });

    await expect(
      // 31 days > 720h
      ctx.waitForEvent({ event: "activated", timeout: days(31) }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(waitFor).not.toHaveBeenCalled();
  });

  it("allows a timeout exactly at the 720h limit", async () => {
    const waitFor = vi.fn().mockResolvedValue({ CREATE: { event: [{}] } });
    const { db } = makeWaitDbStub();
    const ctx = makeCtx({ db, waitFor });

    const res = await ctx.waitForEvent({
      event: "activated",
      timeout: { hours: 720 },
    });

    expect(res).toEqual({ timedOut: false, actorUserId: "user-1" });
    expect(waitFor).toHaveBeenCalledTimes(1);
  });

  it("scopes the wait to the user via an escaped CEL expression", async () => {
    const waitFor = vi.fn().mockResolvedValue({ CREATE: { event: [{}] } });
    const { db } = makeWaitDbStub();
    // userId contains a single quote — must be escaped, not injected.
    const ctx = makeCtx({ db, waitFor, userId: "ab'c" });

    await ctx.waitForEvent({ event: "activated", timeout: days(1) });

    const userCond = conditionsFrom(waitFor).find(
      (c) => c.eventKey === "activated",
    );
    expect(userCond?.expression).toBe("input.userId == 'ab\\'c'");
  });

  it("passes the timeout to the sleep branch as a whole-seconds string", async () => {
    const waitFor = vi.fn().mockResolvedValue({ CREATE: { event: [{}] } });
    const { db } = makeWaitDbStub();
    const ctx = makeCtx({ db, waitFor });

    await ctx.waitForEvent({ event: "activated", timeout: days(7) });

    // A raw ms number renders as a multi-unit Go string ("1m59s"…) some
    // hatchet-lite versions silently no-op; the timeout branch is normalized.
    const sleepCond = conditionsFrom(waitFor).find(
      (c) => c.sleepFor !== undefined,
    );
    expect(sleepCond?.sleepFor).toMatch(/^\d+s$/);
    expect(sleepCond?.sleepFor).toBe(`${durationToMs(days(7)) / 1000}s`);
    expect(sleepCond?.sleepFor).toBe("604800s");
  });

  it("filtered (where) wait: the re-arm timeout is a whole-seconds string", async () => {
    // `where` present → the durable re-arm path (a distinct SleepCondition site).
    // First scan misses, the status stays active, and waitFor times out.
    const waitFor = vi.fn().mockResolvedValue({ CREATE: { timeout: [{}] } });
    const { db } = makeWaitDbStub();
    // Cover the three read shapes the filtered path issues: the wait-deadline
    // read + the status check (`.where().limit()`), and scanForMatch
    // (`.where().orderBy().limit()`). No match, non-terminal status.
    (db as unknown as Record<string, unknown>).select = vi.fn(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: () => Promise.resolve([]) }),
          limit: () => Promise.resolve([{ status: "active" }]),
        }),
      }),
    }));
    // The recorded-outcome read (`__waits__` replay terminal mark): nothing
    // recorded, so the wait runs live.
    (db as unknown as Record<string, unknown>).query = {
      journeyStates: {
        findFirst: vi.fn(async () => ({ context: {} })),
      },
    };
    const ctx = makeCtx({ db, waitFor });

    const res = await ctx.waitForEvent({
      event: "link.clicked",
      timeout: days(7),
      where: [
        { type: "property", property: "linkId", operator: "eq", value: "x" },
      ],
    });

    expect(res.timedOut).toBe(true);
    const sleepCond = conditionsFrom(waitFor).find(
      (c) => c.sleepFor !== undefined,
    );
    expect(sleepCond?.sleepFor).toMatch(/^\d+s$/);
  });

  it("aborts with JourneyExitedError if the journey exited during the wait", async () => {
    const waitFor = vi.fn().mockResolvedValue({ CREATE: { event: [{}] } });
    // Enter succeeds, but the resume update matches 0 rows (state is no longer
    // "waiting" — exitOn flipped it to "exited" mid-wait).
    const { db, setCalls } = makeWaitDbStub([[{ id: "state-1" }], []]);
    const ctx = makeCtx({ db, waitFor });

    await expect(
      ctx.waitForEvent({ event: "activated", timeout: days(1) }),
    ).rejects.toBeInstanceOf(JourneyExitedError);
    // It did enter the wait and attempt the resume flip before aborting.
    expect(setCalls[0]).toMatchObject({ status: "waiting" });
    expect(setCalls[1]).toMatchObject({ status: "active" });
  });

  it("aborts with JourneyExitedError and never waits if already terminal", async () => {
    const waitFor = vi.fn();
    // Enter matches 0 rows — the journey is already terminal.
    const { db } = makeWaitDbStub([[]]);
    const ctx = makeCtx({ db, waitFor });

    await expect(
      ctx.waitForEvent({ event: "activated", timeout: days(1) }),
    ).rejects.toBeInstanceOf(JourneyExitedError);
    expect(waitFor).not.toHaveBeenCalled();
  });
});
