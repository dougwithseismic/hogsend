import { randomUUID } from "node:crypto";
import { and, count, eq, isNull } from "drizzle-orm";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getCourse } from "@/lib/courses";
import { db } from "@/lib/db";
import { enrollment, lessonProgress } from "@/lib/db/schema";
import { emitCompleted, emitEnrolled, emitLessonCompleted } from "@/lib/events";
import { source } from "@/lib/source";

type AuthUser = { id: string; email: string; name?: string | null };

/**
 * Read the Better Auth session from request headers. Note: cookieCache (5m) can
 * serve a cached session without a DB hit within that window — acceptable for a
 * free-content gate (worst case: a just-revoked session reads on a little longer).
 */
export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}

/**
 * The FIRST lesson of each course is public (SEO + taste). Lessons sort
 * lexically by `slugs.join("/")` — the `01-`/`02-` numeric prefixes make that
 * identical to meta.json `pages` order (same sort the overview page uses).
 */
function firstLessonSlugByCourse(): Map<string, string> {
  const byCourse = new Map<string, string[]>();
  for (const p of source.getPages()) {
    if (p.slugs.length < 2) continue; // not a lesson page
    const course = p.slugs[0];
    const list = byCourse.get(course) ?? [];
    list.push(p.slugs.join("/"));
    byCourse.set(course, list);
  }
  const first = new Map<string, string>();
  for (const [course, joined] of byCourse) {
    joined.sort();
    if (joined[0]) first.set(course, joined[0]);
  }
  return first;
}

/** Params for generateStaticParams: ONLY the public first lessons get prerendered. */
export function freeLessonParams(): { slug: string[] }[] {
  return [...firstLessonSlugByCourse().values()].map((joined) => ({
    slug: joined.split("/"),
  }));
}

/**
 * Is this lesson free (public)? Non-lesson catch-all hits (`/learn`, `/learn/x`)
 * are not real lessons and aren't gated — only 2+ segment lesson pages are.
 */
export function isFreeLesson(slugs: string[]): boolean {
  if (slugs.length < 2) return true;
  const course = slugs[0];
  return firstLessonSlugByCourse().get(course) === slugs.join("/");
}

/** Total lesson count for a course (for the completion check). */
function lessonCount(courseSlug: string): number {
  return source
    .getPages()
    .filter((p) => p.slugs.length >= 2 && p.slugs[0] === courseSlug).length;
}

/** Idempotent enroll; emits course.enrolled only when a NEW row is inserted. */
export async function ensureEnrollment(
  user: AuthUser,
  courseSlug: string,
): Promise<void> {
  const inserted = await db
    .insert(enrollment)
    .values({ id: randomUUID(), userId: user.id, courseSlug })
    .onConflictDoNothing()
    .returning({ id: enrollment.id });
  if (inserted.length > 0) {
    await emitEnrolled(
      user,
      courseSlug,
      getCourse(courseSlug)?.title ?? courseSlug,
    );
  }
}

/**
 * Idempotent lesson completion. Records progress, emits course.lesson_completed
 * on a genuinely-new row, and emits course.completed when the final lesson lands.
 */
export async function recordLessonProgress(
  user: AuthUser,
  courseSlug: string,
  lessonSlug: string,
  lessonTitle: string,
): Promise<void> {
  await ensureEnrollment(user, courseSlug);

  const inserted = await db
    .insert(lessonProgress)
    .values({ id: randomUUID(), userId: user.id, courseSlug, lessonSlug })
    .onConflictDoNothing()
    .returning({ id: lessonProgress.id });
  if (inserted.length === 0) return; // already recorded — no duplicate event

  await emitLessonCompleted(user, courseSlug, lessonSlug, lessonTitle);

  const total = lessonCount(courseSlug);
  if (total === 0) return;
  const [{ done }] = await db
    .select({ done: count() })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, user.id),
        eq(lessonProgress.courseSlug, courseSlug),
      ),
    );
  if (Number(done) < total) return;

  // Mark the enrollment complete once (the WHERE on completedAt IS NULL makes
  // the course.completed emit fire exactly once).
  const completed = await db
    .update(enrollment)
    .set({ completedAt: new Date() })
    .where(
      and(
        eq(enrollment.userId, user.id),
        eq(enrollment.courseSlug, courseSlug),
        isNull(enrollment.completedAt),
      ),
    )
    .returning({ id: enrollment.id });
  if (completed.length > 0) {
    await emitCompleted(
      user,
      courseSlug,
      getCourse(courseSlug)?.title ?? courseSlug,
    );
  }
}
