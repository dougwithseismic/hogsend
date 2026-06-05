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
      sleepFor?: number;
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

    expect(res).toEqual({ timedOut: false });
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

    expect(res).toEqual({ timedOut: false });
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

    expect(res).toEqual({ timedOut: false });
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

  it("passes the timeout to the sleep branch as milliseconds", async () => {
    const waitFor = vi.fn().mockResolvedValue({ CREATE: { event: [{}] } });
    const { db } = makeWaitDbStub();
    const ctx = makeCtx({ db, waitFor });

    await ctx.waitForEvent({ event: "activated", timeout: days(7) });

    const sleepCond = conditionsFrom(waitFor).find(
      (c) => c.sleepFor !== undefined,
    );
    expect(sleepCond?.sleepFor).toBe(durationToMs(days(7)));
    expect(sleepCond?.sleepFor).toBe(604_800_000);
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
