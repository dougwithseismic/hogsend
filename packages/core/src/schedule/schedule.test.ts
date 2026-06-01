import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vitest";
import { days, hours } from "../duration.js";
import {
  clampToWindow,
  isValidTimeZone,
  parseTimeOfDay,
  resolveAfter,
  resolveNextLocalTime,
  resolveNextWeekday,
  resolveTomorrow,
  weekdayToIso,
} from "./index.js";

const NY = "America/New_York";

/** Build a Date from a wall-clock time in a tz (compatible disambiguation). */
function at(
  tz: string,
  y: number,
  m: number,
  d: number,
  h: number,
  min: number,
): Date {
  const zdt = Temporal.PlainDateTime.from({
    year: y,
    month: m,
    day: d,
    hour: h,
    minute: min,
  }).toZonedDateTime(tz, { disambiguation: "compatible" });
  return new Date(zdt.epochMilliseconds);
}

/** UTC offset string ("-04:00") of a Date in a tz. */
function offsetOf(date: Date, tz: string): string {
  return Temporal.Instant.fromEpochMilliseconds(
    date.getTime(),
  ).toZonedDateTimeISO(tz).offset;
}

/** Local wall-clock "HH:mm" of a Date in a tz. */
function wall(date: Date, tz: string): string {
  const zdt = Temporal.Instant.fromEpochMilliseconds(
    date.getTime(),
  ).toZonedDateTimeISO(tz);
  return `${String(zdt.hour).padStart(2, "0")}:${String(zdt.minute).padStart(
    2,
    "0",
  )}`;
}

describe("parseTimeOfDay", () => {
  it("parses HH:mm", () => {
    expect(parseTimeOfDay("08:30")).toEqual({ hour: 8, minute: 30 });
    expect(parseTimeOfDay("23:59")).toEqual({ hour: 23, minute: 59 });
  });
  it("throws on malformed / out-of-range", () => {
    expect(() => parseTimeOfDay("8h")).toThrow();
    expect(() => parseTimeOfDay("24:00")).toThrow();
    expect(() => parseTimeOfDay("12:60")).toThrow();
  });
});

describe("weekdayToIso", () => {
  it("maps short and full names to the same ISO weekday", () => {
    expect(weekdayToIso("tue")).toBe(2);
    expect(weekdayToIso("tuesday")).toBe(2);
    expect(weekdayToIso("sun")).toBe(7);
    expect(weekdayToIso("monday")).toBe(1);
  });
});

describe("resolveNextLocalTime", () => {
  it("returns same-day when time is still future", () => {
    const now = at(NY, 2026, 6, 1, 10, 0);
    const got = resolveNextLocalTime("14:00", { timezone: NY, now });
    expect(got).toEqual(at(NY, 2026, 6, 1, 14, 0));
  });

  it("rolls to next day when past (ifPast default 'next')", () => {
    const now = at(NY, 2026, 6, 1, 15, 0);
    const got = resolveNextLocalTime("14:00", { timezone: NY, now });
    expect(got).toEqual(at(NY, 2026, 6, 2, 14, 0));
  });

  it("ifPast 'now' clamps to the current instant", () => {
    const now = at(NY, 2026, 6, 1, 15, 0);
    const got = resolveNextLocalTime("14:00", {
      timezone: NY,
      now,
      ifPast: "now",
    });
    expect(got.getTime()).toBe(now.getTime());
  });

  it("exact equality (now == target) rolls forward under 'next'", () => {
    const now = at(NY, 2026, 6, 1, 14, 0);
    const got = resolveNextLocalTime("14:00", { timezone: NY, now });
    expect(got).toEqual(at(NY, 2026, 6, 2, 14, 0));
  });
});

