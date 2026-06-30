import { count, eq } from "drizzle-orm";
import { ALL_ACCESS, ALL_ACCESS_SLUG, COURSES } from "@/lib/courses";
import { db } from "@/lib/db";
import { lessonProgress } from "@/lib/db/schema";
import {
  allAccessConfigured,
  isCoursePaywalled,
  listOwnedSlugs,
} from "@/lib/entitlements";
import { source } from "@/lib/source";

/**
 * The catalog's per-course UI state machine + the all-access banner state. This
 * is the single source the homepage card grid and the course overview consume,
 * so lock/owned/free/coming-soon are computed in exactly one place. Access is
 * always derived from the SESSION user id + DB — signed-out (`userId === null`)
 * does NO DB query and resolves paid courses to "locked".
 */

export type CourseCardState = "free" | "owned" | "locked" | "coming-soon";

export type CourseCardView = {
  slug: string;
  title: string;
  tagline: string;
  level: string;
  estimate: string;
  lessonCount: number;
  priceLabel?: string;
  state: CourseCardState;
  /** Overview route. Always set — even coming-soon links to its teaser page. */
  href: string;
  /** Lessons completed / total, when the user has started it; else null. */
  progress: { done: number; total: number } | null;
};

export type AllAccessView = {
  /** Stripe on AND an all-access price mapped — i.e. actually buyable. */
  configured: boolean;
  owned: boolean;
  title: string;
  tagline: string;
  priceLabel: string;
};

/** Lessons completed per course for a user, in one grouped query (no N+1). */
async function listProgressCounts(
  userId: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({ courseSlug: lessonProgress.courseSlug, done: count() })
    .from(lessonProgress)
    .where(eq(lessonProgress.userId, userId))
    .groupBy(lessonProgress.courseSlug);
  return new Map(rows.map((r) => [r.courseSlug, Number(r.done)]));
}

/** Lesson count per course slug from the content source (0 for coming-soon). */
function lessonCounts(): Map<string, number> {
  const byCourse = new Map<string, number>();
  for (const p of source.getPages()) {
    if (p.slugs.length < 2) continue; // not a lesson page
    const slug = p.slugs[0];
    byCourse.set(slug, (byCourse.get(slug) ?? 0) + 1);
  }
  return byCourse;
}

export async function getCatalog(userId: string | null): Promise<{
  courses: CourseCardView[];
  allAccess: AllAccessView;
}> {
  const counts = lessonCounts();

  let ownedSlugs = new Set<string>();
  let progress = new Map<string, number>();
  if (userId) {
    [ownedSlugs, progress] = await Promise.all([
      listOwnedSlugs(userId),
      listProgressCounts(userId),
    ]);
  }
  const ownsAllAccess = ownedSlugs.has(ALL_ACCESS_SLUG);

  const courses: CourseCardView[] = COURSES.map((c) => {
    const lessonCount = counts.get(c.slug) ?? 0;

    let state: CourseCardState;
    // Belt-and-braces: an empty content folder + no price is coming-soon too,
    // so a course can never render as a clickable-but-empty paid course.
    if (c.comingSoon || (lessonCount === 0 && !c.priceLabel)) {
      state = "coming-soon";
    } else if (!isCoursePaywalled(c.slug)) {
      state = "free"; // free course, or paid course whose price env isn't set
    } else if (userId && (ownsAllAccess || ownedSlugs.has(c.slug))) {
      state = "owned";
    } else {
      state = "locked"; // also the signed-out branch (no DB query above)
    }

    const done = progress.get(c.slug) ?? 0;
    return {
      slug: c.slug,
      title: c.title,
      tagline: c.tagline,
      level: c.level,
      estimate: c.estimate,
      lessonCount,
      priceLabel: c.priceLabel,
      state,
      href: `/${c.slug}`,
      progress:
        userId && lessonCount > 0 && done > 0
          ? { done, total: lessonCount }
          : null,
    };
  });

  const allAccess: AllAccessView = {
    configured: allAccessConfigured(),
    owned: ownsAllAccess,
    title: ALL_ACCESS.title,
    tagline: ALL_ACCESS.tagline,
    priceLabel: ALL_ACCESS.priceLabel,
  };

  return { courses, allAccess };
}
