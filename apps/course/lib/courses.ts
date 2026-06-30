/**
 * Course catalog metadata. Lesson titles/descriptions come from each lesson's
 * MDX frontmatter (read via lib/source); this holds only course-LEVEL info that
 * isn't derivable from the lessons. Phase 1 ships one course.
 */

export type CourseMeta = {
  /** Folder slug under content/courses/ and the route segment. */
  slug: string;
  title: string;
  /** One-line card subtitle. */
  tagline: string;
  /** Paragraph shown on the course overview page. */
  summary: string;
  level: string;
  estimate: string;
  /**
   * Display price for the paywall CTA (e.g. "$49"). Presentational only — the
   * charge is the Stripe Price mapped in PRICE_ENV_BY_SLUG. A course with no
   * mapped Stripe price stays free regardless of this label.
   */
  priceLabel?: string;
};

export const COURSES: CourseMeta[] = [
  {
    slug: "growth-with-posthog",
    title: "Measure, Keep, and Grow",
    tagline:
      "A start-to-finish growth program with PostHog + Hogsend — for the people who build it.",
    summary:
      "Most teams grow by pouring more traffic into a leaky bucket. This course teaches the opposite order: measure what's happening (PostHog) so you can see the leaks, keep the users you already have (lifecycle messaging with Hogsend), then drive traffic and capture every visitor into an audience you own. Nine lessons, start to finish, written for technical founders and the consultants who set this up for them.",
    level: "Beginner → Intermediate",
    estimate: "~2.5 hours",
    priceLabel: "$49",
  },
];

export function getCourse(slug: string): CourseMeta | undefined {
  return COURSES.find((c) => c.slug === slug);
}

/**
 * Course slug → the env var holding its Stripe Price id. Keeping the actual
 * `price_…` id in env (not committed) lets test and live use different ids with
 * the same code. A slug absent here (or whose env var is unset) is NOT paywalled.
 */
const PRICE_ENV_BY_SLUG: Record<string, string> = {
  "growth-with-posthog": "STRIPE_PRICE_GROWTH_WITH_POSTHOG",
};

/** The Stripe Price id for a course, or undefined when none is configured. */
export function priceIdForCourse(slug: string): string | undefined {
  const key = PRICE_ENV_BY_SLUG[slug];
  return key ? process.env[key] : undefined;
}