describe("resolveNextWeekday", () => {
  it("short/full names produce identical instants", () => {
    const now = at(NY, 2026, 6, 1, 9, 0); // Monday
    const a = resolveNextWeekday("tue", "08:00", { timezone: NY, now });
    const b = resolveNextWeekday("tuesday", "08:00", { timezone: NY, now });
    expect(a).toEqual(b);
  });

  it("Mon → next Tuesday is tomorrow", () => {
    const now = at(NY, 2026, 6, 1, 9, 0); // Monday 2026-06-01
    const got = resolveNextWeekday("tuesday", "08:00", { timezone: NY, now });
    expect(got).toEqual(at(NY, 2026, 6, 2, 8, 0));
  });

  it("Tue 06:00 → today 08:00 (same-day future)", () => {
    const now = at(NY, 2026, 6, 2, 6, 0); // Tuesday
    const got = resolveNextWeekday("tuesday", "08:00", { timezone: NY, now });
    expect(got).toEqual(at(NY, 2026, 6, 2, 8, 0));
  });

  it("Tue 09:00 → next Tuesday (7 days)", () => {
    const now = at(NY, 2026, 6, 2, 9, 0); // Tuesday
    const got = resolveNextWeekday("tuesday", "08:00", { timezone: NY, now });
    expect(got).toEqual(at(NY, 2026, 6, 9, 8, 0));
  });

  it("Sunday → next Monday is tomorrow (week wrap)", () => {
    const now = at(NY, 2026, 6, 7, 12, 0); // Sunday 2026-06-07
    const got = resolveNextWeekday("monday", "08:00", { timezone: NY, now });
    expect(got).toEqual(at(NY, 2026, 6, 8, 8, 0));
  });
});

describe("resolveTomorrow", () => {
  it("returns tomorrow at HH:mm", () => {
    const now = at(NY, 2026, 6, 1, 10, 0);
    const got = resolveTomorrow("08:00", { timezone: NY, now });
    expect(got).toEqual(at(NY, 2026, 6, 2, 8, 0));
  });
});

describe("resolveAfter", () => {
  it("now + 2 days snapped to 08:00 local", () => {
    const now = at(NY, 2026, 6, 1, 10, 0);
    const got = resolveAfter(days(2), "08:00", { timezone: NY, now });
    expect(got).toEqual(at(NY, 2026, 6, 3, 8, 0));
  });

  it("in 1 hour crossing midnight snaps to next day's HH:mm", () => {
    const now = at(NY, 2026, 6, 1, 23, 30);
    const got = resolveAfter(hours(1), "08:00", { timezone: NY, now });
    // now + 1h => 2026-06-02 00:30 local => snapped to 08:00 that day.
    expect(got).toEqual(at(NY, 2026, 6, 2, 8, 0));
  });

  it("snapped HH:mm earlier than now on the same day rolls forward (not past)", () => {
    // now 09:00, +1h => 10:00 same day, but .at('08:00') pulls back to 08:00
    // which is already in the past. Must roll to tomorrow's 08:00, never < now.
    const now = at(NY, 2026, 6, 1, 9, 0);
    const got = resolveAfter(hours(1), "08:00", { timezone: NY, now });
    expect(got.getTime()).toBeGreaterThan(now.getTime());
    expect(got).toEqual(at(NY, 2026, 6, 2, 8, 0));
  });

  it("snapped HH:mm earlier than now with ifPast 'now' clamps to current instant", () => {
    const now = at(NY, 2026, 6, 1, 9, 0);
    const got = resolveAfter(hours(1), "08:00", {
      timezone: NY,
      now,
      ifPast: "now",
    });
    expect(got.getTime()).toBe(now.getTime());
  });
});

