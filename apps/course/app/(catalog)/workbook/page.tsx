import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { WorkbookChapterMeter } from "@/components/course/workbook-extras";
import { LegacyWorkbookHash } from "@/components/course/workbook-legacy-hash";
import { WorkbookStateProvider } from "@/components/course/workbook-state";
import { ProgressBar } from "@/components/ds/progress-bar";
import { auth } from "@/lib/auth";
import { getCourseModules } from "@/lib/course-ui";
import { getCourse } from "@/lib/courses";
import { db } from "@/lib/db";
import { enrollment, response } from "@/lib/db/schema";
import {
  itemState,
  lessonWorkbookItems,
  type SavedValue,
  WORKBOOK_MANIFEST,
  type WorkbookItem,
  type WorkbookItemKind,
  workbookProgress,
} from "@/lib/workbook";
import {
  buildWorkbookChapters,
  type WorkbookChapter,
} from "@/lib/workbook-chapters";

// Reads the session + the user's DB rows — always per-request.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your workbook",
  robots: { index: false, follow: false },
};

/**
 * The workbook's front door: one card per chapter, grouped by module, each
 * with its live done-count — the whole thing scannable in one screen. The
 * items themselves live on per-chapter pages (/workbook/[course]/[chapter]),
 * completable start to finish. A "continue where you left off" pointer jumps
 * straight to the first open item's chapter, and legacy share links
 * (/workbook#wb-ch-…) are redirected to their chapter page client-side.
 */

type CourseSection = {
  slug: string;
  title: string;
  chapters: WorkbookChapter[];
  /** Every chapter's items, flat — the same set the chapter meters count, so
   *  the course total always equals the sum of the chapter meters (a prompt
   *  deliberately re-rendered in a later chapter counts there too, and ticks
   *  everywhere at once since state is keyed). */
  items: WorkbookItem[];
};

function buildCourseSection(slug: string): CourseSection {
  const chapters = buildWorkbookChapters(slug, getCourseModules(slug), (l) =>
    lessonWorkbookItems(slug, l),
  );
  return {
    slug,
    title: getCourse(slug)?.title ?? slug,
    chapters,
    items: chapters.flatMap((c) => c.items),
  };
}

/** First unfilled item in course order — the "continue here" pointer. */
function nextOpenItem(
  section: CourseSection,
  values: Record<string, SavedValue>,
): { item: WorkbookItem; chapter: WorkbookChapter } | null {
  for (const chapter of section.chapters) {
    for (const item of chapter.items) {
      if (itemState(item, values[item.key] ?? null).status !== "done") {
        return { item, chapter };
      }
    }
  }
  return null;
}

/** Display order + singular/plural per kind — typed against WorkbookItemKind
 *  (media split into its two sub-kinds) so a new kind is a compile error here
 *  rather than a silent omission from the summary line. */
type SummaryKind = Exclude<WorkbookItemKind, "media"> | "video" | "podcast";
const SUMMARY_LABEL: Record<SummaryKind, [string, string]> = {
  note: ["prompt", "prompts"],
  profile: ["check-in", "check-ins"],
  checklist: ["checklist", "checklists"],
  video: ["video", "videos"],
  podcast: ["podcast", "podcasts"],
  flashcards: ["flashcard deck", "flashcard decks"],
  quiz: ["quiz", "quizzes"],
  calc: ["calculator", "calculators"],
  reading: ["reading list", "reading lists"],
};

