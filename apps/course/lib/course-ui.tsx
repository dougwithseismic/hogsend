import { CircleCheck, Lock } from "lucide-react";
import { ALL_ACCESS_SLUG } from "@/lib/courses";
import { isCoursePaywalled } from "@/lib/entitlements";
import { isFreeLesson } from "@/lib/gating";
import { source } from "@/lib/source";

// Derive the page-tree types straight from the loader so we don't depend on a
// fumadocs internal import path (which varies across versions).
type PageTreeRoot = ReturnType<typeof source.getPageTree>;
type TreeNode = PageTreeRoot["children"][number];
type FolderNode = Extract<TreeNode, { type: "folder" }>;
type ItemNode = Extract<TreeNode, { type: "page" }>;

export function slugsFromUrl(url: string): string[] {
  return url
    .replace(/^\/learn\//, "")
    .split("/")
    .filter(Boolean);
}

/* -------------------------------------------------------------------------- */
/*  Module grouping (overview page)                                           */
/* -------------------------------------------------------------------------- */

export type CourseModuleLesson = {
  url: string;
  slug: string;
  title: string;
  description?: string;
};

export type CourseModule = {
  /** The `---Module---` separator label, or null for ungrouped lessons. */
  name: string | null;
  lessons: CourseModuleLesson[];
};

function findCourseFolder(
  tree: PageTreeRoot,
  slug: string,
): FolderNode | undefined {
  for (const node of tree.children) {
    if (
      node.type === "folder" &&
      node.children.some(
        (c) => c.type === "page" && c.url.startsWith(`/learn/${slug}/`),
      )
    ) {
      return node;
    }
  }
  return undefined;
}

/**
 * Lessons grouped by their meta.json `---Module---` separators — the same tree
 * that drives the reader sidebar, so the overview and sidebar never drift.
 * Titles/descriptions come from each lesson's frontmatter via source.getPage.
 */
export function getCourseModules(slug: string): CourseModule[] {
  const folder = findCourseFolder(source.getPageTree(), slug);
  if (!folder) return [];

  const modules: CourseModule[] = [];
  let current: CourseModule | null = null;

  for (const node of folder.children) {
    if (node.type === "separator") {
      current = {
        name: typeof node.name === "string" ? node.name : null,
        lessons: [],
      };
      modules.push(current);
    } else if (node.type === "page") {
      if (!current) {
        current = { name: null, lessons: [] };
        modules.push(current);
      }
      const slugs = slugsFromUrl(node.url);
      const page = source.getPage(slugs);
      current.lessons.push({
        url: node.url,
        slug: slugs[slugs.length - 1] ?? "",
        title:
          page?.data.title ??
          (typeof node.name === "string" ? node.name : node.url),
        description: page?.data.description,
      });
    }
  }

  return modules;
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
