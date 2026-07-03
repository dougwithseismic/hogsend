/**
 * Pure page-tree → course-module logic, deliberately free of Fumadocs / Next /
 * db imports so it can be unit-tested with synthetic trees. `course-ui.tsx`
 * wires the real `source` (getPageTree + getPage) into `buildCourseModules`;
 * the tests wire hand-built trees.
 *
 * The regression this guards against: the overview and the workbook went EMPTY
 * once every chapter became a nested folder, because the course folder was
 * identified by a DIRECT-child lesson page — of which there were none left.
 * `containsCoursePage` now recurses, so the folder still resolves. See the
 * `__tests__/course-tree.test.ts` "all chapters are folders" case.
 */

export type CourseModuleLesson = {
  url: string;
  /** Full path after the course (`01-what-is-posthog/why-measure`), matching
   *  lessonProgress + the workbook manifest key. */
  slug: string;
  title: string;
  description?: string;
  /** 0 for a flat lesson or a chapter hub; 1 for an atom inside a chapter. */
  depth: number;
};

export type CourseModule = {
  /** The `---Module---` separator label, or null for ungrouped lessons. */
  name: string | null;
  lessons: CourseModuleLesson[];
};

/* Minimal structural view of a Fumadocs page tree — only the fields this logic
 * reads. The real tree (with richer `name: ReactNode` etc.) is cast to this at
 * the single boundary in course-ui.tsx. */
export type TreePageNode = { type: "page"; url: string; name?: unknown };
export type TreeSeparatorNode = { type: "separator"; name?: unknown };
export type TreeFolderNode = {
  type: "folder";
  name?: unknown;
  index?: TreePageNode;
  children: TreeNode[];
};
export type TreeNode = TreePageNode | TreeSeparatorNode | TreeFolderNode;
export type PageTreeLike = { children: TreeNode[] };

/** Just the frontmatter fields `toLesson` reads off a resolved page. */
export type LessonPageData = {
  data: { title?: string; description?: string; workbook?: string };
};
export type GetPage = (slugs: string[]) => LessonPageData | undefined | null;

/** `/learn/<course>/<a>/<b>` → `["<course>", "<a>", "<b>"]`. */
export function slugsFromUrl(url: string): string[] {
  return url
    .replace(/^\/learn\//, "")
    .split("/")
    .filter(Boolean);
}

/** Does this node — a page, or ANY page nested under a folder — belong to `slug`? */
export function containsCoursePage(node: TreeNode, slug: string): boolean {
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
export function findCourseFolder(
  tree: PageTreeLike,
  slug: string,
): TreeFolderNode | undefined {
  return tree.children.find(
    (node): node is TreeFolderNode =>
      node.type === "folder" && containsCoursePage(node, slug),
  );
}

/** Turn a tree page/index node into a CourseModuleLesson. */
function toLesson(
  node: TreePageNode,
  depth: number,
  getPage: GetPage,
): CourseModuleLesson {
  const slugs = slugsFromUrl(node.url);
  const page = getPage(slugs);
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
 * that drives the reader sidebar, so the overview and sidebar never drift. A
 * chapter FOLDER contributes its hub (index) at depth 0 followed by its atoms at
 * depth 1, flattened into the module's lesson list in course order.
 */
export function buildCourseModules(
  tree: PageTreeLike,
  getPage: GetPage,
  slug: string,
): CourseModule[] {
  const folder = findCourseFolder(tree, slug);
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
      ensureModule().lessons.push(toLesson(node, 0, getPage));
    } else if (node.type === "folder") {
      // A chapter folder: hub first, then its atoms.
      const mod = ensureModule();
      if (node.index) mod.lessons.push(toLesson(node.index, 0, getPage));
      for (const child of node.children) {
        if (child.type !== "page") continue;
        if (node.index && child.url === node.index.url) continue; // dedupe hub
        mod.lessons.push(toLesson(child, 1, getPage));
      }
    }
  }

  return modules;
}
