/**
 * Deal-stage helpers shared by the deals dashboard and the contacts filters.
 * The live ladder comes from `GET /v1/admin/deals/stats` (`stageOrder`);
 * these are the client-side fallbacks + label formatting.
 */

/** Fallback ladder for engines that predate the configurable ladder. */
export const DEFAULT_STAGES = [
  "lead",
  "contacted",
  "survey_booked",
  "quoted",
  "sold",
  "lost",
];

/** Humanize a stage id: "survey_booked" / "poc-review" → "Survey booked". */
export function stageLabel(stage: string): string {
  const words = stage.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
