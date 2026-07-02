import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CheckIn } from "@/components/course/check-in";
import { Checklist } from "@/components/course/checklist";
import { LessonProvider } from "@/components/course/lesson-context";
import {
  WorkbookCourseProgress,
  WorkbookMediaRow,
  WorkbookQuizRow,
} from "@/components/course/workbook-extras";
import { WorkbookPrompt } from "@/components/course/workbook-prompt";
import { WorkbookStateProvider } from "@/components/course/workbook-state";
import { auth } from "@/lib/auth";
import { getCourse } from "@/lib/courses";
import { db } from "@/lib/db";
import { enrollment, response } from "@/lib/db/schema";
import { source } from "@/lib/source";
import {
  courseWorkbookLessons,
  dedupeByKey,
  itemState,
  type SavedValue,
  WORKBOOK_MANIFEST,
  type WorkbookItem,
} from "@/lib/workbook";

// Reads the session + the user's DB rows — always per-request.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your workbook",
  robots: { index: false, follow: false },
};

/**
 * The reader's workbook: every interactive item each course will ask of them,
 * grouped per course → chapter in course order, with the FULL structure shown —
 * filled answers editable right here (the same blocks the lessons render),
 * unfilled ones ghosted in with a jump link to where they live. A per-course
 * progress meter and a "continue where you left off" pointer keep the next
 * action obvious.
 */

type CourseSection = {
  slug: string;
  title: string;
  items: WorkbookItem[]; // deduped, course order — for progress
  lessons: Array<{
    lesson: string;
    title: string;
    url: string;
    items: WorkbookItem[]; // deduped against earlier lessons
  }>;
};

function buildCourseSection(slug: string): CourseSection {
  const seen = new Set<string>();
  const lessons: CourseSection["lessons"] = [];
  for (const { lesson, items } of courseWorkbookLessons(slug)) {
    const fresh = items.filter((item) => {
      if (seen.has(item.key)) return false;
      seen.add(item.key);
      return true;
    });
    if (fresh.length === 0) continue;
    const page = source.getPage([slug, lesson]);
    lessons.push({
      lesson,
      title: page?.data.title ?? lesson,
      url: page?.url ?? `/learn/${slug}/${lesson}`,
      items: fresh,
    });
  }
  const items = lessons.flatMap((l) => l.items);
  return {
    slug,
    title: getCourse(slug)?.title ?? slug,
    items,
    lessons,
  };
}

/** First unfilled item in course order — the "continue here" pointer. */
function nextOpenItem(
  section: CourseSection,
  values: Record<string, SavedValue>,
): { item: WorkbookItem; lessonTitle: string; href: string } | null {
  for (const lesson of section.lessons) {
    for (const item of lesson.items) {
      if (itemState(item, values[item.key] ?? null).status !== "done") {
        return {
          item,
          lessonTitle: lesson.title,
          href: `${lesson.url}#${item.anchor}`,
        };
      }
    }
  }
  return null;
}

function LessonItems({
  courseSlug,
  lesson,
  url,
  items,
}: {
  courseSlug: string;
  lesson: string;
  url: string;
  items: WorkbookItem[];
}) {
  return (
    <LessonProvider course={courseSlug} lesson={lesson}>
      {items.map((item) => {
        const href = `${url}#${item.anchor}`;
        switch (item.kind) {
          case "note":
            return (
              <WorkbookPrompt
                key={item.key}
                id={item.id ?? ""}
                prompt={item.label}
                placeholder={item.placeholder}
                rows={item.rows}
              />
            );
          case "profile":
            return (
              <CheckIn
                key={item.key}
                id={item.id ?? ""}
                question={item.label}
                options={item.options ?? []}
                multi={item.multi}
                freeText={item.freeText}
              />
            );
          case "checklist":
            return (
              <Checklist
                key={item.key}
                id={item.id ?? ""}
                title={item.label}
                items={item.items ?? []}
              />
            );
          case "quiz":
            return <WorkbookQuizRow key={item.key} item={item} href={href} />;
          case "media":
            return <WorkbookMediaRow key={item.key} item={item} href={href} />;
          default:
            return null;
        }
      })}
    </LessonProvider>
  );
}

