import { describe, expect, it } from "vitest";
import {
  buildCourseModules,
  containsCoursePage,
  findCourseFolder,
  type GetPage,
  type PageTreeLike,
  slugsFromUrl,
  type TreeFolderNode,
  type TreePageNode,
} from "../course-tree";

/* -------------------------------------------------------------------------- */
/*  Fixture builders — mimic the shape of a Fumadocs page tree                 */
/* -------------------------------------------------------------------------- */

const C = "growth-with-posthog";
const page = (path: string, name?: string): TreePageNode => ({
  type: "page",
  url: `/learn/${C}/${path}`,
  name,
});
const sep = (name: string) => ({ type: "separator" as const, name });

/** A chapter FOLDER: hub (index) + the hub page + atom pages, like the real tree. */
function chapterFolder(chapter: string, atoms: string[]): TreeFolderNode {
  const hub = page(chapter);
  return {
    type: "folder",
    name: chapter,
    index: hub,
    children: [hub, ...atoms.map((a) => page(`${chapter}/${a}`))],
  };
}

/** The full course, EVERY chapter a nested folder — the post-atomization shape
 *  that broke the overview + workbook. Root has a single course folder whose
 *  direct children are all sub-folders + separators (NO direct lesson page). */
function allFoldersTree(): PageTreeLike {
  return {
    children: [
      {
        type: "folder",
        name: C,
        children: [
          sep("Measure"),
          chapterFolder("00-product-led-growth", ["01-the-shift", "02-plg"]),
          chapterFolder("01-what-is-posthog", ["01-why-measure"]),
          sep("Keep"),
          chapterFolder("05-lifecycle-messaging", ["01-plug", "02-stages"]),
        ],
      },
    ],
  };
}

/** No-op page resolver: titles/descriptions come back empty (fallbacks apply). */
const noPages: GetPage = () => undefined;
/** A resolver that returns a title for a given full slug path. */
const titledPages =
  (titles: Record<string, string>): GetPage =>
  (slugs) => {
    const title = titles[slugs.join("/")];
    return title ? { data: { title } } : undefined;
  };

/* -------------------------------------------------------------------------- */

describe("slugsFromUrl", () => {
  it("strips the /learn/ prefix and splits into segments", () => {
    expect(
      slugsFromUrl("/learn/growth-with-posthog/02-aarrr/01-metrics"),
    ).toEqual(["growth-with-posthog", "02-aarrr", "01-metrics"]);
  });

  it("drops empty segments from trailing slashes", () => {
    expect(slugsFromUrl("/learn/growth-with-posthog/")).toEqual([
      "growth-with-posthog",
    ]);
  });
});

describe("containsCoursePage", () => {
  it("matches a direct page of the course", () => {
    expect(containsCoursePage(page("01-what-is-posthog"), C)).toBe(true);
  });

  it("does not match a page from a different course", () => {
    const other: TreePageNode = { type: "page", url: "/learn/other-course/01" };
    expect(containsCoursePage(other, C)).toBe(false);
  });

  it("recurses into folders — the regression's crux (page nested, not direct)", () => {
    const folder = chapterFolder("02-aarrr", ["01-metrics"]);
    expect(containsCoursePage(folder, C)).toBe(true);
  });

  it("returns false for a separator node", () => {
    expect(containsCoursePage(sep("Measure"), C)).toBe(false);
  });
});

describe("findCourseFolder", () => {
  it("REGRESSION: finds the course folder when EVERY chapter is a nested folder", () => {
    // Before the fix this returned undefined (no direct child page), which made
    // getCourseModules return [] and the overview + workbook render empty.
    const folder = findCourseFolder(allFoldersTree(), C);
    expect(folder).toBeDefined();
    expect(folder?.type).toBe("folder");
  });

  it("returns undefined when no folder holds a page for the course", () => {
    const tree: PageTreeLike = {
      children: [
        {
          type: "folder",
          name: "other",
          children: [{ type: "page", url: "/learn/other-course/01" }],
        },
      ],
    };
    expect(findCourseFolder(tree, C)).toBeUndefined();
  });

  it("selects the right course folder when several courses coexist", () => {
    const tree: PageTreeLike = {
      children: [
        {
          type: "folder",
          name: "other",
          children: [{ type: "page", url: "/learn/other/01" }],
        },
        allFoldersTree().children[0],
      ],
    };
    const folder = findCourseFolder(tree, C);
    expect(folder).toBeDefined();
    expect(containsCoursePage(folder as TreeFolderNode, C)).toBe(true);
  });
});

