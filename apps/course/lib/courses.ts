/**
 * Course catalog metadata. Lesson titles/descriptions come from each lesson's
 * MDX frontmatter (read via lib/source); this holds only course-LEVEL info that
 * isn't derivable from the lessons. Pure data — no Stripe/DB imports — so it's
 * safe to import from client components (e.g. the sidebar course banner).
 */

/**
 * Reserved SKU for the one-time, lifetime all-access bundle. It is NOT a real
 * course slug and has NO content folder — the guard below fails fast if a real
 * course ever collides with it, and the gate/enrollment/content paths only ever
 * receive real course slugs, so this never leaks into them.
 */
export const ALL_ACCESS_SLUG = "all-access";

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
  /**
   * A teaser course with no content yet: no MDX folder, no Stripe price, not
   * purchasable. Renders as a locked "coming soon" card + an overview teaser.
   */
  comingSoon?: boolean;
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
  {
    slug: "becoming-a-product-team",
    title: "Becoming a Product Team",
    tagline:
      "Turn a group of builders into a team that ships outcomes, not output.",
    summary:
      "Most companies have engineers, designers, and a backlog — but not a product team. This course is about the shift: how a group that ships features becomes a team that owns outcomes, runs on evidence, and decides what not to build. Written for founders and engineers stepping into the product seat.",
    level: "Intermediate",
    estimate: "Coming soon",
    comingSoon: true,
  },
];

// Fail fast: a content course must never collide with the reserved all-access SKU.
if (COURSES.some((c) => c.slug === ALL_ACCESS_SLUG)) {
  throw new Error(
    `"${ALL_ACCESS_SLUG}" is a reserved SKU and cannot be used as a course slug.`,
  );
}

/**
 * Presentational descriptor for the all-access bundle (which is a SKU, not a
 * CourseMeta). The real charge is always the Stripe Price mapped under
 * ALL_ACCESS_SLUG in PRICE_ENV_BY_SLUG — priceLabel is display-only.
 */
export const ALL_ACCESS = {
  slug: ALL_ACCESS_SLUG,
  title: "All-Access Pass",
  tagline:
    "Every course, including the ones we haven't written yet. One payment, lifetime access.",
  priceLabel: "$99",
} as const;

export function getCourse(slug: string): CourseMeta | undefined {
  return COURSES.find((c) => c.slug === slug);
}

/**
 * Human title for any SKU, including the all-access bundle (not a CourseMeta).
 * Falls back to the raw slug. Used by the webhook event + the billing list so an
 * all-access row reads "All-Access Pass", not "all-access".
 */
export function skuTitle(slug: string): string {
  if (slug === ALL_ACCESS_SLUG) return ALL_ACCESS.title;
  return getCourse(slug)?.title ?? slug;
}

/**
 * SKU slug → the env var holding its Stripe Price id. Keeping the actual
 * `price_…` id in env (not committed) lets test and live use different ids with
 * the same code. A slug absent here (or whose env var is unset) is NOT paywalled.
 */
const PRICE_ENV_BY_SLUG: Record<string, string> = {
  "growth-with-posthog": "STRIPE_PRICE_GROWTH_WITH_POSTHOG",
  [ALL_ACCESS_SLUG]: "STRIPE_PRICE_ALL_ACCESS",
};

/** The Stripe Price id for a SKU, or undefined when none is configured. */
export function priceIdForCourse(slug: string): string | undefined {
  const key = PRICE_ENV_BY_SLUG[slug];
  return key ? process.env[key] : undefined;
}
