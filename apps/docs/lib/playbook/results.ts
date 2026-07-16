/**
 * Time-to-results filter buckets. `timeToResults` stays a freeform honest
 * label in frontmatter ("same day", "2–3 days", …); resultsBucket() folds it
 * into one of these coarse buckets for the filter drawer.
 */
export const RESULTS_BUCKETS = {
  "same-day": { label: "Same day" },
  week: { label: "Within a week" },
  month: { label: "Weeks to a month" },
  ongoing: { label: "Ongoing" },
} as const;

export type ResultsBucketSlug = keyof typeof RESULTS_BUCKETS;

export function isResultsBucketSlug(slug: string): slug is ResultsBucketSlug {
  return slug in RESULTS_BUCKETS;
}

export function resultsBucket(
  timeToResults?: string,
): ResultsBucketSlug | undefined {
  if (!timeToResults) return undefined;
  const label = timeToResults.toLowerCase();
  if (label.includes("same day")) return "same-day";
  if (label.includes("ongoing")) return "ongoing";
  if (label.includes("month") || label.includes("4 weeks")) return "month";
  return "week";
}
