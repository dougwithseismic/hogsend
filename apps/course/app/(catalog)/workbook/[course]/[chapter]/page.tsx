import { and, eq, inArray } from "drizzle-orm";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { CheckoutButton } from "@/components/checkout-button";
import { Calculator } from "@/components/course/calculator";
import { CheckIn } from "@/components/course/check-in";
import { Checklist } from "@/components/course/checklist";
import { Flashcards } from "@/components/course/flashcards";
import { LessonProvider } from "@/components/course/lesson-context";
import { PodcastLink } from "@/components/course/podcast-link";
import { Quiz } from "@/components/course/quiz";
import { Reading } from "@/components/course/reading";
import { VideoEmbed } from "@/components/course/video-embed";
import {
  WorkbookCalcRow,
  WorkbookCourseProgress,
  WorkbookFlashcardsRow,
  WorkbookQuizRow,
} from "@/components/course/workbook-extras";
import { WorkbookPrompt } from "@/components/course/workbook-prompt";
import { WorkbookStateProvider } from "@/components/course/workbook-state";
import { auth } from "@/lib/auth";
import { getCourseModules, slugsFromUrl } from "@/lib/course-ui";
import { getCourse } from "@/lib/courses";
import { db } from "@/lib/db";
import { response } from "@/lib/db/schema";
import { hasAccess, isCoursePaywalled } from "@/lib/entitlements";
import { isFreeLesson } from "@/lib/gating";
import { source } from "@/lib/source";
import {
  lessonWorkbookItems,
  type SavedValue,
  type WorkbookItem,
} from "@/lib/workbook";
import {
  buildWorkbookChapters,
  type WorkbookChapter,
  type WorkbookChapterAtom,
} from "@/lib/workbook-chapters";
import {
  lessonRichContent,
  type RichBlock,
  type RichCalc,
  type RichFlashcards,
  type RichQuiz,
} from "@/lib/workbook-content";

// Reads the session + the user's DB rows — always per-request.
export const dynamic = "force-dynamic";

/**
 * One chapter of the workbook, completable start to finish: the chapter's
 * intro, then every interactive item in course order — prompts, check-ins and
 * checklists editable in place, videos and podcasts playable inline, flashcard
 * decks and quizzes runnable right here, calculators live. Items are grouped
 * by the atom they live in (each group wrapped in that atom's LessonProvider,
 * so answers persist under exactly the same keys as in the lesson).
 * Deck/quiz/calculator CONTENT is paid chapter content: locked chapters keep
 * the light link-out rows (which land on the lesson paywall) plus an unlock
 * banner, mirroring the lesson gate — media stays playable, it's public. A
 * prev/next pager makes the whole workbook walkable.
 */

type ChapterRoute = {
  chapters: WorkbookChapter[];
  chapter: WorkbookChapter;
  index: number;
};

// cache(): generateMetadata and the page body both resolve the route in the
// same request — dedupe the tree walk + chapter build.
const resolveChapter = cache(
  (course: string, slug: string): ChapterRoute | null => {
    if (!getCourse(course)) return null;
    const chapters = buildWorkbookChapters(
      course,
      getCourseModules(course),
      (l) => lessonWorkbookItems(course, l),
    );
    const index = chapters.findIndex((c) => c.slug === slug);
    if (index === -1) return null;
    return { chapters, chapter: chapters[index], index };
  },
);

export async function generateMetadata(props: {
  params: Promise<{ course: string; chapter: string }>;
}): Promise<Metadata> {
  const { course, chapter } = await props.params;
  const route = resolveChapter(course, chapter);
  return {
    title: route ? `Workbook — ${route.chapter.title}` : "Your workbook",
    robots: { index: false, follow: false },
  };
}

/**
 * The chapter's atoms with items deduped ACROSS the chapter (first render site
 * wins) — a key re-rendered by two atoms of one chapter must not produce two
 * blocks with the same DOM id bound to one response row.
 */
function dedupedAtoms(chapter: WorkbookChapter): WorkbookChapterAtom[] {
  const seen = new Set<string>();
  return chapter.atoms
    .map((atom) => ({
      ...atom,
      items: atom.items.filter((item) => {
        if (seen.has(item.key)) return false;
        seen.add(item.key);
        return true;
      }),
    }))
    .filter((atom) => atom.items.length > 0);
}

