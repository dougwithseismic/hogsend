import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The drop-in browser snippet: `@hogsend/js` builds a single minified IIFE to
 * `dist/hogsend.js`, and the engine serves it first-party at `GET /hogsend.js`
 * so a site with no bundler can paste one `<script>` tag.
 *
 * Like the Studio SPA, `@hogsend/js` is NOT a code import of the engine — the
 * asset is located on disk at boot (so consumer bundlers never inline it) and
 * serving is best-effort: no file, no route (404), never a boot crash.
 *
 * Resolution order:
 *  1. `HOGSEND_JS_PATH` env var (explicit file path; absolute or cwd-relative).
 *  2. `require.resolve("@hogsend/js/package.json")` → sibling `dist/hogsend.js`
 *     (the package is installed alongside the engine).
 *  3. Monorepo source layout: `packages/js/dist/hogsend.js` relative to here.
 *  4. cwd-relative `packages/js/dist/hogsend.js`.
 */
export function resolveSnippetPath(): string | null {
  const candidates: string[] = [];

  const envPath = process.env.HOGSEND_JS_PATH;
  if (envPath && envPath.length > 0) {
    candidates.push(resolve(process.cwd(), envPath));
  }

  const require = createRequire(import.meta.url);
  try {
    const pkgJson = require.resolve("@hogsend/js/package.json");
    candidates.push(join(dirname(pkgJson), "dist", "hogsend.js"));
  } catch {
    // Not installed next to the engine — fall through to layout guesses.
  }

  const here = dirname(fileURLToPath(import.meta.url));
  candidates.push(resolve(here, "../../../js/dist/hogsend.js"));
  candidates.push(resolve(process.cwd(), "packages/js/dist/hogsend.js"));
  candidates.push(resolve(process.cwd(), "../../packages/js/dist/hogsend.js"));

  for (const file of candidates) {
    if (existsSync(file)) return file;
  }
  return null;
}

export interface LoadedSnippet {
  /** The JS source, served verbatim. */
  body: string;
  /** Strong ETag: quoted sha256 prefix of the body. */
  etag: string;
  /** Where it was read from (logging). */
  path: string;
}

/**
 * Read the snippet ONCE. The body is small (tens of KB) and immutable for the
 * life of the process, so it stays in memory; the ETag is content-derived so
 * clients revalidate cheaply and a new build invalidates naturally.
 */
export function loadSnippet(
  path: string | null = resolveSnippetPath(),
): LoadedSnippet | null {
  if (!path) return null;
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 32);
  return { body, etag: `"${hash}"`, path };
}
