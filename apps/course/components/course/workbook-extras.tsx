"use client";

import Link from "next/link";
import {
  useWorkbookResponse,
  useWorkbookValues,
} from "@/components/course/workbook-state";
import { ProgressBar } from "@/components/ds/progress-bar";
import { itemState, type WorkbookItem, workbookProgress } from "@/lib/workbook";

/**
 * The /workbook-page companions to the real lesson blocks: a live per-course
 * progress header, a quiz row (scores are earned in the lesson, not edited
 * here), and a media row with an inline watched/listened toggle. All read the
 * shared workbook store, so inline edits elsewhere on the page tick them over
 * immediately.
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

export function WorkbookQuizRow({
  item,
  href,
}: {
  item: WorkbookItem;
  href: string;
}) {
  const values = useWorkbookValues();
  const value = values?.[item.key] ?? null;
  const state = itemState(item, value);

  return (
    <div className="not-prose my-4 flex items-center justify-between gap-4 rounded-md border border-white/[0.08] bg-white/[0.015] p-4">
      <div className="min-w-0">
        <p className="font-medium text-[11px] text-accent uppercase tracking-[0.14em]">
          Quiz
        </p>
        <p className="mt-1 truncate text-sm text-white/85">{item.label}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {state.status === "done" ? (
          <span className="font-medium text-sm text-white">{state.detail}</span>
        ) : (
          <span className="text-sm text-white/40">Not taken yet</span>
        )}
        <Link
          href={href}
          className="whitespace-nowrap text-sm text-white/60 underline transition-colors hover:text-white"
        >
          {state.status === "done" ? "Retake →" : "Take it →"}
        </Link>
      </div>
    </div>
  );
}

export function WorkbookMediaRow({
  item,
  href,
}: {
  item: WorkbookItem;
  href: string;
}) {
  const { value, save } = useWorkbookResponse<{
    done?: boolean;
    media?: "video" | "podcast";
    title?: string;
  }>("media", item.id ?? "", item.key);
  const done = value?.done === true;
  const verb = item.media === "podcast" ? "Listened" : "Watched";

  return (
    <div className="not-prose my-4 flex items-center gap-3 rounded-md border border-white/[0.08] bg-white/[0.015] p-4">
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