/** "4 prompts · 2 videos · 1 flashcard deck · 1 quiz" — what a chapter asks. */
function chapterSummary(items: WorkbookItem[]): string {
  const counts = new Map<SummaryKind, number>();
  for (const item of items) {
    const kind: SummaryKind =
      item.kind === "media" ? (item.media ?? "video") : item.kind;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return (Object.keys(SUMMARY_LABEL) as SummaryKind[])
    .filter((kind) => counts.has(kind))
    .map((kind) => {
      const n = counts.get(kind) ?? 0;
      return `${n} ${SUMMARY_LABEL[kind][n === 1 ? 0 : 1]}`;
    })
    .join(" · ");
}

/**
 * Old one-page chapter anchors (#wb-ch-<course>-<lesson>) → their chapter
 * page. Chapter anchors only: they encode course+lesson so they're unique,
 * and they're what the old page's Share buttons actually emitted. Item-level
 * anchors are NOT mapped — they aren't globally unique (every quiz was
 * #wb-quiz, and a re-rendered prompt appears in two chapters).
 */
function legacyAnchorMap(sections: CourseSection[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const section of sections) {
    for (const chapter of section.chapters) {
      for (const atom of chapter.atoms) {
        map[`wb-ch-${section.slug}-${atom.lesson.replace(/\//g, "-")}`] =
          `/workbook/${section.slug}/${chapter.slug}`;
      }
    }
  }
  return map;
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
  // saved answer for one of its items (free-lesson answers precede
  // enrollment). Filter on the raw manifest BEFORE building sections — no
  // tree walk for irrelevant courses — and require the course to be
  // registered (getCourse), since the chapter routes 404 unregistered ones.
  const enrolled = new Set(enrollments.map((e) => e.courseSlug));
  const savedKeys = new Set(Object.keys(values));
  const sections = Object.keys(WORKBOOK_MANIFEST)
    .filter(
      (slug) =>
        getCourse(slug) &&
        (enrolled.has(slug) ||
          Object.values(WORKBOOK_MANIFEST[slug] ?? {})
            .flat()
            .some((item) => savedKeys.has(item.key))),
    )
    .map(buildCourseSection);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-16">
      <LegacyWorkbookHash map={legacyAnchorMap(sections)} />
      <h1 className="font-display text-3xl tracking-[-0.02em]">
        Your workbook
      </h1>
      <p className="mt-2 text-sm text-white/55 leading-6">
        Every exercise your courses ask of you, one chapter per page —
        completable start to finish without opening a lesson. Videos play, decks
        flip, and quizzes run right inside; everything you write is editable in
        place.
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
              const { done, total } = workbookProgress(section.items, values);
              const next = nextOpenItem(section, values);
              const modules = groupByModule(section.chapters);
              return (
                <section key={section.slug} id={`wb-${section.slug}`}>
                  <div className="border-white/[0.08] border-b pb-5">
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
                    <div className="mt-3 flex items-baseline justify-between gap-3">
                      <span className="text-sm text-white/50">
                        {done} of {total} workbook items done
                      </span>
                      {done === total && total > 0 ? (
                        <span className="text-good text-sm">Complete ✓</span>
                      ) : null}
                    </div>
                    <ProgressBar value={done} max={total} className="mt-2" />
                    {next ? (
                      <p className="mt-3 text-sm text-white/55">
                        Continue where you left off:{" "}
                        <Link
                          href={`/workbook/${section.slug}/${next.chapter.slug}#${next.item.anchor}`}
                          className="text-white/80 underline transition-colors hover:text-white"
                        >
                          {next.item.label.length > 80
                            ? `${next.item.label.slice(0, 77)}…`
                            : next.item.label}
                        </Link>{" "}
                        <span className="text-white/35">
                          (Chapter {next.chapter.num})
                        </span>
                      </p>
                    ) : null}
                  </div>

                  <div className="mt-8 flex flex-col gap-10">
                    {modules.map((group) => (
                      <div key={group.name ?? "ungrouped"}>
                        {group.name ? (
                          <p className="font-medium text-[11px] text-accent uppercase tracking-[0.18em]">
                            {group.name}
                          </p>
                        ) : null}
                        <ol className="mt-3 flex flex-col gap-2">
                          {group.chapters.map((chapter) => (
                            <li key={chapter.slug}>
                              <Link
                                href={`/workbook/${section.slug}/${chapter.slug}`}
                                className="group flex items-center gap-4 rounded-md border border-white/[0.08] bg-white/[0.015] px-4 py-3.5 transition-colors hover:border-white/25"
                              >
                                <span className="w-12 shrink-0 font-medium text-white/40 text-xs">
                                  Ch {chapter.num}
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate font-medium text-sm text-white/90 group-hover:text-white">
                                    {chapter.title}
                                  </span>
                                  <span className="mt-0.5 block truncate text-white/40 text-xs">
                                    {chapterSummary(chapter.items)}
                                  </span>
                                </span>
                                <span className="shrink-0">
                                  <WorkbookChapterMeter items={chapter.items} />
                                </span>
                                <span
                                  aria-hidden
                                  className="shrink-0 text-white/30 transition-colors group-hover:text-white/70"
                                >
                                  →
                                </span>
                              </Link>
                            </li>
                          ))}
                        </ol>
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

/** Chapters regrouped by their module label, preserving course order. */
function groupByModule(
  chapters: WorkbookChapter[],
): Array<{ name: string | null; chapters: WorkbookChapter[] }> {
  const groups: Array<{ name: string | null; chapters: WorkbookChapter[] }> =
    [];
  for (const chapter of chapters) {
    const last = groups[groups.length - 1];
    if (last && last.name === chapter.moduleName) {
      last.chapters.push(chapter);
    } else {
      groups.push({ name: chapter.moduleName, chapters: [chapter] });
    }
  }
  return groups;
}
