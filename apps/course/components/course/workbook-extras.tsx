"use client";

import Link from "next/link";
import { useWorkbookValues } from "@/components/course/workbook-state";
import { ProgressBar } from "@/components/ds/progress-bar";
import {
  itemState,
  type SavedValue,
  type WorkbookItem,
  workbookProgress,
} from "@/lib/workbook";

/**
 * The workbook pages' companions to the real lesson blocks: a live progress
 * header, a per-chapter meter, and link-out rows for the paid blocks a locked
 * chapter can't render inline (quiz, flashcards, calculator). All read the
 * shared workbook store, so inline edits elsewhere on the page tick them over
 * immediately. Each row carries the item's anchor id so deep links land even
 * when the real block isn't rendered.
 */

export function WorkbookCourseProgress({ items }: { items: WorkbookItem[] }) {
  const values = useWorkbookValues();
  const { done, total } = workbookProgress(items, values);
  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-white/50">
          {done} of {total} workbook items done
        </span>
        {done === total && total > 0 ? (
          <span className="text-good text-sm">Complete ✓</span>
        ) : null}
      </div>
      <ProgressBar value={done} max={total} className="mt-2" />
    </div>
  );
}

/** Compact live "n/m done" for a chapter-section header. */
export function WorkbookChapterMeter({ items }: { items: WorkbookItem[] }) {
  const values = useWorkbookValues();
  const { done, total } = workbookProgress(items, values);
  if (total === 0) return null;
  return done === total ? (
    <span className="whitespace-nowrap text-good text-xs">All done ✓</span>
  ) : (
    <span className="whitespace-nowrap text-white/40 text-xs">
      {done}/{total} done
    </span>
  );
}

/**
 * The shared link-out card for items EARNED in the lesson rather than edited
 * here (quiz scores, flashcard mastery): kind label + authored title on the
 * left, the live state + a jump link on the right.
 */
function LinkOutRow({
  kindLabel,
  item,
  href,
  emptyText,
  doneCta,
  openCta,
  doneDetailClass = "text-white",
}: {
  kindLabel: string;
  item: WorkbookItem;
  href: string;
  emptyText: string;
  doneCta: string;
  openCta: string;
  doneDetailClass?: string;
}) {
  const values = useWorkbookValues();
  const state = itemState(item, values?.[item.key] ?? null);

  return (
    <div
      id={item.anchor}
      className="not-prose my-4 flex scroll-mt-28 items-center justify-between gap-4 rounded-md border border-white/[0.08] bg-white/[0.015] p-4"
    >
      <div className="min-w-0">
        <p className="font-medium text-[11px] text-accent uppercase tracking-[0.14em]">
          {kindLabel}
        </p>
        <p className="mt-1 truncate text-sm text-white/85">{item.label}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {state.status === "empty" ? (
          <span className="text-sm text-white/40">{emptyText}</span>
        ) : (
          <span
            className={`font-medium text-sm ${
              state.status === "done" ? doneDetailClass : "text-white"
            }`}
          >
            {state.detail}
          </span>
        )}
        <Link
          href={href}
          className="whitespace-nowrap text-sm text-white/60 underline transition-colors hover:text-white"
        >
          {state.status === "done" ? doneCta : openCta}
        </Link>
      </div>
    </div>
  );
}

export function WorkbookQuizRow({
  item,
  href,
}: {
  item: WorkbookItem;
  href: string;
}) {
  return (
    <LinkOutRow
      kindLabel="Quiz"
      item={item}
      href={href}
      emptyText="Not taken yet"
      doneCta="Retake →"
      openCta="Take it →"
    />
  );
}

/**
 * Flashcard decks are studied in the lesson (the deck content is chapter
 * content, which stays behind the paywall) — the workbook shows the live
 * mastered-count and links out, mirroring the quiz row.
 */
export function WorkbookFlashcardsRow({
  item,
  href,
}: {
  item: WorkbookItem;
  href: string;
}) {
  return (
    <LinkOutRow
      kindLabel="Flashcards"
      item={item}
      href={href}
      emptyText={item.itemCount ? `${item.itemCount} cards` : "Not studied yet"}
      doneCta="Review →"
      openCta="Study →"
      doneDetailClass="text-good"
    />
  );
}

/**
 * Calculators are recomputed in the lesson (the math lives in a preset the
 * workbook page doesn't carry), so here the workbook shows the reader's saved
 * read-out sentence and links back to run it again — mirroring the quiz row.
 */
export function WorkbookCalcRow({
  item,
  href,
}: {
  item: WorkbookItem;
  href: string;
}) {
  const values = useWorkbookValues();
  const value = values?.[item.key] as SavedValue | undefined;
  const done = !!value?.inputs && Object.keys(value.inputs).length > 0;

  return (
    <div
      id={item.anchor}
      className="not-prose my-4 scroll-mt-28 rounded-md border border-white/[0.08] bg-white/[0.015] p-4"
    >
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <p className="font-medium text-[11px] text-accent uppercase tracking-[0.14em]">
            Calculator
          </p>
          <p className="mt-1 text-sm text-white/85">{item.label}</p>
        </div>
        <Link
          href={href}
          className="shrink-0 whitespace-nowrap text-sm text-white/60 underline transition-colors hover:text-white"
        >
          {done ? "Revisit →" : "Open →"}
        </Link>
      </div>
      {done && value?.summary ? (
        <p className="mt-2 text-sm text-white/55 leading-relaxed">
          {value.summary}
        </p>
      ) : (
        <p className="mt-2 text-sm text-white/40">Not calculated yet.</p>
      )}
    </div>
  );
}
