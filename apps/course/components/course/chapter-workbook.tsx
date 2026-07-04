"use client";

import { useLesson } from "@/components/course/lesson-context";
import { CopyLinkButton } from "@/components/course/share-link";
import { useWorkbookValues } from "@/components/course/workbook-state";
import { ProgressBar } from "@/components/ds/progress-bar";
import {
  dedupeByKey,
  itemState,
  lessonWorkbookItems,
  type SavedValue,
  type WorkbookItem,
  workbookProgress,
} from "@/lib/workbook";
import { chapterSlugOfLesson } from "@/lib/workbook-chapters";

/**
 * The chapter's workbook, surfaced at the top of every lesson: what this
 * chapter will ask the reader to write, answer, tick, and watch — each item
 * deep-linked to its block, with live filled/unfilled state from the shared
 * workbook store (a tick lands here the moment a block saves). Signed-out
 * readers get the same map plus the pitch that signing in keeps their work.
 */

const KIND_VERB: Record<string, string> = {
  note: "Write",
  profile: "Check-in",
  checklist: "Checklist",
  quiz: "Quiz",
  flashcards: "Study",
  calc: "Calculate",
  reading: "Read",
};

function itemVerb(item: WorkbookItem): string {
  if (item.kind === "media") {
    return item.media === "podcast" ? "Listen" : "Watch";
  }
  return KIND_VERB[item.kind] ?? item.kind;
}

function StatusIcon({ status }: { status: "empty" | "partial" | "done" }) {
  if (status === "done") {
    return (
      <span
        aria-hidden
        className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full border border-good/60 bg-good-tint text-[10px] text-good"
      >
        ✓
      </span>
    );
  }
  if (status === "partial") {
    return (
      <span
        aria-hidden
        className="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full border border-caution/60 bg-caution-tint"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-caution" />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="h-4.5 w-4.5 shrink-0 rounded-full border border-white/20"
    />
  );
}

export function WorkbookItemRow({
  item,
  value,
  href,
}: {
  item: WorkbookItem;
  value: SavedValue | null;
  href: string;
}) {
  const state = itemState(item, value);
  return (
    <li>
      <a
        href={href}
        className="group flex items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-white/[0.03]"
      >
        <StatusIcon status={state.status} />
        <span className="min-w-0 flex-1 truncate text-sm text-white/75 group-hover:text-white">
          {item.label}
        </span>
        <span className="hidden whitespace-nowrap text-white/35 text-xs sm:block">
          {state.detail ?? itemVerb(item)}
        </span>
      </a>
    </li>
  );
}

/** Shared prologue of both chapter surfaces: this lesson's items + answers. */
function useChapterItems(): {
  lesson: { course: string; lesson: string };
  items: WorkbookItem[];
  values: Record<string, SavedValue> | null;
} | null {
  const lesson = useLesson();
  const values = useWorkbookValues();
  if (!lesson) return null;
  const items = dedupeByKey(lessonWorkbookItems(lesson.course, lesson.lesson));
  if (items.length === 0) return null;
  return { lesson, items, values };
}

export function ChapterWorkbook({ signedIn }: { signedIn: boolean }) {
  const chapter = useChapterItems();
  if (!chapter) return null;
  const { lesson, items, values } = chapter;

  const { done, total } = workbookProgress(items, values);

  return (
    <section
      aria-label="Chapter workbook"
      className="not-prose mb-10 rounded-md border border-white/[0.08] bg-white/[0.015] p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="font-medium text-[11px] text-accent uppercase tracking-[0.14em]">
          In this chapter's workbook
        </p>
        {signedIn ? (
          <span className="text-sm text-white/50">
            {done}/{total} done ·{" "}
            <a
              href={`/workbook/${lesson.course}/${chapterSlugOfLesson(lesson.lesson)}`}
              className="underline transition-colors hover:text-white"
            >
              your workbook
            </a>
          </span>
        ) : null}
      </div>

      {signedIn ? (
        <ProgressBar value={done} max={total} className="mt-3" />
      ) : (
        <p className="mt-2 text-sm text-white/55 leading-relaxed">
          Everything you write, answer, and tick below saves to your personal
          workbook.{" "}
          <a
            href={`/sign-in?next=${encodeURIComponent(
              `/learn/${lesson.course}/${lesson.lesson}`,
            )}`}
            className="text-white/75 underline transition-colors hover:text-white"
          >
            Sign in free
          </a>{" "}
          to keep it across visits.
        </p>
      )}

      <ul className="mt-3 flex flex-col">
        {items.map((item) => (
          <WorkbookItemRow
            key={item.key}
            item={item}
            value={values?.[item.key] ?? null}
            href={`#${item.anchor}`}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * End-of-chapter recap: what got done and what's still open, each open item a
 * jump-back link. All-done flips to a celebratory strip. Lives with the lesson
 * footer, so "what's left" is the last thing a reader sees before moving on.
 */
export function ChapterRecap({ signedIn }: { signedIn: boolean }) {
  const chapter = useChapterItems();
  if (!chapter) return null;
  const { lesson, items, values } = chapter;
  const lessonPath = `/learn/${lesson.course}/${lesson.lesson}`;

  const open = items.filter(
    (item) => itemState(item, values?.[item.key] ?? null).status !== "done",
  );
  const doneCount = items.length - open.length;
  const allDone = signedIn && open.length === 0;

  return (
    <section
      aria-label="Chapter recap"
      className={
        allDone
          ? "not-prose mt-12 rounded-md border border-good/40 bg-good-tint p-5"
          : "not-prose mt-12 rounded-md border border-white/[0.08] bg-white/[0.015] p-5"
      }
    >
      {allDone ? (
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <p className="font-medium text-base text-white">
            ✓ Chapter workbook complete — all {items.length} items done
          </p>
          <span className="flex items-center gap-4">
            <CopyLinkButton url={lessonPath} label="Share chapter" />
            <a
              href={`/workbook/${lesson.course}/${chapterSlugOfLesson(lesson.lesson)}`}
              className="text-sm text-white/70 underline transition-colors hover:text-white"
            >
              Review it in your workbook →
            </a>
          </span>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <p className="font-medium text-[11px] text-accent uppercase tracking-[0.14em]">
              Before you move on
            </p>
            <span className="flex items-center gap-4">
              {signedIn ? (
                <span className="whitespace-nowrap text-sm text-white/50">
                  {doneCount}/{items.length} done
                </span>
              ) : null}
              <CopyLinkButton url={lessonPath} label="Share chapter" />
            </span>
          </div>
          <p className="mt-2 text-sm text-white/55 leading-relaxed">
            {signedIn
              ? "Still open in this chapter — each one saves to your workbook:"
              : "This chapter's workbook items — sign in free and they save as you go:"}
          </p>
          <ul className="mt-3 flex flex-col">
            {open.map((item) => (
              <WorkbookItemRow
                key={item.key}
                item={item}
                value={values?.[item.key] ?? null}
                href={`#${item.anchor}`}
              />
            ))}
          </ul>
          {signedIn && doneCount > 0 ? (
            <p className="mt-3 text-sm text-white/40">
              ✓ {doneCount} already done —{" "}
              <a
                href={`/workbook/${lesson.course}/${chapterSlugOfLesson(lesson.lesson)}`}
                className="underline transition-colors hover:text-white/70"
              >
                see them in your workbook
              </a>
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
