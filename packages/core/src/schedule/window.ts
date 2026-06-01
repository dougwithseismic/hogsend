import { Temporal } from "@js-temporal/polyfill";
import { parseTimeOfDay } from "./time.js";

/** A quiet-hours / send window as wall-clock `"HH:mm"` edges in some tz. */
export interface SendWindow {
  start: string;
  end: string;
}

/**
 * Build the absolute instant for a `PlainDate` at `HH:mm` in `timezone`.
 *
 * All wall-clock → instant conversions use disambiguation `"compatible"` (the
 * JS-`Date`-equivalent rule): on a spring-forward gap it picks the later (post-
 * gap) instant; on a fall-back overlap it picks the earlier occurrence. This
 * keeps window edges DST-safe.
 */
function instantAt(
  date: Temporal.PlainDate,
  hour: number,
  minute: number,
  timezone: string,
): Temporal.ZonedDateTime {
  return date
    .toPlainDateTime(Temporal.PlainTime.from({ hour, minute }))
    .toZonedDateTime(timezone, { disambiguation: "compatible" });
}

/**
 * Map an instant into the open send window in `timezone`. No-op if the instant
 * is already inside the window.
 *
 * - Normal window (`start < end`, e.g. `09:00`–`17:00`): open means
 *   `open <= instant < close`. Before open → today's open; at/after close →
 *   tomorrow's open.
 * - Overnight window (`start > end`, e.g. `22:00`–`06:00`): wraps midnight.
 *   Open means `instant >= open` OR `instant < close`. In the quiet daytime
 *   gap → tonight's open.
 * - `start === end` → always open (no clamp).
 *
 * "Next day" uses Temporal calendar arithmetic (`add({ days: 1 })`), so a 23/25-
 * hour DST day still lands on the correct `HH:mm` wall-clock.
 */
export function clampToWindow(
  instant: Date,
  window: SendWindow,
  timezone: string,
): Date {
  const { hour: openH, minute: openM } = parseTimeOfDay(window.start);
  const { hour: closeH, minute: closeM } = parseTimeOfDay(window.end);

  // start === end → always open.
  if (openH === closeH && openM === closeM) {
    return instant;
  }

  const zdt = Temporal.Instant.fromEpochMilliseconds(
    instant.getTime(),
  ).toZonedDateTimeISO(timezone);
  const date = zdt.toPlainDate();

  const todayOpen = instantAt(date, openH, openM, timezone);
  const todayClose = instantAt(date, closeH, closeM, timezone);
  const normal = openH < closeH || (openH === closeH && openM < closeM);

  if (normal) {
    if (Temporal.ZonedDateTime.compare(zdt, todayOpen) < 0) {
      return new Date(todayOpen.epochMilliseconds);
    }
    if (Temporal.ZonedDateTime.compare(zdt, todayClose) >= 0) {
      const tomorrowOpen = instantAt(
        date.add({ days: 1 }),
        openH,
        openM,
        timezone,
      );
      return new Date(tomorrowOpen.epochMilliseconds);
    }
    return instant;
  }

  // Overnight window (start > end): close is in the morning, open in the evening.
  if (Temporal.ZonedDateTime.compare(zdt, todayClose) < 0) {
    return instant; // early-morning open tail
  }
  if (Temporal.ZonedDateTime.compare(zdt, todayOpen) >= 0) {
    return instant; // late-evening open head
  }
  // Quiet daytime gap [close, open) → snap forward to tonight's open.
  return new Date(todayOpen.epochMilliseconds);
}
