/* ==========================================================================
 *  Field configs + pure time helpers — server AND client safe (no "use client").
 *
 *  A `FieldConfig` describes one hour-lit scene: its frames, the hour→slot
 *  mapping, and (optionally) a fixed timezone for a synchronized event. Swap a
 *  config to ship a new hero — a summer vista, a match day, a holiday — with no
 *  engine code. The React engine that renders a config lives in
 *  `dayfield-shared.tsx`.
 * ========================================================================== */

export type FieldConfig = {
  id: string;
  imageDir: string;
  slots: string[];
  fallbackSlot: string;
  /** hour (0–23) → which painted slot + a short scene label. */
  hours: (hour: number) => { slot: string; label: string };
  /** drives the sun/moon glyph. */
  isDaylight: (hour: number) => boolean;
  /**
   * If set, the field is a FIXED-time event: the hour is read in THIS IANA
   * timezone, so every visitor worldwide sees the same frame at the same
   * absolute moment (e.g. kick-off is kick-off everywhere at once). If unset,
   * the field follows each visitor's own local hour.
   */
  timeZone?: string;
};

/** The wall-clock hour+minute of `date` in `tz` (or local when tz is absent). */
export function hourInZone(
  date: Date,
  tz?: string,
): { hour: number; minute: number } {
  if (!tz) return { hour: date.getHours(), minute: date.getMinutes() };
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (t: string) =>
    Number(parts.find((p) => p.type === t)?.value ?? "0");
  return { hour: get("hour") % 24, minute: get("minute") };
}

/** Server-safe: the current hour a fixed-time field should open on (for SSR,
 *  so a synchronized event paints the right frame with no client flash). */
export function fieldInitialHour(config: FieldConfig): number | undefined {
  if (!config.timeZone) return undefined;
  return hourInZone(new Date(), config.timeZone).hour;
}

export function formatClock(d: Date) {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
}

/** Whole-hour label for preview mode, e.g. 0 → "12 AM", 13 → "1 PM". */
export function formatHour(hour: number) {
  const ampm = hour >= 12 ? "PM" : "AM";
  return `${hour % 12 || 12} ${ampm}`;
}

/* ------------------------------------------------------------- configs --- */

export const LANDSCAPE_FIELD: FieldConfig = {
  id: "vista",
  imageDir: "dayfield",
  slots: [
    "night",
    "dawn",
    "sunrise",
    "morning",
    "midday",
    "afternoon",
    "sunset",
    "dusk",
  ],
  fallbackSlot: "sunset",
  isDaylight: (h) => h >= 6 && h < 20,
  hours: (h) => {
    const map: [number, string, string][] = [
      [5, "dawn", "First light"],
      [6, "sunrise", "Sunrise"],
      [8, "morning", "Morning"],
      [11, "midday", "Midday"],
      [15, "afternoon", "Afternoon"],
      [18, "sunset", "Sunset"],
      [20, "dusk", "Dusk"],
    ];
    for (let i = map.length - 1; i >= 0; i--) {
      if (h >= map[i][0]) return { slot: map[i][1], label: map[i][2] };
    }
    return { slot: "night", label: "Night" };
  },
};

/** Registry so a config can be selected across the server→client boundary by
 *  a serializable id (the object itself holds functions and can't be a prop). */
export function getFieldConfig(id?: string): FieldConfig {
  return id === MATCHDAY_FIELD.id ? MATCHDAY_FIELD : LANDSCAPE_FIELD;
}

export const MATCHDAY_FIELD: FieldConfig = {
  id: "world-cup-final",
  imageDir: "matchday",
  // The final is played in New Jersey — read the hour in the stadium's zone so
  // the whole world sees kick-off (3pm ET / 9pm CET) at the same instant.
  timeZone: "America/New_York",
  slots: [
    "night",
    "dawn",
    "prep",
    "arriving",
    "filling",
    "kickoff",
    "peak",
    "fulltime",
    "aftermath",
  ],
  fallbackSlot: "kickoff",
  isDaylight: (h) => h >= 6 && h < 20,
  hours: (h) => {
    if (h <= 4) return { slot: "night", label: "The small hours" };
    if (h === 5) return { slot: "night", label: "Before dawn" };
    if (h <= 7) return { slot: "dawn", label: "Match-day dawn" };
    if (h <= 10) return { slot: "prep", label: "Pitch prep" };
    if (h <= 12) return { slot: "arriving", label: "Gates open" };
    if (h === 13) return { slot: "arriving", label: "Filling in" };
    if (h === 14) return { slot: "filling", label: "Almost kick-off" };
    if (h === 15) return { slot: "kickoff", label: "Kick-off" };
    if (h === 16) return { slot: "peak", label: "Second half" };
    if (h === 17) return { slot: "fulltime", label: "Full time" };
    if (h <= 22) return { slot: "aftermath", label: "After the final" };
    return { slot: "night", label: "Long after" };
  },
};
