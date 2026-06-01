import { Temporal } from "@js-temporal/polyfill";
import type { DurationObject } from "../duration.js";
import { durationToMs } from "../duration.js";
import type { IfPast, Weekday } from "../types/journey-context.js";
import { parseTimeOfDay, weekdayToIso } from "./time.js";
import { clampToWindow, type SendWindow } from "./window.js";

export interface ScheduleOptions {
  /** Resolved IANA timezone, e.g. "America/New_York". */
  timezone: string;
  /** Explicit "current" instant — no ambient `Date.now()`. */
  now: Date;
  /** Optional quiet-hours window in the same tz. */
  window?: SendWindow;
  /** How to treat a naive resolved instant that is already <= now. */
  ifPast?: IfPast;
}

/**
 * Convert a `ZonedDateTime` to a `Date`, applying the `ifPast` policy and the
 * optional send window. This is the shared tail of every resolver:
 *
 * 1. `ifPast` — `"next"` (default) rolls the instant forward by `rollDays` when
 *    it is at/before `now` (never fewer than 1 day, so a snapped past instant
 *    always lands in the future); `"now"` clamps it to the current instant.
 * 2. `clampToWindow` — if a window is configured, the final instant is mapped
 *    into the open window (the LAST step, after `ifPast`).
 */
function finalize(
  candidate: Temporal.ZonedDateTime,
  opts: ScheduleOptions,
  rollDays: number,
): Date {
  const nowMs = opts.now.getTime();
  let resolved = candidate;

  if (resolved.epochMilliseconds <= nowMs) {
    if ((opts.ifPast ?? "next") === "now") {
      resolved = Temporal.Instant.fromEpochMilliseconds(
        nowMs,
      ).toZonedDateTimeISO(opts.timezone);
    } else {
      // ifPast "next": always roll forward. Resolvers that snap to an
      // arbitrary HH:mm (resolveAfter / resolveTomorrow) pass rollDays 0, so a
      // snapped time landing at/before now must still advance at least one day
      // — otherwise a past instant would be returned and fire immediately.
      resolved = resolved.add({ days: Math.max(rollDays, 1) });
    }
  }

  const instant = new Date(resolved.epochMilliseconds);
  return opts.window
    ? clampToWindow(instant, opts.window, opts.timezone)
    : instant;
}

/**
 * Build the wall-clock `HH:mm` instant on `date` in `opts.timezone`.
 *
 * Disambiguation `"compatible"` (the JS-`Date` rule) is the documented choice:
 * on a spring-forward gap it yields the post-gap instant ("first valid instant
 * going forward"); on a fall-back overlap it yields the earlier occurrence.
 */
function atTime(
  date: Temporal.PlainDate,
  time: string,
  timezone: string,
): Temporal.ZonedDateTime {
  const { hour, minute } = parseTimeOfDay(time);
  return date
    .toPlainDateTime(Temporal.PlainTime.from({ hour, minute }))
    .toZonedDateTime(timezone, { disambiguation: "compatible" });
}

function nowZoned(opts: ScheduleOptions): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(
    opts.now.getTime(),
  ).toZonedDateTimeISO(opts.timezone);
}

/**
 * Next occurrence of `HH:mm` local: today if still in the future (per
 * `ifPast`), otherwise tomorrow.
 */
export function resolveNextLocalTime(
  time: string,
  opts: ScheduleOptions,
): Date {
  const candidate = atTime(nowZoned(opts).toPlainDate(), time, opts.timezone);
  return finalize(candidate, opts, 1);
}

/**
 * Upcoming `weekday` at `HH:mm` local. If today IS the weekday and the time is
 * still in the future, returns today; otherwise the next matching weekday
 * (1..7 days ahead).
 */
export function resolveNextWeekday(
  weekday: Weekday,
  time: string,
  opts: ScheduleOptions,
): Date {
  const targetIso = weekdayToIso(weekday);
  const today = nowZoned(opts).toPlainDate();
  const delta = (targetIso - today.dayOfWeek + 7) % 7;
  const candidate = atTime(today.add({ days: delta }), time, opts.timezone);
  // If the chosen day is today (delta === 0) but the time already passed, roll
  // a full week forward rather than a single day.
  return finalize(candidate, opts, 7);
}

/** Tomorrow (now + 1 calendar day in tz) at `HH:mm` local. */
export function resolveTomorrow(time: string, opts: ScheduleOptions): Date {
  const tomorrow = nowZoned(opts).toPlainDate().add({ days: 1 });
  const candidate = atTime(tomorrow, time, opts.timezone);
  // Tomorrow at HH:mm is already in the future; rollDays 0 means finalize only
  // intervenes for ifPast="now" or the defensive 1-day roll if it ever lands
  // at/before now.
  return finalize(candidate, opts, 0);
}

/**
 * `now` + `duration`, then snapped to `HH:mm` local on the resulting calendar
 * day.
 */
export function resolveAfter(
  duration: DurationObject,
  time: string,
  opts: ScheduleOptions,
): Date {
  const shifted = Temporal.Instant.fromEpochMilliseconds(
    opts.now.getTime() + durationToMs(duration),
  ).toZonedDateTimeISO(opts.timezone);
  const candidate = atTime(shifted.toPlainDate(), time, opts.timezone);
  return finalize(candidate, opts, 0);
}
