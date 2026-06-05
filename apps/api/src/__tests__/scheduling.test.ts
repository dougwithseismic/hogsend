import { days } from "@hogsend/core";
import {
  resolveAfter,
  resolveNextLocalTime,
  resolveNextWeekday,
  resolveTomorrow,
} from "@hogsend/core/schedule";
import { createJourneyContext } from "@hogsend/engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NY = "America/New_York";
// 2026-06-01 10:00 in America/New_York (EDT, -04:00) === 14:00 UTC.
const FIXED = new Date("2026-06-01T14:00:00.000Z");

/** A minimal db stub: update() chains resolve; query/select unused here. The
 * guarded wait lifecycle ends each update in `.returning()` (one row = success;
 * the resume guard throws on zero rows), so `where()` exposes a `returning`. */
function makeDbStub() {
  const set = vi.fn().mockReturnThis();
  const where = vi.fn(() => ({
    returning: vi.fn().mockResolvedValue([{ id: "state-1" }]),
  }));
  const update = vi.fn().mockReturnValue({ set, where });
  return {
    db: { update } as unknown as Parameters<
      typeof createJourneyContext
    >[0]["db"],
    update,
    set,
    where,
  };
}

function makeCtx(opts: {
  timezone: string;
  window?: { start: string; end: string };
  sleepFor: ReturnType<typeof vi.fn>;
}) {
  const { db } = makeDbStub();
  return createJourneyContext({
    db,
    // biome-ignore lint/suspicious/noExplicitAny: minimal test stubs
    hatchet: {} as any,
    hatchetCtx: {
      sleepFor: opts.sleepFor as unknown as (d: unknown) => Promise<unknown>,
      waitFor: vi.fn() as unknown as (
        c: unknown,
      ) => Promise<Record<string, unknown>>,
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal test stubs
    registry: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: minimal test stubs
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    stateId: "state-1",
    userId: "user-1",
    userEmail: "user@example.com",
    journeyContext: {},
    resolvedTimezone: opts.timezone,
    defaultSendWindow: opts.window,
  });
}

describe("ctx.when (thin wrapper over pure resolvers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("matches the pure resolvers given the same tz + now", () => {
    const ctx = makeCtx({ timezone: NY, sleepFor: vi.fn() });
    const baseOpts = { timezone: NY, now: FIXED, ifPast: "next" as const };

    expect(ctx.when.next("tuesday").at("08:00")).toEqual(
      resolveNextWeekday("tuesday", "08:00", baseOpts),
    );
    expect(ctx.when.nextLocal("08:00")).toEqual(
      resolveNextLocalTime("08:00", baseOpts),
    );
    expect(ctx.when.tomorrow().at("08:00")).toEqual(
      resolveTomorrow("08:00", baseOpts),
    );
    expect(ctx.when.in(days(2)).at("08:00")).toEqual(
      resolveAfter(days(2), "08:00", baseOpts),
    );
  });

  it(".tz(...) overrides the bound timezone for the chain", () => {
    const ctx = makeCtx({ timezone: NY, sleepFor: vi.fn() });
    const ny = ctx.when.nextLocal("08:00");
    const utc = ctx.when.tz("UTC").nextLocal("08:00");
    expect(utc).not.toEqual(ny);
    expect(utc).toEqual(
      resolveNextLocalTime("08:00", {
        timezone: "UTC",
        now: FIXED,
        ifPast: "next",
      }),
    );
  });

  it(".tz(...) throws TypeError on an invalid timezone (runtime guard)", () => {
    const ctx = makeCtx({ timezone: NY, sleepFor: vi.fn() });
    // Cast past the TimeZone literal type to simulate a dynamic/bad value.
    expect(() => ctx.when.tz("Not/AZone" as never)).toThrow(TypeError);
  });

  it("auto-applies the default send window and .window(...) overrides it", () => {
    const ctx = makeCtx({
      timezone: NY,
      window: { start: "09:00", end: "17:00" },
      sleepFor: vi.fn(),
    });
    // 19:00 falls after the default window close → next day 09:00.
    const clamped = ctx.when.nextLocal("19:00");
    expect(clamped).toEqual(
      resolveNextLocalTime("19:00", {
        timezone: NY,
        now: FIXED,
        window: { start: "09:00", end: "17:00" },
        ifPast: "next",
      }),
    );
    // An explicit wider window keeps 19:00 the same day.
    const open = ctx.when.window("00:00", "23:59").nextLocal("19:00");
    expect(open).toEqual(
      resolveNextLocalTime("19:00", {
        timezone: NY,
        now: FIXED,
        window: { start: "00:00", end: "23:59" },
        ifPast: "next",
      }),
    );
  });
});

describe("ctx.sleepUntil", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls sleepFor with the positive ms delay (number)", async () => {
    const sleepFor = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ timezone: NY, sleepFor });
    const future = new Date(FIXED.getTime() + 60_000);

    await ctx.sleepUntil(future);

    expect(sleepFor).toHaveBeenCalledTimes(1);
    expect(sleepFor).toHaveBeenCalledWith(60_000);
  });

  it("a past instant yields ms = 0", async () => {
    const sleepFor = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ timezone: NY, sleepFor });

    await ctx.sleepUntil(new Date(FIXED.getTime() - 10_000));

    expect(sleepFor).toHaveBeenCalledWith(0);
  });

  it("Date and ISO string forms produce identical ms", async () => {
    const future = new Date(FIXED.getTime() + 120_000);
    const sleepForA = vi.fn().mockResolvedValue(undefined);
    const sleepForB = vi.fn().mockResolvedValue(undefined);

    await makeCtx({ timezone: NY, sleepFor: sleepForA }).sleepUntil(future);
    await makeCtx({ timezone: NY, sleepFor: sleepForB }).sleepUntil(
      future.toISOString(),
    );

    expect(sleepForA.mock.calls[0]?.[0]).toBe(sleepForB.mock.calls[0]?.[0]);
  });

  it("throws TypeError on an invalid date string", async () => {
    const ctx = makeCtx({ timezone: NY, sleepFor: vi.fn() });
    await expect(ctx.sleepUntil("not-a-date")).rejects.toThrow(TypeError);
  });

  it("transitions journeyStates waiting → active (two updates)", async () => {
    const sleepFor = vi.fn().mockResolvedValue(undefined);
    const { db, update, set } = makeDbStub();
    const ctx = createJourneyContext({
      db,
      // biome-ignore lint/suspicious/noExplicitAny: minimal test stub
      hatchet: {} as any,
      hatchetCtx: {
        sleepFor: sleepFor as unknown as (d: unknown) => Promise<unknown>,
        waitFor: vi.fn() as unknown as (
          c: unknown,
        ) => Promise<Record<string, unknown>>,
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal test stub
      registry: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: minimal test stub
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      stateId: "state-1",
      userId: "user-1",
      userEmail: "user@example.com",
      journeyContext: {},
      resolvedTimezone: NY,
    });

    await ctx.sleepUntil(new Date(FIXED.getTime() + 1000));

    expect(update).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ status: "waiting" }),
    );
    expect(set).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ status: "active" }),
    );
  });
});
