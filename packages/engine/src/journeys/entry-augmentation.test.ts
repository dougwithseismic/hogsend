import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The module whose `declare module` narrows `ctx.history.email/sms`. */
const AUGMENTATION = resolve(SRC, "journeys/template-key-augmentation.ts");

/**
 * Every published entry point through which a consumer can end up holding a
 * `JourneyContext`. `@hogsend/engine/journeys` is what journey files import,
 * `@hogsend/engine/testing` is what the `@hogsend/testing` harness imports,
 * and `.` is the API/worker entry.
 */
const ENTRY_POINTS = [
  "journeys/authoring.ts",
  "testing.ts",
  "index.ts",
] as const;

/** `from "./x.js"` — covers both `import ... from` and `export ... from`. */
const FROM_IMPORT = /\bfrom\s*["'](\.[^"']+)["']/g;
/** `import "./x.js"` — the side-effect form the augmentation is loaded with. */
const BARE_IMPORT = /\bimport\s*["'](\.[^"']+)["']/g;

/** Resolve a `./x.js` specifier back to the `.ts` source it was written from. */
function resolveSource(fromFile: string, specifier: string): string | null {
  const raw = resolve(dirname(fromFile), specifier);
  for (const candidate of [raw.replace(/\.js$/, ".ts"), `${raw}.ts`, raw]) {
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      // Not a first-party source file (bare package, .d.ts, directory) — skip.
    }
  }
  return null;
}

/** Files reachable from `entry` by first-party relative imports. */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const pattern of [FROM_IMPORT, BARE_IMPORT]) {
      for (const [, specifier] of source.matchAll(pattern)) {
        if (!specifier) continue;
        const next = resolveSource(file, specifier);
        if (next) queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * A module augmentation only applies to programs that LOAD the file declaring
 * it. The narrowing of `ctx.history.email({ template })` therefore has a
 * reachability precondition that no type-level assertion inside this package
 * can express: the engine's own program always loads the augmentation, so a
 * consumer program compiling `@hogsend/engine/journeys` in isolation can lose
 * the narrowing while every check-types in this repo stays green — and the
 * `template` argument silently reverts to an unchecked `string`, which is the
 * exact defect the narrowing exists to remove.
 *
 * This walks the first-party import graph of each published entry point and
 * asserts the augmentation is in it. Drop the side-effect import from
 * `journeys/authoring.ts` or `testing.ts` and this goes red.
 */
test("every JourneyContext entry point loads the template-key augmentation", () => {
  for (const entry of ENTRY_POINTS) {
    const reachable = reachableFrom(resolve(SRC, entry));
    assert.ok(
      reachable.has(AUGMENTATION),
      `${entry} does not transitively load template-key-augmentation.ts, so ` +
        "ctx.history.email/sms template keys are unchecked strings there",
    );
  }
});
