import manifestJson from "./workbook-manifest.generated.json";

/**
 * Typed access to the generated workbook manifest (see
 * scripts/generate-workbook-manifest.mjs) plus the shared "is this item
 * filled?" logic used by the chapter callout, the end-of-chapter recap, and
 * /workbook. Pure data + functions — safe to import from client and server.
 */

export type WorkbookItemKind =
  | "note"
  | "profile"
  | "checklist"
  | "quiz"
  | "media";

export type WorkbookItem = {
  kind: WorkbookItemKind;
  /** The block's authored id (absent for quiz — keyed by lesson). */
  id?: string;
  /** Response-table key the block persists under (note:…, quiz:course/lesson). */
  key: string;
  /** DOM id the block renders, for #anchor deep links. */
  anchor: string;
  /** The authored prompt / question / title. */
  label: string;
  /** quiz: pool size. */
  itemCount?: number;
  /** Only for kind "media". */
  media?: "video" | "podcast";
  /** note: authored textarea hints. */
  placeholder?: string;
  rows?: number;
  /** profile: authored choices. */
  options?: string[];
  multi?: boolean;
  freeText?: boolean;
  /** checklist: authored items. */
  items?: string[];
};

export type WorkbookManifest = Record<string, Record<string, WorkbookItem[]>>;

export const WORKBOOK_MANIFEST = manifestJson as WorkbookManifest;

export function lessonWorkbookItems(
  course: string,
  lesson: string,
): WorkbookItem[] {
  return WORKBOOK_MANIFEST[course]?.[lesson] ?? [];
}

/** Lessons of a course that have interactive items, in course order. */
export function courseWorkbookLessons(
  course: string,
): Array<{ lesson: string; items: WorkbookItem[] }> {
  return Object.entries(WORKBOOK_MANIFEST[course] ?? {}).map(
    ([lesson, items]) => ({ lesson, items }),
  );
}

/** The saved value shapes the response API stores, loosely typed for reads. */
export type SavedValue = {
  text?: string;
  prompt?: string;
  choices?: string[];
  note?: string;
  question?: string;
  checked?: string[];
  title?: string;
  score?: number;
  total?: number;
  done?: boolean;
};

export type ItemStatus = "empty" | "partial" | "done";

export type ItemState = {
  status: ItemStatus;
  /** Short human summary of the saved state ("3/8 ticked", "4/5"). */
  detail?: string;
};

export function itemState(
  item: WorkbookItem,
  value: SavedValue | null | undefined,
): ItemState {
  if (!value) return { status: "empty" };
  switch (item.kind) {
    case "note":
      return value.text?.trim() ? { status: "done" } : { status: "empty" };
    case "profile":
      return (value.choices?.length ?? 0) > 0 || value.note?.trim()
        ? { status: "done" }
        : { status: "empty" };
    case "checklist": {
      const ticked = value.checked?.length ?? 0;
      const total = item.items?.length ?? 0;
      if (ticked === 0) return { status: "empty" };
      const detail =
        total > 0 ? `${ticked}/${total} ticked` : `${ticked} ticked`;
      return ticked >= total && total > 0
        ? { status: "done", detail }
        : { status: "partial", detail };
    }
    case "quiz":
      return typeof value.total === "number"
        ? { status: "done", detail: `${value.score}/${value.total}` }
        : { status: "empty" };
    case "media":
      return value.done
        ? {
            status: "done",
            detail: item.media === "podcast" ? "Listened" : "Watched",
          }
        : { status: "empty" };
    default:
      return { status: "empty" };
  }
}

export type WorkbookProgress = {
  /** Fully done items. */
  done: number;
  total: number;
};

export function workbookProgress(
  items: WorkbookItem[],
  values: Record<string, SavedValue> | null,
): WorkbookProgress {
  let done = 0;
  for (const item of items) {
    const { status } = itemState(item, values?.[item.key] ?? null);
    if (status === "done") done += 1;
  }
  return { done, total: items.length };
}

/** First render site wins — chapter 10 re-renders some chapter-2 prompts. */
export function dedupeByKey(items: WorkbookItem[]): WorkbookItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.key)) return false;
    seen.add(item.key);
    return true;
  });
}
