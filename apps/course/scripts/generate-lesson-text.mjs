// Bundles each lesson's PROSE (interactive JSX blocks + imports stripped) into
// lib/lesson-text.generated.json — { "<course>/<lesson>": { title, text } }.
// Powers the "Copy for LLM" button at the top of every lesson: the reader gets
// the article as clean Markdown they can paste into any model. Server-side only
// (the page passes just the current lesson's text to the client button), so the
// whole corpus never ships to the browser. Runs in the same hook as the other
// generators so it can't drift.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { remark } from "remark";
import remarkMdx from "remark-mdx";
import { SKIP, visit } from "unist-util-visit";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contentDir = join(appDir, "content/courses");
const outFile = join(appDir, "lib/lesson-text.generated.json");

const processor = remark().use(remarkMdx);

/** Interactive blocks and import/export statements aren't prose — drop them so
 *  the copy is the article, not a wall of quiz JSON. */
const DROP = new Set(["mdxJsxFlowElement", "mdxJsxTextElement", "mdxjsEsm"]);

function toProse(raw) {
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, ""); // strip frontmatter
  const tree = processor.parse(body);
  visit(tree, (node, index, parent) => {
    if (parent && typeof index === "number" && DROP.has(node.type)) {
      parent.children.splice(index, 1);
      return [SKIP, index];
    }
  });
  return processor.stringify(tree).trim();
}

function titleOf(raw) {
  return raw.match(/^title:\s*"([^"]*)"/m)?.[1];
}

function walk(dir, courseDir, out, course) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p, courseDir, out, course);
    } else if (name.endsWith(".mdx")) {
      const lesson = relative(courseDir, p)
        .replace(/\.mdx$/, "")
        .replace(/(^|\/)index$/, "");
      if (!lesson) continue; // course root, if any
      const raw = readFileSync(p, "utf8");
      const text = toProse(raw);
      if (text)
        out[`${course}/${lesson}`] = { title: titleOf(raw) ?? "", text };
    }
  }
}

const map = {};
for (const course of readdirSync(contentDir).sort()) {
  const courseDir = join(contentDir, course);
  if (!statSync(courseDir).isDirectory()) continue;
  walk(courseDir, courseDir, map, course);
}

writeFileSync(outFile, `${JSON.stringify(map, null, 2)}\n`);
console.log(`lesson text: ${Object.keys(map).length} lesson(s) -> ${outFile}`);
