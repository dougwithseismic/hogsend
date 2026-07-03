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
  /** Full path after the course (`01-what-is-posthog/why-measure`), matching
   *  lessonProgress + the workbook manifest key. */
  slug: string;
  title: string;
  description?: string;
  /** 0 for a flat lesson or a chapter hub; 1 for an atom inside a chapter — the
   *  overview indents atoms under their chapter. */
  depth: number;
};

export type CourseModule = {
  /** The `---Module---` separator label, or null for ungrouped lessons. */
  name: string | null;
  lessons: CourseModuleLesson[];
};

/** Does this node (a page, or any page nested under a folder) belong to `slug`? */
function containsCoursePage(node: TreeNode, slug: string): boolean {
  if (node.type === "page") return node.url.startsWith(`/learn/${slug}/`);
  if (node.type === "folder") {
    if (node.index && containsCoursePage(node.index, slug)) return true;
    return node.children.some((c) => containsCoursePage(c, slug));
  }
  return false;
}

/**
 * The root-level folder for a course. Identified by ANY page under it (at any
 * depth) — not just a direct child — so it still resolves once every chapter is
 * a nested folder (no flat lessons left as direct page children).
 */
function findCourseFolder(
  tree: PageTreeRoot,
  slug: string,
): FolderNode | undefined {
  return tree.children.find(
    (node): node is FolderNode =>
      node.type === "folder" && containsCoursePage(node, slug),
  );
}

/** Turn a tree page/index node into a CourseModuleLesson. */
function toLesson(node: ItemNode, depth: number): CourseModuleLesson {
  const slugs = slugsFromUrl(node.url);
  const page = source.getPage(slugs);
  return {
    url: node.url,
    slug: slugs.slice(1).join("/"),
    title:
      page?.data.title ??
      (typeof node.name === "string" ? node.name : node.url),
    description: page?.data.description,
    depth,
  };
}

/**
 * Lessons grouped by their meta.json `---Module---` separators — the same tree
 * that drives the reader sidebar, so the overview and sidebar never drift.
 * A chapter FOLDER contributes its hub (index) at depth 0 followed by its atoms
 * at depth 1, flattened into the module's lesson list in course order.
 * Titles/descriptions come from each lesson's frontmatter via source.getPage.
 */
export function getCourseModules(slug: string): CourseModule[] {
  const folder = findCourseFolder(source.getPageTree(), slug);
  if (!folder) return [];

  const modules: CourseModule[] = [];
  let current: CourseModule | null = null;
  const ensureModule = (): CourseModule => {
    if (!current) {
      current = { name: null, lessons: [] };
      modules.push(current);
    }
    return current;
  };

  for (const node of folder.children) {
    if (node.type === "separator") {
      current = {
        name: typeof node.name === "string" ? node.name : null,
        lessons: [],
      };
      modules.push(current);
    } else if (node.type === "page") {
      ensureModule().lessons.push(toLesson(node, 0));
    } else if (node.type === "folder") {
      // A chapter folder: hub first, then its atoms.
      const mod = ensureModule();
      if (node.index) mod.lessons.push(toLesson(node.index, 0));
      for (const child of node.children) {
        if (child.type !== "page") continue;
        if (node.index && child.url === node.index.url) continue; // dedupe hub
        mod.lessons.push(toLesson(child, 1));
      }
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
