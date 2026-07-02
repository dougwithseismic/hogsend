"use client";

import { useLesson } from "@/components/course/lesson-context";
import { useWorkbookValues } from "@/components/course/workbook-state";
import {
  dedupeByKey,
  itemState,
  lessonWorkbookItems,
  type SavedValue,
  type WorkbookItem,
  workbookProgress,
} from "@/lib/workbook";

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

export function ChapterWorkbook({ signedIn }: { signedIn: boolean }) {
  const lesson = useLesson();
  const values = useWorkbookValues();
  if (!lesson) return null;

  const items = dedupeByKey(lessonWorkbookItems(lesson.course, lesson.lesson));
  if (items.length === 0) return null;

  const map = new Map(Object.entries(values ?? {}));
  const { done, total } = workbookProgress(items, map);

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
              href="/workbook"
              className="underline transition-colors hover:text-white"
            >
              your workbook
            </a>
          </span>
        ) : null}
      </div>

      {signedIn ? (
        <div
          aria-hidden
          className="mt-3 h-1 overflow-hidden rounded-full bg-white/[0.06]"
        >
          <div
            className="h-full rounded-full bg-good transition-[width] duration-500"
            style={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }}
          />
        </div>
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
            value={map.get(item.key) ?? null}
            href={`#${item.anchor}`}
          />
        ))}
      </ul>
    </section>
  );
}
