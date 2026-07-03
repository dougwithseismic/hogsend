"use client";

import Link from "next/link";
import {
  useWorkbookResponse,
  useWorkbookValues,
} from "@/components/course/workbook-state";
import { ProgressBar } from "@/components/ds/progress-bar";
import {
  itemState,
  type SavedValue,
  type WorkbookItem,
  workbookProgress,
} from "@/lib/workbook";

/**
 * The /workbook-page companions to the real lesson blocks: a live per-course
 * progress header, a sticky chapter jump-nav with live per-chapter counts, a
 * per-chapter meter, a quiz row (scores are earned in the lesson, not edited
 * here), and the "Watch & listen" media cluster with inline toggles. All read
 * the shared workbook store, so inline edits elsewhere on the page tick them
 * over immediately.
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

/**
 * Sticky chapter strip under the site nav: one pill per chapter with its live
 * done-count, linking to the chapter's section anchor. The chapter number is
 * enough at this size — the full titles live in the sections themselves.
 */
export function WorkbookJumpNav({
  chapters,
}: {
  chapters: Array<{ anchor: string; num: string; items: WorkbookItem[] }>;
}) {
  const values = useWorkbookValues();
  return (
    <nav
      aria-label="Workbook chapters"
      className="-mx-6 sticky top-20 z-30 border-white/[0.08] border-y bg-black/80 px-6 py-2 backdrop-blur"
    >
      <div className="flex items-center gap-1.5 overflow-x-auto">
        {chapters.map((chapter) => {
          const { done, total } = workbookProgress(chapter.items, values);
          const complete = done === total && total > 0;
          return (
            <a
              key={chapter.anchor}
              href={`#${chapter.anchor}`}
              className="flex shrink-0 items-baseline gap-1.5 rounded-[8px] border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 text-xs transition-colors hover:border-white/25"
            >
              <span className="font-medium text-white/80">{chapter.num}</span>
              <span className={complete ? "text-good" : "text-white/40"}>
                {complete ? "✓" : `${done}/${total}`}
              </span>
            </a>
          );
        })}
      </div>
    </nav>
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
    <div className="not-prose my-4 flex items-center justify-between gap-4 rounded-md border border-white/[0.08] bg-white/[0.015] p-4">
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
    <div className="not-prose my-4 rounded-md border border-white/[0.08] bg-white/[0.015] p-4">
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

/**
 * A chapter's videos + podcasts as one compact card — a third of the workbook
 * is media, so these render as tight check-off rows instead of full blocks.
 * Must render inside a `LessonProvider` (the toggle saves need the lesson).
 */
export function WorkbookMediaCluster({
  items,
  url,
}: {
  items: WorkbookItem[];
  url: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="not-prose my-4 rounded-md border border-white/[0.08] bg-white/[0.015]">
      <p className="border-white/[0.06] border-b px-4 py-2.5 font-medium text-[11px] text-white/45 uppercase tracking-[0.14em]">
        Watch &amp; listen
      </p>
      <div className="divide-y divide-white/[0.06]">
        {items.map((item) => (
          <MediaClusterRow
            key={item.key}
            item={item}
            href={`${url}#${item.anchor}`}
          />
        ))}
      </div>
    </div>
  );
}

function MediaClusterRow({ item, href }: { item: WorkbookItem; href: string }) {
  const { value, save } = useWorkbookResponse<{
    done?: boolean;
    media?: "video" | "podcast";
    title?: string;
  }>("media", item.id ?? "", item.key);
  const done = value?.done === true;
  const verb = item.media === "podcast" ? "Listened" : "Watched";

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <button
        type="button"
        aria-pressed={done}
        aria-label={`${verb}: ${item.label}`}
        onClick={() =>
          void save({
            done: !done,
            media: item.media ?? "video",
            title: item.label,
          })
        }
        className={
          done
            ? "flex h-5 w-5 shrink-0 items-center justify-center rounded border border-good/60 bg-good-tint text-[11px] text-good"
            : "flex h-5 w-5 shrink-0 items-center justify-center rounded border border-white/25 text-transparent transition-colors hover:border-white/45"
        }
      >
        ✓
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-white/85">{item.label}</p>
        <p className="text-white/40 text-xs">
          {item.media === "podcast" ? "Podcast" : "Video"}
          {done ? ` · ${verb}` : ""}
        </p>
      </div>
      <Link
        href={href}
        className="shrink-0 whitespace-nowrap text-sm text-white/60 underline transition-colors hover:text-white"
      >
        {item.media === "podcast" ? "Listen →" : "Watch →"}
      </Link>
    </div>
  );
}
