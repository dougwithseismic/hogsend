// Generates TWO files from the course MDX in one parse:
//
// 1. lib/workbook-manifest.generated.json — the per-lesson inventory of
//    interactive blocks (WorkbookPrompt / CheckIn / Checklist / Quiz /
//    Flashcards / Calculator / VideoEmbed / PodcastLink). The manifest is what
//    lets the chapter callout, the end-of-chapter recap, and /workbook know
//    which answers COULD exist (and ghost the ones that don't yet), without
//    shipping an MDX parser to the server. It is imported by CLIENT components
//    (lib/workbook.ts), so it carries only light, public metadata — labels,
//    counts, media titles/links — never paid chapter content.
//
// 2. lib/workbook-content.generated.json — the rich, PAID block content the
//    workbook chapter pages re-render inline: flashcard decks, quiz question
//    pools, calculator presets. Server-only (lib/workbook-content.ts guards it
//    with `import "server-only"`); it must never be imported from a client
//    module, or the whole course's paid content ships in the public JS bundle.
//
// Runs before build / check-types (see package.json), so neither file can
// drift from the content; it THROWS on any block it can't parse rather than
// silently omitting it.
//
// Keys mirror /api/responses exactly:
//   note:<id> · profile:<id> · checklist:<id> · quiz:<course>/<lesson> · media:<id> · calc:<id> · reading:<id>
// Anchors mirror the DOM ids the block components render (wb-…).

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { remark } from "remark";
import remarkMdx from "remark-mdx";
import { visit } from "unist-util-visit";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contentDir = join(appDir, "content/courses");
const outFile = join(appDir, "lib/workbook-manifest.generated.json");
const contentOutFile = join(appDir, "lib/workbook-content.generated.json");

const parser = remark().use(remarkMdx);

/** Read a JSX attribute off an mdxJsxFlowElement: string literals as-is,
 *  expression values ({[…]}, {2}) evaluated — build-time, our own content. */
function attr(node, name, file) {
  const found = (node.attributes ?? []).find(
    (a) => a.type === "mdxJsxAttribute" && a.name === name,
  );
  if (!found) return undefined;
  // A bare JSX attribute (`<CheckIn multi>`) means true.
  if (found.value == null) return true;
  if (typeof found.value === "string") return found.value;
  if (found.value.type === "mdxJsxAttributeValueExpression") {
    try {
      // eslint-disable-next-line no-new-func
      return new Function(`return (${found.value.value});`)();
    } catch (err) {
      throw new Error(
        `${file}: could not evaluate <${node.name} ${name}={…}>: ${err}`,
      );
    }
  }
  return undefined;
}

function requireAttr(node, name, file) {
  const value = attr(node, name, file);
  if (value === undefined) {
    throw new Error(`${file}: <${node.name}> is missing required "${name}"`);
  }
  return value;
}

/** One lesson MDX file → its ordered workbook items (light manifest) plus the
 *  rich block content (server-only file), keyed by item key. */