describe("buildCourseModules", () => {
  it("REGRESSION: returns all lessons when every chapter is a folder (was empty)", () => {
    const modules = buildCourseModules(allFoldersTree(), noPages, C);
    const lessons = modules.flatMap((m) => m.lessons);
    // 3 chapters → 3 hubs + (2 + 1 + 2) atoms = 8 lessons.
    expect(lessons).toHaveLength(8);
    // The specific symptom Doug saw: the list is NOT empty.
    expect(lessons.length).toBeGreaterThan(0);
    // Nested atoms carry the full sub-path (matches the workbook manifest key).
    expect(lessons.map((l) => l.slug)).toContain(
      "00-product-led-growth/01-the-shift",
    );
    expect(lessons.map((l) => l.slug)).toContain(
      "05-lifecycle-messaging/02-stages",
    );
  });

  it("groups lessons under their ---Module--- separators", () => {
    const modules = buildCourseModules(allFoldersTree(), noPages, C);
    expect(modules.map((m) => m.name)).toEqual(["Measure", "Keep"]);
    // Measure holds chapters 00 + 01: (hub+2) + (hub+1) = 5 lessons.
    expect(modules[0].lessons).toHaveLength(5);
    // Keep holds chapter 05: hub + 2 atoms = 3 lessons.
    expect(modules[1].lessons).toHaveLength(3);
  });

  it("tags the hub depth 0 and its atoms depth 1, in reading order", () => {
    const [measure] = buildCourseModules(allFoldersTree(), noPages, C);
    expect(measure.lessons.slice(0, 3)).toMatchObject([
      { slug: "00-product-led-growth", depth: 0 },
      { slug: "00-product-led-growth/01-the-shift", depth: 1 },
      { slug: "00-product-led-growth/02-plg", depth: 1 },
    ]);
  });

  it("does not double-count the hub (index page also listed among children)", () => {
    const [measure] = buildCourseModules(allFoldersTree(), noPages, C);
    const hubs = measure.lessons.filter(
      (l) => l.slug === "00-product-led-growth",
    );
    expect(hubs).toHaveLength(1);
  });

  it("still handles a flat lesson page as a direct child (mixed structure)", () => {
    const tree: PageTreeLike = {
      children: [
        {
          type: "folder",
          name: C,
          children: [
            page("00-intro", "Intro"), // flat lesson, no folder
            chapterFolder("01-what-is-posthog", ["01-why"]),
          ],
        },
      ],
    };
    const lessons = buildCourseModules(tree, noPages, C).flatMap(
      (m) => m.lessons,
    );
    expect(lessons.map((l) => l.slug)).toEqual([
      "00-intro",
      "01-what-is-posthog",
      "01-what-is-posthog/01-why",
    ]);
    expect(lessons[0].depth).toBe(0);
  });

  it("takes each lesson title from getPage, falling back to the url", () => {
    const titled = buildCourseModules(
      allFoldersTree(),
      titledPages({
        "growth-with-posthog/01-what-is-posthog": "What PostHog is",
      }),
      C,
    ).flatMap((m) => m.lessons);
    const hub = titled.find((l) => l.slug === "01-what-is-posthog");
    expect(hub?.title).toBe("What PostHog is");
    // A lesson getPage doesn't resolve falls back to its url.
    const atom = titled.find(
      (l) => l.slug === "01-what-is-posthog/01-why-measure",
    );
    expect(atom?.title).toBe(
      "/learn/growth-with-posthog/01-what-is-posthog/01-why-measure",
    );
  });

  it("returns [] when the course has no folder in the tree", () => {
    const tree: PageTreeLike = {
      children: [
        {
          type: "folder",
          name: "other",
          children: [{ type: "page", url: "/learn/other/01" }],
        },
      ],
    };
    expect(buildCourseModules(tree, noPages, C)).toEqual([]);
  });
});
