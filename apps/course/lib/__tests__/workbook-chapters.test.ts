import { describe, expect, it } from "vitest";
import type { CourseModule } from "../course-tree";
import type { WorkbookItem } from "../workbook";
import {
  buildWorkbookChapters,
  chapterSlugOfLesson,
} from "../workbook-chapters";

const C = "growth-with-posthog";

const lesson = (slug: string, depth: number, title = slug) => ({
  url: `/learn/${C}/${slug}`,
  slug,
  title,
  depth,
});

const item = (key: string): WorkbookItem => ({
  kind: "note",
  id: key,
  key: `note:${key}`,
  anchor: `wb-${key}`,
  label: key,
});

/** Two modules; ch folders with atoms; one flat lesson; one itemless chapter. */
const modules: CourseModule[] = [
  {
    name: "Measure",
    lessons: [
      lesson("00-plg", 0, "Product-led growth"),
      lesson("00-plg/what-plg-is", 1),
      lesson("00-plg/why-it-wins", 1),
      lesson("01-posthog", 0, "What PostHog is"),
      lesson("01-posthog/events", 1),
    ],
  },
  {
    name: "Keep",
    lessons: [
      lesson("02-lifecycle", 0, "Lifecycle messaging"),
      lesson("02-lifecycle/emails", 1),
      lesson("03-flat-lesson", 0, "A flat lesson"),
    ],
  },
];

const itemsByLesson: Record<string, WorkbookItem[]> = {
  "00-plg/what-plg-is": [item("a"), item("b")],
  "00-plg/why-it-wins": [item("c")],
  "01-posthog/events": [item("d")],
  "03-flat-lesson": [item("e")],
  // 02-lifecycle has NO items anywhere — it must not appear.
};

const itemsOf = (l: string) => itemsByLesson[l] ?? [];

describe("buildWorkbookChapters", () => {
  const chapters = buildWorkbookChapters(C, modules, itemsOf);

  it("groups atoms under their chapter folder, dropping itemless chapters", () => {
    expect(chapters.map((c) => c.slug)).toEqual([
      "00-plg",
      "01-posthog",
      "03-flat-lesson",
    ]);
    expect(chapters[0].atoms.map((a) => a.lesson)).toEqual([
      "00-plg/what-plg-is",
      "00-plg/why-it-wins",
    ]);
    expect(chapters[0].items.map((i) => i.key)).toEqual([
      "note:a",
      "note:b",
      "note:c",
    ]);
  });

  it("numbers chapters by spine position, counting itemless ones", () => {
    // 02-lifecycle is chapter 3 in the spine even though it renders nothing,
    // so the flat lesson after it must be chapter 4 — matching the course
    // overview's numbering.
    expect(chapters.map((c) => c.num)).toEqual([1, 2, 4]);
  });

  it("carries the module label and the chapter hub url", () => {
    expect(chapters[0].moduleName).toBe("Measure");
    expect(chapters[2].moduleName).toBe("Keep");
    expect(chapters[0].url).toBe(`/learn/${C}/00-plg`);
    expect(chapters[0].title).toBe("Product-led growth");
  });

  it("treats a flat lesson as its own chapter", () => {
    const flat = chapters[2];
    expect(flat.slug).toBe("03-flat-lesson");
    expect(flat.atoms).toHaveLength(1);
    expect(flat.atoms[0].lesson).toBe("03-flat-lesson");
  });

  it("dedupes a re-rendered key within a chapter but keeps cross-chapter re-renders", () => {
    const withDupes: Record<string, WorkbookItem[]> = {
      "00-plg/what-plg-is": [item("a")],
      "00-plg/why-it-wins": [item("a")], // same key twice in one chapter
      "01-posthog/events": [item("a")], // deliberate re-render in a later chapter
    };
    const result = buildWorkbookChapters(C, modules, (l) => withDupes[l] ?? []);
    expect(result[0].items.map((i) => i.key)).toEqual(["note:a"]);
    expect(result[1].items.map((i) => i.key)).toEqual(["note:a"]);
  });
});

describe("chapterSlugOfLesson", () => {
  it("returns the chapter folder for a nested atom and the slug for a flat lesson", () => {
    expect(chapterSlugOfLesson("01-posthog/events")).toBe("01-posthog");
    expect(chapterSlugOfLesson("03-flat-lesson")).toBe("03-flat-lesson");
  });
});