function extractItems(filePath, course, lesson) {
  const tree = parser.parse(readFileSync(filePath, "utf8"));
  const items = [];
  const rich = {};

  visit(tree, "mdxJsxFlowElement", (node) => {
    switch (node.name) {
      case "WorkbookPrompt": {
        const id = requireAttr(node, "id", filePath);
        const placeholder = attr(node, "placeholder", filePath);
        const rows = attr(node, "rows", filePath);
        items.push({
          kind: "note",
          id,
          key: `note:${id}`,
          anchor: `wb-${id}`,
          label: requireAttr(node, "prompt", filePath),
          ...(placeholder ? { placeholder } : {}),
          ...(typeof rows === "number" ? { rows } : {}),
        });
        break;
      }
      case "CheckIn": {
        const id = requireAttr(node, "id", filePath);
        const options = attr(node, "options", filePath);
        items.push({
          kind: "profile",
          id,
          key: `profile:${id}`,
          anchor: `wb-${id}`,
          label: requireAttr(node, "question", filePath),
          options: Array.isArray(options) ? options : [],
          ...(attr(node, "multi", filePath) === true ? { multi: true } : {}),
          ...(attr(node, "freeText", filePath) === true
            ? { freeText: true }
            : {}),
        });
        break;
      }
      case "Checklist": {
        const id = requireAttr(node, "id", filePath);
        const list = requireAttr(node, "items", filePath);
        if (!Array.isArray(list)) {
          throw new Error(
            `${filePath}: <Checklist ${id}> items is not an array`,
          );
        }
        items.push({
          kind: "checklist",
          id,
          key: `checklist:${id}`,
          anchor: `wb-${id}`,
          label: attr(node, "title", filePath) ?? "Checklist",
          items: list,
        });
        break;
      }
      case "Quiz": {
        const questions = requireAttr(node, "questions", filePath);
        if (!Array.isArray(questions)) {
          throw new Error(`${filePath}: <Quiz> questions is not an array`);
        }
        const title =
          attr(node, "title", filePath) ?? "Check your understanding";
        const key = `quiz:${course}/${lesson}`;
        items.push({
          kind: "quiz",
          key,
          anchor: "wb-quiz",
          label: title,
          itemCount: questions.length,
        });
        rich[key] = { title, questions };
        break;
      }
      case "Flashcards": {
        const id = requireAttr(node, "id", filePath);
        const cards = requireAttr(node, "cards", filePath);
        if (!Array.isArray(cards)) {
          throw new Error(
            `${filePath}: <Flashcards ${id}> cards is not an array`,
          );
        }
        const title = attr(node, "title", filePath) ?? "Flashcards";
        const key = `flashcards:${id}`;
        items.push({
          kind: "flashcards",
          id,
          key,
          anchor: `wb-${id}`,
          label: title,
          itemCount: cards.length,
        });
        rich[key] = { title, cards };
        break;
      }
      case "Calculator": {
        const id = requireAttr(node, "id", filePath);
        const title = requireAttr(node, "title", filePath);
        const key = `calc:${id}`;
        items.push({
          kind: "calc",
          id,
          key,
          anchor: `wb-${id}`,
          label: title,
        });
        rich[key] = { preset: requireAttr(node, "preset", filePath), title };
        break;
      }
      case "Reading": {
        const id = requireAttr(node, "id", filePath);
        const books = requireAttr(node, "books", filePath);
        if (!Array.isArray(books)) {
          throw new Error(`${filePath}: <Reading ${id}> books is not an array`);
        }
        items.push({
          kind: "reading",
          id,
          key: `reading:${id}`,
          anchor: `wb-${id}`,
          label: attr(node, "title", filePath) ?? "Reading list",
          itemCount: books.length,
          books,
        });
        break;
      }
      case "VideoEmbed": {
        const id = requireAttr(node, "id", filePath);
        const duration = attr(node, "duration", filePath);
        const note = attr(node, "note", filePath);
        items.push({
          kind: "media",
          id,
          key: `media:${id}`,
          anchor: `wb-media-${id}`,
          label: requireAttr(node, "title", filePath),
          media: "video",
          channel: requireAttr(node, "channel", filePath),
          ...(duration ? { duration } : {}),
          ...(note ? { note } : {}),
        });
        break;
      }
      case "PodcastLink": {
        const id = requireAttr(node, "id", filePath);
        const optional = {};
        for (const name of [
          "guest",
          "duration",
          "note",
          "spotify",
          "youtube",
          "apple",
        ]) {
          const value = attr(node, name, filePath);
          if (value) optional[name] = value;
        }
        items.push({
          kind: "media",
          id,
          key: `media:${id}`,
          anchor: `wb-media-${id}`,
          label: requireAttr(node, "title", filePath),
          media: "podcast",
          show: requireAttr(node, "show", filePath),
          ...optional,
        });
        break;
      }
      default:
        break;
    }
  });

  return { items, rich };
}

/**
 * Every lesson MDX under a course dir, recursing chapter folders. The lesson
 * KEY is the file path relative to the course dir minus `.mdx`, so a nested atom
 * keys as `01-what-is-posthog/why-measure` — matching the app's lesson identity
 * (`slugs.slice(1).join("/")`). `index.mdx` in a folder collapses to the folder
 * slug (Fumadocs strips `index` from the URL), so a chapter hub keys as the
 * chapter itself. Numeric filename prefixes make the DFS order == course order.
 */
function walkLessons(dir, courseDir) {
  const results = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      results.push(...walkLessons(p, courseDir));
    } else if (name.endsWith(".mdx")) {
      const lesson = relative(courseDir, p)
        .replace(/\.mdx$/, "")
        .replace(/(^|\/)index$/, "");
      results.push({ lesson, filePath: p });
    }
  }
  return results;
}

const manifest = {};
const content = {};
for (const course of readdirSync(contentDir).sort()) {
  const courseDir = join(contentDir, course);
  if (!statSync(courseDir).isDirectory()) continue;
  const lessons = {};
  const richLessons = {};
  for (const { lesson, filePath } of walkLessons(courseDir, courseDir)) {
    const { items, rich } = extractItems(filePath, course, lesson);
    if (items.length > 0) lessons[lesson] = items;
    if (Object.keys(rich).length > 0) richLessons[lesson] = rich;
  }
  if (Object.keys(lessons).length > 0) manifest[course] = lessons;
  if (Object.keys(richLessons).length > 0) content[course] = richLessons;
}

// Note: the same key MAY appear in more than one lesson on purpose — chapter 10
// re-renders note:activation-sentence so the chapter-2 draft pre-fills there.
// Display surfaces dedupe by key; the manifest records every render site.

writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(contentOutFile, `${JSON.stringify(content, null, 2)}\n`);
const total = Object.values(manifest)
  .flatMap((lessons) => Object.values(lessons))
  .reduce((n, items) => n + items.length, 0);
const richTotal = Object.values(content)
  .flatMap((lessons) => Object.values(lessons))
  .reduce((n, rich) => n + Object.keys(rich).length, 0);
console.log(
  `workbook manifest: ${total} items across ${Object.keys(manifest).length} course(s) -> ${outFile}`,
);
console.log(
  `workbook content: ${richTotal} rich blocks (server-only) -> ${contentOutFile}`,
);
