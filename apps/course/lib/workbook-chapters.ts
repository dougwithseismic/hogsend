import type { CourseModule } from "./course-tree";
import { dedupeByKey, type WorkbookItem } from "./workbook";

/**
 * Groups a course's workbook items by CHAPTER (the depth-0 spine entries —
 * chapter hubs or flat lessons), aggregating each chapter's atoms in course
 * order. This is the shape the multi-page workbook renders: /workbook lists
 * chapters, /workbook/[course]/[chapter] renders one chapter's items start to
 * finish. Pure module/manifest logic — no Fumadocs, Next, or db imports — so
 * it unit-tests with synthetic modules (see __tests__/workbook-chapters).
 */

export type WorkbookChapterAtom = {
  /** Full lesson sub-path (`01-what-is-posthog/why-measure`) — keys the
   *  manifest, LessonProvider, and response provenance. */
  lesson: string;
  title: string;
  url: string;
  items: WorkbookItem[];
};

export type WorkbookChapter = {
  course: string;
  /** Chapter identity for the route: the chapter folder (`01-what-is-posthog`),
   *  or the lesson slug itself for a flat (folderless) lesson. */
  slug: string;
  /** Spine position among depth-0 entries — matches the course overview's
   *  chapter numbering, counting chapters that carry no workbook items. */
  num: number;
  title: string;
  /** The chapter hub URL (or the flat lesson's URL). */
  url: string;
  moduleName: string | null;
  /** Only the lessons that carry items (hub included when it has any). */
  atoms: WorkbookChapterAtom[];
  /** All chapter items in course order, deduped by key within the chapter. */
  items: WorkbookItem[];
};

export function buildWorkbookChapters(
  course: string,
  modules: CourseModule[],
  itemsOf: (lesson: string) => WorkbookItem[],
): WorkbookChapter[] {
  const chapters: WorkbookChapter[] = [];
  let current: WorkbookChapter | null = null;
  let num = 0;

  for (const courseModule of modules) {
    for (const lesson of courseModule.lessons) {
      if (lesson.depth === 0) {
        num += 1;
        current = {
          course,
          slug: chapterSlugOfLesson(lesson.slug),
          num,
          title: lesson.title,
          url: lesson.url,
          moduleName: courseModule.name,
          atoms: [],
          items: [],
        };
        chapters.push(current);
      }
      if (!current) continue; // malformed tree: atom before any chapter head
      const items = itemsOf(lesson.slug);
      if (items.length === 0) continue;
      current.atoms.push({
        lesson: lesson.slug,
        title: lesson.title,
        url: lesson.url,
        items,
      });
    }
  }

  for (const chapter of chapters) {
    chapter.items = dedupeByKey(chapter.atoms.flatMap((atom) => atom.items));
  }
  return chapters.filter((chapter) => chapter.items.length > 0);
}

/** The chapter a lesson belongs to: its folder, or the flat slug itself. */
export function chapterSlugOfLesson(lesson: string): string {
  return lesson.split("/")[0];
}
