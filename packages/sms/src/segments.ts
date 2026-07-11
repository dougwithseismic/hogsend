// GSM 03.38 basic character set (each is one septet).
const GSM7_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";

// GSM 03.38 extension set — each of these costs TWO septets (ESC + char).
const GSM7_EXTENSION = "^{}\\[~]|€";

const GSM7_BASIC_SET = new Set(GSM7_BASIC);
const GSM7_EXTENSION_SET = new Set(GSM7_EXTENSION);

export interface SmsSegmentCount {
  segments: number;
  encoding: "gsm7" | "ucs2";
  /** Billable character units (septets for gsm7, code units for ucs2). */
  units: number;
}

/**
 * Count SMS segments for a body, matching how carriers bill.
 *
 * GSM-7 (all chars in the GSM 03.38 set): 160 units in a single segment, 153
 * per segment once concatenated (7 septets go to the UDH). Extension-table
 * chars (`^{}\[~]|€`) cost 2 units each.
 *
 * UCS-2 (any non-GSM char, e.g. emoji): 70 code units single, 67 concatenated
 * (surrogate pairs count as 2 code units — a segment must not split one, but
 * for billing the unit count is what matters).
 */
export function countSmsSegments(body: string): SmsSegmentCount {
  const chars = [...body];
  const isGsm7 = chars.every(
    (c) => GSM7_BASIC_SET.has(c) || GSM7_EXTENSION_SET.has(c),
  );

  if (isGsm7) {
    let units = 0;
    for (const c of chars) units += GSM7_EXTENSION_SET.has(c) ? 2 : 1;
    const segments =
      units <= 160
        ? Math.max(1, Math.ceil(units / 160))
        : Math.ceil(units / 153);
    return { segments, encoding: "gsm7", units };
  }

  // UCS-2: count UTF-16 code units (a surrogate pair = 2).
  let units = 0;
  for (const c of chars) units += c.length; // c.length is 2 for astral chars
  const segments =
    units <= 70 ? Math.max(1, Math.ceil(units / 70)) : Math.ceil(units / 67);
  return { segments, encoding: "ucs2", units };
}