export default async function WorkbookPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in?next=/workbook");

  const [rows, enrollments] = await Promise.all([
    db
      .select({ key: response.key, value: response.value })
      .from(response)
      .where(eq(response.userId, session.user.id)),
    db
      .select({ courseSlug: enrollment.courseSlug })
      .from(enrollment)
      .where(eq(enrollment.userId, session.user.id)),
  ]);

  const values: Record<string, SavedValue> = Object.fromEntries(
    rows.map((row) => [row.key, row.value as SavedValue]),
  );

  // A course belongs in the workbook once the reader is enrolled OR has any
  // saved answer for one of its items (free-lesson answers precede enrollment).
  const enrolled = new Set(enrollments.map((e) => e.courseSlug));
  const savedKeys = new Set(Object.keys(values));
  const courseSlugs = Object.keys(WORKBOOK_MANIFEST).filter(
    (slug) =>
      enrolled.has(slug) ||
      dedupeByKey(courseWorkbookLessons(slug).flatMap((l) => l.items)).some(
        (item) => savedKeys.has(item.key),
      ),
  );

  const sections = courseSlugs.map(buildCourseSection);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-16">
      <h1 className="font-display text-3xl tracking-[-0.02em]">
        Your workbook
      </h1>
      <p className="mt-2 text-sm text-white/55 leading-6">
        Every exercise your courses ask of you, in one place — what you've
        written and answered is editable right here, and what you haven't yet is
        waiting with a link to the chapter it lives in.
      </p>

      {sections.length === 0 ? (
        <div className="mt-10 rounded-md border border-white/[0.08] bg-white/[0.015] p-8 text-center">
          <p className="text-sm text-white/60">
            Nothing here yet. Start a course and everything you write, answer,
            and tick lands here automatically.
          </p>
          <Link
            href="/"
            className="mt-4 inline-block rounded-[10px] border border-white/[0.12] bg-white/[0.03] px-4 py-2 font-medium text-sm text-white transition-colors hover:border-white/30"
          >
            Browse courses
          </Link>
        </div>
      ) : (
        <WorkbookStateProvider initial={values}>
          <div className="mt-10 flex flex-col gap-16">
            {sections.map((section) => {
              const next = nextOpenItem(section, values);
              return (
                <section key={section.slug}>
                  <div className="border-white/[0.08] border-b pb-4">
                    <div className="flex items-baseline justify-between gap-3">
                      <h2 className="font-display text-white text-xl tracking-[-0.02em]">
                        {section.title}
                      </h2>
                      <Link
                        href={`/${section.slug}`}
                        className="whitespace-nowrap text-sm text-white/50 underline transition-colors hover:text-white"
                      >
                        Course overview →
                      </Link>
                    </div>
                    <WorkbookCourseProgress items={section.items} />
                    {next ? (
                      <p className="mt-3 text-sm text-white/55">
                        Continue where you left off:{" "}
                        <Link
                          href={next.href}
                          className="text-white/80 underline transition-colors hover:text-white"
                        >
                          {next.item.label.length > 80
                            ? `${next.item.label.slice(0, 77)}…`
                            : next.item.label}
                        </Link>{" "}
                        <span className="text-white/35">
                          ({next.lessonTitle})
                        </span>
                      </p>
                    ) : null}
                  </div>

                  <div className="mt-2 flex flex-col gap-10">
                    {section.lessons.map((lesson) => (
                      <div key={lesson.lesson}>
                        <div className="flex items-baseline justify-between gap-3">
                          <h3 className="font-medium text-base text-white tracking-[-0.01em]">
                            {lesson.title}
                          </h3>
                          <Link
                            href={lesson.url}
                            className="whitespace-nowrap text-sm text-white/50 underline transition-colors hover:text-white"
                          >
                            Revisit chapter →
                          </Link>
                        </div>
                        <LessonItems
                          courseSlug={section.slug}
                          lesson={lesson.lesson}
                          url={lesson.url}
                          items={lesson.items}
                        />
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </WorkbookStateProvider>
      )}
    </div>
  );
}
