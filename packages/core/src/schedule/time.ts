import type { Weekday } from "../types/journey-context.js";

export type { IfPast, Weekday } from "../types/journey-context.js";

/**
 * Map of accepted weekday names (short + full, lowercase) to ISO weekday
 * numbers (Monday = 1 … Sunday = 7), matching `Temporal.PlainDate#dayOfWeek`.
 */
const WEEKDAY_TO_ISO: Record<Weekday, number> = {
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
  sun: 7,
  sunday: 7,
};

/**
 * Resolve a {@link Weekday} name to its ISO weekday number (1..7). Throws on an
 * unknown name — this is author error, not a runtime fall-through case.
 */
export function weekdayToIso(weekday: Weekday): number {
  const iso = WEEKDAY_TO_ISO[weekday.toLowerCase() as Weekday];
  if (iso === undefined) {
    throw new TypeError(`Unknown weekday: "${weekday}"`);
  }
  return iso;
}

/**
 * Parse a `"HH:mm"` string into `{ hour, minute }`. Throws on malformed input
 * (author error — the scheduling API takes a literal time-of-day string).
 */
export function parseTimeOfDay(time: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) {
    throw new TypeError(`Invalid time-of-day (expected "HH:mm"): "${time}"`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new TypeError(`Time-of-day out of range: "${time}"`);
  }
  return { hour, minute };
}
