import { and, eq } from "drizzle-orm";
import { Check, Lock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { JSX } from "react";
import { CheckoutButton } from "@/components/checkout-button";
import { TagPill } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { ProgressBar } from "@/components/ds/progress-bar";
import { getCourseModules, slugsFromUrl } from "@/lib/course-ui";
import { ALL_ACCESS, COURSES, type CourseMeta, getCourse } from "@/lib/courses";
import { db } from "@/lib/db";
import { lessonProgress } from "@/lib/db/schema";
import {
  allAccessConfigured,
  hasAccess,
  isCoursePaywalled,
} from "@/lib/entitlements";
import { getSession, isFreeLesson } from "@/lib/gating";

// Reads the session for owned/completed state, so it's per-request.
export const dynamic = "force-dynamic";

export function generateStaticParams() {
  // Coming-soon courses have no content; don't try to prerender them.
  return COURSES.filter((c) => !c.comingSoon).map((c) => ({ course: c.slug }));
}

export async function generateMetadata(props: {
  params: Promise<{ course: string }>;
}): Promise<Metadata> {
  const { course: slug } = await props.params;
  const course = getCourse(slug);
  if (!course) return {};
  return { title: course.title, description: course.tagline };
}

function ComingSoonOverview({ course }: { course: CourseMeta }): JSX.Element {
  return (
    <article className="container-page py-16 md:py-24">
      <Link
        href="/"
        className="text-sm text-white/40 transition-colors hover:text-white"
      >
        ← All courses
      </Link>

      <div className="mt-8 flex items-center gap-3">
        <p className="kicker">{course.level}</p>
        <TagPill>
          <Lock className="mr-1 size-3" strokeWidth={2} aria-hidden /> Coming
          soon
        </TagPill>
      </div>
      <h1 className="mt-3 max-w-3xl font-display text-[36px] leading-[1.1] tracking-[-0.03em] md:text-[48px]">
        {course.title}
      </h1>
      <p className="mt-5 max-w-2xl text-lg text-white/60 leading-7">
        {course.summary}
      </p>

      <Card className="mt-8 max-w-xl">
        <h2 className="font-display text-xl tracking-[-0.02em]">
          In production
        </h2>
        <p className="mt-2 text-base text-white/60 leading-6">
          This course isn't published yet. Get it — and every other course — the
          moment it lands with All-Access, or start the course that's ready
          today.
        </p>
        <div className="mt-5 flex flex-wrap gap-4">
          <Button href="/" variant="accent" icon>
            Browse available courses
          </Button>
          <Button href="/pricing" variant="outline" icon>
            See pricing
          </Button>
        </div>
      </Card>
    </article>
  );
}

export default async function CourseOverview(props: {
  params: Promise<{ course: string }>;
}) {
  const { course: slug } = await props.params;
  const course = getCourse(slug);
  if (!course) notFound();

  if (course.comingSoon) return <ComingSoonOverview course={course} />;

  const modules = getCourseModules(slug);
  const allLessons = modules.flatMap((m) => m.lessons);
  const first = allLessons[0];
  const indexBySlug = new Map(allLessons.map((l, i) => [l.slug, i]));

  const session = await getSession();
  const userId = session?.user.id ?? null;
  const paywalled = isCoursePaywalled(slug);
  const owned = userId ? await hasAccess(userId, slug) : false;

  const completed = new Set<string>();
  if (userId) {
    const rows = await db
      .select({ lessonSlug: lessonProgress.lessonSlug })
      .from(lessonProgress)
      .where(
        and(
          eq(lessonProgress.userId, userId),
          eq(lessonProgress.courseSlug, slug),
        ),
      );
    for (const r of rows) completed.add(r.lessonSlug);
  }
  const total = allLessons.length;
  // Clamp: stale lessonProgress rows (a lesson renamed/removed after it was
  // completed) could otherwise push done past total → >100%.
  const done = Math.min(completed.size, total);
  const pct = total ? Math.round((done / total) * 100) : 0;
  const nextLesson = allLessons.find((l) => !completed.has(l.slug)) ?? first;
  const locked = paywalled && !owned;

  return (
    <article className="container-page py-16 md:py-24">
      <Link
        href="/"
        className="text-sm text-white/40 transition-colors hover:text-white"
      >
        ← All courses
      </Link>

      <div className="mt-8 flex items-center gap-3">
        <p className="kicker">
          {course.level} · {course.estimate}
        </p>
        {owned ? (
          <TagPill accent>
            <Check className="mr-1 size-3" strokeWidth={2.5} aria-hidden />{" "}
            Owned
          </TagPill>
        ) : null}
      </div>
      <h1 className="mt-3 max-w-3xl font-display text-[36px] leading-[1.1] tracking-[-0.03em] md:text-[48px]">
        {course.title}
      </h1>
      <p className="mt-5 max-w-2xl text-lg text-white/60 leading-7">
        {course.summary}
      </p>

      {/* Primary CTA */}
      <div className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-3">
        {owned || !locked ? (
          nextLesson ? (
            <Button href={nextLesson.url} variant="accent" icon>
              {done > 0 ? `Continue: ${nextLesson.title}` : "Start the course"}
            </Button>
          ) : null
        ) : (
          <>
            <CheckoutButton
              sku={slug}
              next={first?.url}
              label={
                course.priceLabel
                  ? `Unlock the course — ${course.priceLabel}`
                  : "Unlock the course"
              }
            />
            {first ? (
              <Button href={first.url} variant="outline" icon>
                Start free lesson
              </Button>
            ) : null}
          </>
        )}
      </div>

      {locked ? (
        <p className="mt-4 text-sm text-white/50">
          First lesson free · full course {course.priceLabel}.
          {allAccessConfigured() ? (
            <>
              {" "}
              Or unlock every course with{" "}
              <Link href="/pricing" className="text-accent hover:underline">
                All-Access — {ALL_ACCESS.priceLabel}
              </Link>
              .
            </>
          ) : null}
        </p>
      ) : null}

      {/* Progress */}
      {userId && done > 0 ? (
        <div className="mt-8 max-w-md">
          <ProgressBar
            value={done}
            max={total}
            className="h-1.5"
            barClassName="bg-accent"
          />
          <p className="mt-2 text-sm text-white/40">
            {done}/{total} lessons · {pct}% ·{" "}
            <Link
              href="/workbook"
              className="underline transition-colors hover:text-white"
            >
              your workbook
            </Link>
          </p>
        </div>
      ) : null}

      {/* Modules */}
      <div className="mt-14 flex flex-col gap-12">
        {modules.map((mod) => (
          // Key on the module's first lesson URL (globally unique) so duplicate
          // separator labels can't collide; fall back to the name when empty.
          <section key={mod.lessons[0]?.url ?? mod.name ?? "module"}>
            {mod.name ? (
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <h2 className="kicker">{mod.name}</h2>
                {userId ? (
                  <span className="whitespace-nowrap text-sm text-white/40">
                    {mod.lessons.filter((l) => completed.has(l.slug)).length}/
                    {mod.lessons.length} done
                  </span>
                ) : null}
              </div>
            ) : null}
            <ol className="flex flex-col">
              {mod.lessons.map((lesson) => {
                const n = (indexBySlug.get(lesson.slug) ?? 0) + 1;
                const free = isFreeLesson(slugsFromUrl(lesson.url));
                const isDone = completed.has(lesson.slug);
                const isLocked = locked && !free;
                return (
                  <li key={lesson.url}>
                    <Link
                      href={lesson.url}
                      className="group flex items-baseline gap-4 border-hairline-faint border-t py-5 transition-colors hover:bg-white/[0.02]"
                    >
                      <span className="w-8 shrink-0 font-mono text-sm text-white/30">
                        {String(n).padStart(2, "0")}
                      </span>
                      <span className="flex-1">
                        <span className="block font-medium text-white transition-colors group-hover:text-accent">
                          {lesson.title}
                        </span>
                        {lesson.description ? (
                          <span className="mt-1 block text-sm text-white/50 leading-6">
                            {lesson.description}
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0 self-center">
                        {isDone ? (
                          <Check
                            className="size-4 text-accent"
                            strokeWidth={2.5}
                            aria-label="Completed"
                          />
                        ) : free ? (
                          <TagPill accent>Free</TagPill>
                        ) : isLocked ? (
                          <Lock
                            className="size-4 text-white/30"
                            strokeWidth={2}
                            aria-label="Locked"
                          />
                        ) : null}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
    </article>
  );
}