function AtomItems({
  courseSlug,
  atom,
  unlocked,
}: {
  courseSlug: string;
  atom: WorkbookChapterAtom;
  unlocked: boolean;
}) {
  const rich = unlocked ? lessonRichContent(courseSlug, atom.lesson) : {};
  return (
    <LessonProvider course={courseSlug} lesson={atom.lesson}>
      {atom.items.map((item) => (
        <AtomItem
          key={item.key}
          item={item}
          href={`${atom.url}#${item.anchor}`}
          rich={rich[item.key]}
        />
      ))}
    </LessonProvider>
  );
}

/**
 * One item as its REAL interactive block. `rich` is only ever passed on
 * unlocked chapters; without it, deck/quiz/calculator fall back to the
 * link-out row (whose lesson link lands on the paywall). Media renders the
 * real player either way — the videos/podcasts are public.
 */
function AtomItem({
  item,
  href,
  rich,
}: {
  item: WorkbookItem;
  href: string;
  rich?: RichBlock;
}) {
  switch (item.kind) {
    case "note":
      return (
        <WorkbookPrompt
          id={item.id ?? ""}
          prompt={item.label}
          placeholder={item.placeholder}
          rows={item.rows}
        />
      );
    case "profile":
      return (
        <CheckIn
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
          id={item.id ?? ""}
          title={item.label}
          items={item.items ?? []}
        />
      );
    case "reading":
      return (
        <Reading
          id={item.id ?? ""}
          title={item.label}
          books={item.books ?? []}
        />
      );
    case "media":
      return item.media === "podcast" ? (
        <PodcastLink
          id={item.id ?? ""}
          title={item.label}
          show={item.show ?? ""}
          guest={item.guest}
          duration={item.duration}
          note={item.note}
          spotify={item.spotify}
          youtube={item.youtube}
          apple={item.apple}
        />
      ) : (
        <VideoEmbed
          id={item.id ?? ""}
          title={item.label}
          channel={item.channel ?? ""}
          duration={item.duration}
          note={item.note}
        />
      );
    case "flashcards": {
      const deck = rich as RichFlashcards | undefined;
      return deck ? (
        <Flashcards id={item.id ?? ""} title={deck.title} cards={deck.cards} />
      ) : (
        <WorkbookFlashcardsRow item={item} href={href} />
      );
    }
    case "quiz": {
      const quiz = rich as RichQuiz | undefined;
      return quiz ? (
        <Quiz title={quiz.title} questions={quiz.questions} />
      ) : (
        <WorkbookQuizRow item={item} href={href} />
      );
    }
    case "calc": {
      const calc = rich as RichCalc | undefined;
      return calc ? (
        <Calculator
          preset={calc.preset}
          id={item.id ?? ""}
          title={calc.title}
        />
      ) : (
        <WorkbookCalcRow item={item} href={href} />
      );
    }
    default:
      return null;
  }
}

function ChapterPager({
  course,
  prev,
  next,
}: {
  course: string;
  prev: WorkbookChapter | undefined;
  next: WorkbookChapter | undefined;
}) {
  return (
    <nav
      aria-label="Workbook chapters"
      className="mt-14 flex items-stretch gap-3 border-white/[0.08] border-t pt-6"
    >
      {prev ? (
        <Link
          href={`/workbook/${course}/${prev.slug}`}
          className="group min-w-0 flex-1 rounded-md border border-white/[0.08] bg-white/[0.015] px-4 py-3 transition-colors hover:border-white/25"
        >
          <span className="block text-white/40 text-xs">← Ch {prev.num}</span>
          <span className="mt-0.5 block truncate text-sm text-white/80 group-hover:text-white">
            {prev.title}
          </span>
        </Link>
      ) : (
        <span className="flex-1" />
      )}
      {next ? (
        <Link
          href={`/workbook/${course}/${next.slug}`}
          className="group min-w-0 flex-1 rounded-md border border-white/[0.08] bg-white/[0.015] px-4 py-3 text-right transition-colors hover:border-white/25"
        >
          <span className="block text-white/40 text-xs">Ch {next.num} →</span>
          <span className="mt-0.5 block truncate text-sm text-white/80 group-hover:text-white">
            {next.title}
          </span>
        </Link>
      ) : (
        <span className="flex-1" />
      )}
    </nav>
  );
}

