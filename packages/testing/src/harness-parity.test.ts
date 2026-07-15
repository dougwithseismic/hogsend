import { days, defineJourney, hours } from "@hogsend/engine/journeys";
import { describe, expect, it } from "vitest";
import { createJourneyTest } from "./index.js";
import type { TestJourneyHistory } from "./types.js";

const user = { id: "u1", email: "dev@acme.com", properties: {} };
const start = "2026-07-14T09:00:00.000Z";

const historyRows = (test: ReturnType<typeof createJourneyTest>) =>
  (
    test as unknown as {
      journeyHistory: TestJourneyHistory[];
    }
  ).journeyHistory;

describe("journey harness production parity", () => {
  it("records concurrent once calls atomically with isolated JSON state", async () => {
    let computes = 0;
    let results: Array<Record<string, unknown>> = [];
    let reread: Record<string, unknown> | undefined;
    let throttle: unknown;

    const journey = defineJourney({
      meta: {
        id: "once-parity",
        name: "Once parity",
        enabled: true,
        trigger: { event: "once.started" },
        entryLimit: "unlimited",
        suppress: hours(0),
      },
      run: async (_current, ctx) => {
        results = await Promise.all([
          ctx.once("shared", async () => {
            computes += 1;
            await Promise.resolve();
            return {
              winner: "first",
              omitted: undefined,
              at: new Date(start),
            };
          }),
          ctx.once("shared", () => {
            computes += 1;
            return { winner: "second" };
          }),
        ]);
        const firstResult = results[0];
        if (!firstResult) throw new Error("once result was not recorded");
        firstResult.winner = "mutated";
        reread = await ctx.once("shared", () => ({ winner: "third" }));
        throttle = await ctx.throttle({
          label: "collision",
          limit: 1,
          window: hours(1),
        });
      },
    });

    const test = createJourneyTest(journey, {
      user,
      now: start,
      // This exact key poisoned throttle when it shared ctx.once's namespace.
      once: { "__throttle__:collision:*:1/3600000": "poisoned" },
    });
    await test.run();

    expect(computes).toBe(1);
    expect(results[1]).toEqual({ winner: "first", at: start });
    expect(reread).toEqual({ winner: "first", at: start });
    expect(throttle).toEqual({ allowed: true, count: 0, remaining: 1 });
  });

  it("tracks the current state and hides future completions until virtual time crosses them", async () => {
    let currentDuring: unknown;
    let futureBefore: unknown;
    let futureAfter: unknown;
    const journey = defineJourney({
      meta: {
        id: "history-parity",
        name: "History parity",
        enabled: true,
        trigger: { event: "history.started" },
        entryLimit: "unlimited",
        suppress: hours(0),
      },
      run: async (current, ctx) => {
        currentDuring = await ctx.history.journey({
          userId: current.id,
          journeyId: "history-parity",
        });
        futureBefore = await ctx.history.journey({
          userId: current.id,
          journeyId: "future-completion",
        });
        await ctx.sleep({ duration: days(3), label: "cross-completion" });
        futureAfter = await ctx.history.journey({
          userId: current.id,
          journeyId: "future-completion",
        });
      },
    });
    const test = createJourneyTest(journey, {
      user,
      now: start,
      history: {
        journeys: [
          {
            userId: user.id,
            journeyId: "future-completion",
            enteredAt: "2026-07-13T09:00:00.000Z",
            completedAt: "2026-07-16T09:00:00.000Z",
            status: "completed",
          },
        ],
      },
    });

    await test.run();
    expect(currentDuring).toEqual({
      completed: false,
      lastCompletedAt: null,
      entryCount: 1,
    });
    expect(futureBefore).toEqual({
      completed: false,
      lastCompletedAt: null,
      entryCount: 1,
    });
    expect(futureAfter).toEqual({
      completed: true,
      lastCompletedAt: "2026-07-16T09:00:00.000Z",
      entryCount: 1,
    });
    await expect(
      test.context.history.journey({
        userId: user.id,
        journeyId: "history-parity",
      }),
    ).resolves.toEqual({
      completed: true,
      lastCompletedAt: "2026-07-17T09:00:00.000Z",
      entryCount: 1,
    });
    expect(historyRows(test).at(-1)?.status).toBe("completed");
  });

  it("marks rejected runs failed while preserving the original error", async () => {
    const expected = new Error("author failure");
    const journey = defineJourney({
      meta: {
        id: "failed-lifecycle",
        name: "Failed lifecycle",
        enabled: true,
        trigger: { event: "failure.started" },
        entryLimit: "unlimited",
        suppress: hours(0),
      },
      run: async () => {
        throw expected;
      },
    });
    const test = createJourneyTest(journey, { user, now: start });

    await expect(test.run()).rejects.toBe(expected);
    expect(historyRows(test).at(-1)).toMatchObject({
      enteredAt: start,
      status: "failed",
    });
  });

  it("captures digest waits and preserves empty event properties as an object", async () => {
    let result: unknown;
    const journey = defineJourney({
      meta: {
        id: "digest-parity",
        name: "Digest parity",
        enabled: true,
        trigger: { event: "digest.started" },
        entryLimit: "unlimited",
        suppress: hours(0),
      },
      run: async (_current, ctx) => {
        result = await ctx.digest({ window: hours(1) });
      },
    });
    const test = createJourneyTest(journey, { user, now: start });

    await test.run();
    expect(result).toMatchObject({
      count: 1,
      events: [{ properties: {}, occurredAt: start }],
      flushedAt: "2026-07-14T10:00:00.000Z",
    });
    expect(test.effects.waits).toEqual([
      {
        type: "digest",
        at: start,
        label: "digest:digest.started",
        event: "digest.started",
        outcome: "resumed",
        resumedAt: "2026-07-14T10:00:00.000Z",
      },
    ]);
  });

  it("exits when a journey emits its own exitOn event at virtual now", async () => {
    let reachedAfterWait = false;
    const journey = defineJourney({
      meta: {
        id: "same-tick-exit",
        name: "Same-tick exit",
        enabled: true,
        trigger: { event: "same-tick.started" },
        entryLimit: "unlimited",
        suppress: hours(0),
        exitOn: [{ event: "same-tick.stop" }],
      },
      run: async (current, ctx) => {
        await ctx.trigger({ event: "same-tick.stop", userId: current.id });
        await ctx.sleep({ duration: hours(1), label: "after-stop" });
        reachedAfterWait = true;
      },
    });
    const test = createJourneyTest(journey, { user, now: start });

    await expect(test.run()).resolves.toBe("exited");
    expect(reachedAfterWait).toBe(false);
    expect(test.effects.exits).toContainEqual({
      at: start,
      source: "exitOn",
      reason: "same-tick.stop",
    });
  });

  it("lets a same-tick exitOn beat an otherwise matching lookback", async () => {
    let reachedAfterWait = false;
    const journey = defineJourney({
      meta: {
        id: "same-tick-lookback-exit",
        name: "Same-tick lookback exit",
        enabled: true,
        trigger: { event: "same-tick-lookback.started" },
        entryLimit: "unlimited",
        suppress: hours(0),
        exitOn: [{ event: "same-tick-lookback.stop" }],
      },
      run: async (current, ctx) => {
        await ctx.trigger({
          event: "same-tick-lookback.stop",
          userId: current.id,
        });
        await ctx.waitForEvent({
          event: "already-there",
          timeout: hours(1),
          lookback: hours(1),
        });
        reachedAfterWait = true;
      },
    });
    const test = createJourneyTest(journey, { user, now: start });
    test.events.emit("already-there");

    await expect(test.run()).resolves.toBe("exited");
    expect(reachedAfterWait).toBe(false);
    expect(test.effects.waits).toContainEqual(
      expect.objectContaining({ type: "waitForEvent", outcome: "exited" }),
    );
  });

  it("exits on a same-tick controller event emitted during an active run", async () => {
    let reachedAfterWait = false;
    let test: ReturnType<typeof createJourneyTest>;
    const journey = defineJourney({
      meta: {
        id: "same-tick-controller-exit",
        name: "Same-tick controller exit",
        enabled: true,
        trigger: { event: "same-tick-controller.started" },
        entryLimit: "unlimited",
        suppress: hours(0),
        exitOn: [{ event: "same-tick-controller.stop" }],
      },
      run: async (_current, ctx) => {
        test.events.emit("same-tick-controller.stop");
        await ctx.sleep({ duration: hours(1), label: "after-controller-stop" });
        reachedAfterWait = true;
      },
    });
    test = createJourneyTest(journey, { user, now: start });

    await expect(test.run()).resolves.toBe("exited");
    expect(reachedAfterWait).toBe(false);
    expect(test.effects.exits).toContainEqual({
      at: start,
      source: "exitOn",
      reason: "same-tick-controller.stop",
    });
  });

  it.each([
    ["sleep", "sleep"],
    ["sleepUntil", "sleepUntil"],
    ["waitForEvent", "waitForEvent"],
    ["digest", "digest"],
  ] as const)("captures an exitOn-interrupted %s attempt", async (operation, expectedType) => {
    const journey = defineJourney({
      meta: {
        id: `interrupted-${operation}`,
        name: `Interrupted ${operation}`,
        enabled: true,
        trigger: { event: "interrupt.started" },
        entryLimit: "unlimited",
        suppress: hours(0),
        exitOn: [{ event: "interrupt.stop" }],
      },
      run: async (_current, ctx) => {
        if (operation === "sleep") {
          await ctx.sleep({ duration: days(1), label: "pending" });
        } else if (operation === "sleepUntil") {
          await ctx.sleepUntil("2026-07-15T09:00:00.000Z", {
            label: "pending",
          });
        } else if (operation === "waitForEvent") {
          await ctx.waitForEvent({
            event: "never.happens",
            timeout: days(1),
            label: "pending",
          });
        } else {
          await ctx.digest({
            event: "never.happens",
            window: days(1),
            label: "pending",
          });
        }
      },
    });
    const test = createJourneyTest(journey, { user, now: start });
    test.events.after(hours(1), "interrupt.stop");

    await expect(test.run()).resolves.toBe("exited");
    expect(test.effects.waits).toHaveLength(1);
    expect(test.effects.waits[0]).toMatchObject({
      type: expectedType,
      at: start,
      label: "pending",
      outcome: "exited",
      resumedAt: "2026-07-14T10:00:00.000Z",
    });
    expect(
      test.timeline.some(
        (item) => item.type === expectedType && item.outcome === "exited",
      ),
    ).toBe(true);
    expect(historyRows(test).at(-1)?.status).toBe("exited");
  });
});
