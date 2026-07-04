import { CircleCheck, Lock } from "lucide-react";
import {
  buildCourseModules,
  type GetPage,
  type PageTreeLike,
  slugsFromUrl,
} from "@/lib/course-tree";
import { ALL_ACCESS_SLUG } from "@/lib/courses";
import { isCoursePaywalled } from "@/lib/entitlements";
import { isFreeLesson } from "@/lib/gating";
import { source } from "@/lib/source";

export type { CourseModule, CourseModuleLesson } from "@/lib/course-tree";
// The pure module-grouping logic (findCourseFolder / buildCourseModules) lives
// in ./course-tree so it can be unit-tested with synthetic trees. Types and
// slugsFromUrl are re-exported so existing importers of @/lib/course-ui keep
// working.
export { slugsFromUrl };

// Derive the page-tree types straight from the loader so we don't depend on a
// fumadocs internal import path (which varies across versions).
type PageTreeRoot = ReturnType<typeof source.getPageTree>;
type TreeNode = PageTreeRoot["children"][number];
type ItemNode = Extract<TreeNode, { type: "page" }>;

/**
 * Lessons grouped by their meta.json `---Module---` separators — the same tree
 * that drives the reader sidebar, so the overview and sidebar never drift.
 * Wires the real Fumadocs `source` into the pure `buildCourseModules`; the cast
 * is the single boundary where the rich tree becomes the minimal structural one.
 */
export function getCourseModules(slug: string) {
  return buildCourseModules(
    source.getPageTree() as unknown as PageTreeLike,
    ((slugs) => source.getPage(slugs)) as GetPage,
    slug,
  );
}

/**
 * Chapter count for a course — depth-0 lessons (flat lessons + chapter hubs).
 * The single "what is a chapter" rule shared by the catalog stat band and the
 * course landing page, so marketed counts can't drift from the content.
 */
export function countChapters(slug: string): number {
  return getCourseModules(slug)
    .flatMap((m) => m.lessons)
    .filter((l) => l.depth === 0).length;
}

/* -------------------------------------------------------------------------- */
/*  Sidebar lock decoration (lesson reader)                                   */
/* -------------------------------------------------------------------------- */

const LOCK_ICON = <Lock className="size-3.5 text-white/40" aria-hidden />;
const DONE_ICON = <CircleCheck className="size-3.5 text-good" aria-hidden />;

/**
 * A CLONE of the page tree (never mutate the memoized one) with a lock icon on
 * every lesson the viewer can't yet read — a non-first lesson of a paywalled
 * course they don't own (directly or via all-access) — and a check on every
 * lesson they've completed. `ownedSlugs` is the viewer's paid SKUs (empty for
 * signed-out); `completedLessons` holds "course/lesson" keys. The lesson
 * reader is already per-request (force-dynamic), so resolving these against
 * the session is free.
 */
export function decorateTree(
  tree: PageTreeRoot,
  ownedSlugs: Set<string>,
  completedLessons: Set<string> = new Set(),
): PageTreeRoot {
  const hasAllAccess = ownedSlugs.has(ALL_ACCESS_SLUG);

  const decorate = (node: TreeNode): TreeNode => {
    if (node.type === "folder") {
      return {
        ...node,
        index: node.index ? (decorate(node.index) as ItemNode) : node.index,
        children: node.children.map(decorate),
      };
    }
    if (node.type === "page") {
      const slugs = slugsFromUrl(node.url);
      const course = slugs[0];
      const gated =
        slugs.length >= 2 &&
        !isFreeLesson(slugs) &&
        isCoursePaywalled(course) &&
        !(hasAllAccess || ownedSlugs.has(course));
      if (gated) return { ...node, icon: LOCK_ICON };
      if (slugs.length >= 2 && completedLessons.has(slugs.join("/"))) {
        return { ...node, icon: DONE_ICON };
      }
      return node;
    }
    return node;
  };

  return { ...tree, children: tree.children.map(decorate) };
}