export default async function WorkbookChapterPage(props: {
  params: Promise<{ course: string; chapter: string }>;
}) {
  const { course, chapter: chapterSlug } = await props.params;
  const route = resolveChapter(course, chapterSlug);
  if (!route) notFound();
  const { chapters, chapter, index } = route;

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    redirect(
      `/sign-in?next=${encodeURIComponent(`/workbook/${course}/${chapterSlug}`)}`,
    );
  }

  // Chapter freeness = the chapter hub's own lesson freeness, so the workbook
  // gate can never drift from the lesson paywall's rules.
  const unlocked =
    isFreeLesson(slugsFromUrl(chapter.url)) ||
    !isCoursePaywalled(course) ||
    (await hasAccess(session.user.id, course));

  const keys = chapter.items.map((item) => item.key);
  const rows =
    keys.length > 0
      ? await db
          .select({ key: response.key, value: response.value })
          .from(response)
          .where(
            and(
              eq(response.userId, session.user.id),
              inArray(response.key, keys),
            ),
          )
      : [];
  const values: Record<string, SavedValue> = Object.fromEntries(
    rows.map((row) => [row.key, row.value as SavedValue]),
  );

  const hubPage = source.getPage(slugsFromUrl(chapter.url));
  const intro = hubPage?.data.workbook ?? hubPage?.data.description;
  const prev = chapters[index - 1];
  const next = chapters[index + 1];
  const atoms = dedupedAtoms(chapter);
  const showAtomHeadings =
    atoms.length > 1 || atoms[0]?.lesson !== chapter.slug;

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-16">
      <Link
        href="/workbook"
        className="text-sm text-white/40 transition-colors hover:text-white"
      >
        ← Your workbook
      </Link>

      <div className="mt-8 flex items-center gap-3">
        {chapter.moduleName ? (
          <p className="font-medium text-[11px] text-accent uppercase tracking-[0.18em]">
            {chapter.moduleName}
          </p>
        ) : null}
        <p className="text-[11px] text-white/40 uppercase tracking-[0.18em]">
          Chapter {chapter.num}
        </p>
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-3">
        <h1 className="min-w-0 font-display text-3xl tracking-[-0.02em]">
          {chapter.title}
        </h1>
        <Link
          href={chapter.url}
          className="shrink-0 whitespace-nowrap text-sm text-white/50 underline transition-colors hover:text-white"
        >
          Read the chapter →
        </Link>
      </div>
      {intro ? (
        <p className="mt-3 text-sm text-white/55 leading-6">{intro}</p>
      ) : null}

      <WorkbookStateProvider initial={values}>
        <WorkbookCourseProgress items={chapter.items} />

        {!unlocked ? (
          <div className="mt-8 rounded-md border border-white/[0.08] bg-white/[0.015] p-5">
            <p className="font-medium text-sm text-white">
              This chapter's flashcards, quiz and calculators unlock with the
              course.
            </p>
            <p className="mt-1.5 text-sm text-white/55 leading-6">
              The videos play and your notes, check-ins and checklists still
              save — the paid blocks link back to the lesson until the course is
              yours.
            </p>
            <div className="mt-4">
              <CheckoutButton
                sku={course}
                next={`/workbook/${course}/${chapterSlug}`}
                label={
                  getCourse(course)?.priceLabel
                    ? `Unlock the course — ${getCourse(course)?.priceLabel}`
                    : "Unlock the course"
                }
              />
            </div>
          </div>
        ) : null}

        <div className="mt-4 flex flex-col gap-2">
          {atoms.map((atom) => {
            const atomIntro = showAtomHeadings
              ? source.getPage(slugsFromUrl(atom.url))?.data.workbook
              : undefined;
            return (
              <section key={atom.lesson} className="scroll-mt-28">
                {showAtomHeadings ? (
                  <div className="mt-8 flex items-baseline justify-between gap-3 border-white/[0.08] border-b pb-2">
                    <h2 className="min-w-0 font-medium text-base text-white tracking-[-0.01em]">
                      {atom.title}
                    </h2>
                    <Link
                      href={atom.url}
                      className="shrink-0 whitespace-nowrap text-sm text-white/50 underline transition-colors hover:text-white"
                    >
                      Revisit →
                    </Link>
                  </div>
                ) : null}
                {atomIntro ? (
                  <p className="mt-2 text-sm text-white/55 leading-6">
                    {atomIntro}
                  </p>
                ) : null}
                <AtomItems
                  courseSlug={course}
                  atom={atom}
                  unlocked={unlocked}
                />
              </section>
            );
          })}
        </div>

        <ChapterPager course={course} prev={prev} next={next} />
      </WorkbookStateProvider>
    </div>
  );
}