describe("DST handling (America/New_York)", () => {
  it("spring-forward gap (2026-03-08 02:30) picks post-gap EDT instant", () => {
    // Clocks jump 02:00 -> 03:00; 02:30 does not exist.
    const now = at(NY, 2026, 3, 8, 0, 0);
    const got = resolveNextLocalTime("02:30", { timezone: NY, now });
    // "compatible" => later instant; resulting offset is EDT (-04:00).
    expect(offsetOf(got, NY)).toBe("-04:00");
    expect(wall(got, NY)).toBe("03:30");
  });

  it("fall-back overlap (2026-11-01 01:30) picks earlier (EDT) instant", () => {
    const now = at(NY, 2026, 11, 1, 0, 0);
    const got = resolveNextLocalTime("01:30", { timezone: NY, now });
    // The earlier of the two 01:30s is still EDT (-04:00).
    expect(offsetOf(got, NY)).toBe("-04:00");
    expect(wall(got, NY)).toBe("01:30");
  });

  it("resolveTomorrow across spring-forward uses calendar add (not +24h)", () => {
    const now = at(NY, 2026, 3, 7, 23, 0); // EST
    const got = resolveTomorrow("08:00", { timezone: NY, now });
    expect(wall(got, NY)).toBe("08:00");
    expect(offsetOf(got, NY)).toBe("-04:00"); // 2026-03-08 is EDT
  });
});

describe("clampToWindow", () => {
  const win = { start: "09:00", end: "17:00" };

  it("inside window is unchanged", () => {
    const inst = at(NY, 2026, 6, 1, 12, 0);
    expect(clampToWindow(inst, win, NY)).toEqual(inst);
  });

  it("before open snaps to today's open", () => {
    const inst = at(NY, 2026, 6, 1, 7, 0);
    expect(clampToWindow(inst, win, NY)).toEqual(at(NY, 2026, 6, 1, 9, 0));
  });

  it("after close snaps to tomorrow's open", () => {
    const inst = at(NY, 2026, 6, 1, 19, 0);
    expect(clampToWindow(inst, win, NY)).toEqual(at(NY, 2026, 6, 2, 9, 0));
  });

  it("exactly at close (17:00) is treated as after-close", () => {
    const inst = at(NY, 2026, 6, 1, 17, 0);
    expect(clampToWindow(inst, win, NY)).toEqual(at(NY, 2026, 6, 2, 9, 0));
  });

  it("exactly at open (09:00) is unchanged (inclusive)", () => {
    const inst = at(NY, 2026, 6, 1, 9, 0);
    expect(clampToWindow(inst, win, NY)).toEqual(inst);
  });

  it("start === end is always open", () => {
    const inst = at(NY, 2026, 6, 1, 3, 0);
    const allDay = { start: "00:00", end: "00:00" };
    expect(clampToWindow(inst, allDay, NY)).toEqual(inst);
  });

  describe("overnight window 22:00-06:00", () => {
    const overnight = { start: "22:00", end: "06:00" };
    it("23:00 is in the open tail", () => {
      const inst = at(NY, 2026, 6, 1, 23, 0);
      expect(clampToWindow(inst, overnight, NY)).toEqual(inst);
    });
    it("03:00 is in the early-morning open", () => {
      const inst = at(NY, 2026, 6, 1, 3, 0);
      expect(clampToWindow(inst, overnight, NY)).toEqual(inst);
    });
    it("12:00 quiet gap snaps forward to tonight's open", () => {
      const inst = at(NY, 2026, 6, 1, 12, 0);
      expect(clampToWindow(inst, overnight, NY)).toEqual(
        at(NY, 2026, 6, 1, 22, 0),
      );
    });
  });

  it("clamp into next-open via resolver window option", () => {
    // 19:00 local resolved with a 09:00-17:00 window => next day 09:00.
    const now = at(NY, 2026, 6, 1, 10, 0);
    const got = resolveNextLocalTime("19:00", {
      timezone: NY,
      now,
      window: win,
    });
    expect(got).toEqual(at(NY, 2026, 6, 2, 9, 0));
  });
});

describe("isValidTimeZone", () => {
  it("accepts valid IANA zones", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Europe/London")).toBe(true);
  });
  it("rejects invalid / empty without throwing", () => {
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("garbage")).toBe(false);
    // @ts-expect-error testing non-string robustness
    expect(isValidTimeZone(null)).toBe(false);
  });
});
