/**
 * Deterministic colours for acquisition lanes (P3). A lane id (a
 * `campaign.arrived` utm value) hashes to a fixed slot in an 8-colour palette,
 * so the same campaign is always the same colour across polls and reloads —
 * the Studio identity discipline the whole control room runs on.
 *
 * The palette deliberately avoids `#f64838` (the reserved alert red used for
 * the "N stuck" pile-up chip). `organic` — the un-attributed majority — and any
 * unknown lane render neutral, so a coloured rail always means "this campaign".
 */

/** 8 distinct hues, none of them the reserved alert red. */
const PALETTE = [
  "#3b82f6",
  "#a855f7",
  "#2dd4bf",
  "#f59e0b",
  "#3fb950",
  "#ec4899",
  "#38bdf8",
  "#e2e2e2",
] as const;

/** The un-attributed lane (and the resting map) — a calm neutral. */
export const NEUTRAL_LANE_COLOR = "rgba(255,255,255,0.45)";

/** FNV-1a → palette slot. Deterministic: same lane id ⇒ same colour, forever. */
export function laneColor(laneId: string): string {
  if (laneId === "organic") return NEUTRAL_LANE_COLOR;
  let hash = 0x811c9dc5;
  for (let i = 0; i < laneId.length; i++) {
    hash ^= laneId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return PALETTE[(hash >>> 0) % PALETTE.length] as string;
}
