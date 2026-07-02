import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CheckIn } from "@/components/course/check-in";
import { Checklist } from "@/components/course/checklist";
import { LessonProvider } from "@/components/course/lesson-context";
import { CopyLinkButton } from "@/components/course/share-link";
import {
  WorkbookChapterMeter,
  WorkbookCourseProgress,
  WorkbookJumpNav,
  WorkbookMediaCluster,
  WorkbookQuizRow,
} from "@/components/course/workbook-extras";
import { WorkbookPrompt } from "@/components/course/workbook-prompt";
import { WorkbookStateProvider } from "@/components/course/workbook-state";
import { auth } from "@/lib/auth";
import { getCourseModules } from "@/lib/course-ui";
import { getCourse } from "@/lib/courses";
import { db } from "@/lib/db";
import { enrollment, response } from "@/lib/db/schema";
import { source } from "@/lib/source";
import {
  itemState,
  lessonWorkbookItems,
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
 * structured the way the course is — module groups (Measure/Keep/Grow/Run) →
 * chapter sections, each with its own intro (the `workbook` frontmatter), live
 * done-count, share anchor, and the chapter's items. Notes, check-ins, and
 * checklists are the REAL lesson blocks, editable in place; videos/podcasts
 * collapse into one "Watch & listen" card per chapter; quizzes link out. A
 * sticky jump-nav with live per-chapter counts keeps the whole thing
 * navigable, and a "continue where you left off" pointer keeps the next
 * action obvious.
 */

type ChapterEntry = {
  lesson: string;
  title: string;
  url: string;
  anchor: string;
  /** Chapter number pill label, from the slug's numeric prefix ("Ch 3"). */
  num: string;
  intro?: string;
  items: WorkbookItem[]; // deduped against earlier chapters
};

type ModuleGroup = { name: string | null; chapters: ChapterEntry[] };

type CourseSection = {
  slug: string;
  title: string;
  items: WorkbookItem[]; // all chapters, course order — for progress
  modules: ModuleGroup[];
  chapters: ChapterEntry[]; // flattened, for the jump-nav + continue pointer
};

function buildCourseSection(slug: string): CourseSection {
  const seen = new Set<string>();
  const modules: ModuleGroup[] = [];

  for (const courseModule of getCourseModules(slug)) {
    const chapters: ChapterEntry[] = [];
    for (const lesson of courseModule.lessons) {
      const fresh = lessonWorkbookItems(slug, lesson.slug).filter((item) => {
        if (seen.has(item.key)) return false;
        seen.add(item.key);
        return true;
      });
      if (fresh.length === 0) continue;
      const page = source.getPage([slug, lesson.slug]);
      const numeric = lesson.slug.match(/^(\d+)/)?.[1];
      chapters.push({
        lesson: lesson.slug,
        title: lesson.title,
        url: lesson.url,
        anchor: `wb-ch-${slug}-${lesson.slug}`,
        num: numeric ? `Ch ${Number.parseInt(numeric, 10)}` : lesson.slug,
        intro: page?.data.workbook ?? page?.data.description,
        items: fresh,
      });
    }
    if (chapters.length > 0) {
      modules.push({ name: courseModule.name, chapters });
    }
  }

  const chapters = modules.flatMap((m) => m.chapters);
  return {
    slug,
    title: getCourse(slug)?.title ?? slug,
    items: chapters.flatMap((c) => c.items),
    modules,
    chapters,
  };
}

/** First unfilled item in course order — the "continue here" pointer. */
function nextOpenItem(
  section: CourseSection,
  values: Record<string, SavedValue>,
): { item: WorkbookItem; lessonTitle: string; href: string } | null {
  for (const chapter of section.chapters) {
    for (const item of chapter.items) {
      if (itemState(item, values[item.key] ?? null).status !== "done") {
        return {
          item,
          lessonTitle: chapter.title,
          href: `${chapter.url}#${item.anchor}`,
        };
      }
    }
  }
  return null;
}

/**
 * One chapter's items: the real editable blocks in lesson order, with the
 * media items pulled out into the compact "Watch & listen" cluster at the end.
 */
function ChapterItems({
  courseSlug,
  chapter,
}: {
  courseSlug: string;
  chapter: ChapterEntry;
}) {
  const media = chapter.items.filter((item) => item.kind === "media");
  const rest = chapter.items.filter((item) => item.kind !== "media");
  return (
    <LessonProvider course={courseSlug} lesson={chapter.lesson}>
      {rest.map((item) => {
        const href = `${chapter.url}#${item.anchor}`;
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
          default:
            return null;
        }
      })}
      <WorkbookMediaCluster items={media} url={chapter.url} />
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
  const sections = Object.keys(WORKBOOK_MANIFEST)
    .map(buildCourseSection)
    .filter(
      (section) =>
        enrolled.has(section.slug) ||
        section.items.some((item) => savedKeys.has(item.key)),
    );

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-16">
      <h1 className="font-display text-3xl tracking-[-0.02em]">
        Your workbook
      </h1>
      <p className="mt-2 text-sm text-white/55 leading-6">
        Every exercise your courses ask of you, in one place — completable start
        to finish right here. Each chapter opens with what it covers and what
        you'll produce; what you've written is editable in place, and everything
        links back to the chapter it lives in.
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
                <section key={section.slug} id={`wb-${section.slug}`}>
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

                  <WorkbookJumpNav
                    chapters={section.chapters.map((chapter) => ({
                      anchor: chapter.anchor,
                      num: chapter.num,
                      items: chapter.items,
                    }))}
                  />

                  <div className="mt-4 flex flex-col gap-12">
                    {section.modules.map((courseModule) => (
                      <div key={courseModule.name ?? "ungrouped"}>
                        {courseModule.name ? (
                          <p className="font-medium text-[11px] text-accent uppercase tracking-[0.18em]">
                            {courseModule.name}
                          </p>
                        ) : null}
                        <div className="mt-4 flex flex-col gap-10">
                          {courseModule.chapters.map((chapter) => (
                            <section
                              key={chapter.lesson}
                              id={chapter.anchor}
                              className="scroll-mt-36"
                            >
                              <div className="flex items-baseline justify-between gap-3">
                                <h3 className="min-w-0 font-medium text-base text-white tracking-[-0.01em]">
                                  {chapter.title}
                                </h3>
                                <div className="flex shrink-0 items-baseline gap-3">
                                  <WorkbookChapterMeter items={chapter.items} />
                                  <Link
                                    href={chapter.url}
                                    className="whitespace-nowrap text-sm text-white/50 underline transition-colors hover:text-white"
                                  >
                                    Revisit chapter →
                                  </Link>
                                  <CopyLinkButton
                                    url={`/workbook#${chapter.anchor}`}
                                    label="Share"
                                  />
                                </div>
                              </div>
                              {chapter.intro ? (
                                <p className="mt-2 text-sm text-white/55 leading-6">
                                  {chapter.intro}
                                </p>
                              ) : null}
                              <ChapterItems
                                courseSlug={section.slug}
                                chapter={chapter}
                              />
                            </section>
                          ))}
                        </div>
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
