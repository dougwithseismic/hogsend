import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import * as parser from "@babel/parser";

/**
 * Server half of the Hogsend inspector — the dev-only endpoints a browser tab
 * can't perform itself: launching an editor, and writing an edit back to source.
 *
 *   // app/api/devtools/open/route.ts
 *   import { createOpenHandler } from "@hogsend/inspector/server";
 *   export const POST = createOpenHandler();
 *
 *   // app/api/devtools/edit/route.ts
 *   import { createEditHandler } from "@hogsend/inspector/server";
 *   export const POST = createEditHandler();
 *
 *   // app/api/devtools/style/route.ts
 *   import { createStyleHandler } from "@hogsend/inspector/server";
 *   export const POST = createStyleHandler();
 *
 * The edit path is fully DETERMINISTIC (no agent, no fuzzy string match): the
 * `data-hs-source="file:line:col"` stamp pins the exact JSX element, so we parse
 * the file, find that element by position, and replace its individual text runs
 * BY SOURCE RANGE. That handles `<br/>`-split headings, HTML-entity escaping
 * (`&apos;`), and duplicate strings — none of which string-matching can.
 *
 * Safety envelope (these can spawn a process / write files on the dev machine):
 *  - DEV ONLY: hard 404 unless NODE_ENV is exactly "development". This is the
 *    primary
 *    gate; if you ever expose your dev server publicly (a tunnel / --hostname
 *    0.0.0.0), gate these routes further or don't mount them.
 *  - Same-origin: blocks browser-driven CSRF (a random website driving
 *    localhost). It is NOT an auth control against a non-browser client — the
 *    real protection is the dev-only gate above.
 *  - Path allowlist: the resolved file must stay inside `root` — no traversal.
 *  - Edits are anchored to an AST position + an optimistic `expectedOld` check,
 *    so a drifted file aborts instead of writing the wrong place.
 *  - argv spawn (never a shell string), so a crafted path can't inject a command.
 */

export type InspectorServerOptions = {
  /** Editor launcher command. `cursor`/`code` accept `-g file:line:col`. */
  editor?: string;
  /** Root the stamped (relative) paths resolve against. Default: cwd. */
  root?: string;
};

function sameOrigin(req: Request): boolean {
  // A genuine same-origin fetch from the overlay always sets
  // `sec-fetch-site: same-origin`. We deliberately do NOT accept "none" (a
  // direct/scripted request) for these state-changing routes.
  if (req.headers.get("sec-fetch-site") === "same-origin") return true;
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === req.headers.get("host");
  } catch {
    return false;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Shared preamble for the side-effecting routes — the single source of the
 * safety envelope: hard 404 outside explicit development, same-origin only,
 * then a parsed JSON body. Returns either the parsed body or the Response to
 * short-circuit with.
 */
async function readGuardedBody<T>(
  req: Request,
): Promise<{ body: T } | { res: Response }> {
  if (process.env.NODE_ENV !== "development") {
    return { res: new Response(null, { status: 404 }) };
  }
  if (!sameOrigin(req)) {
    return { res: json({ error: "cross-origin denied" }, 403) };
  }
  try {
    return { body: (await req.json()) as T };
  } catch {
    return { res: json({ error: "bad json" }, 400) };
  }
}

function resolveInRoot(root: string, rel: string): string | null {
  const lexicalRoot = path.resolve(root);
  const abs = path.resolve(lexicalRoot, rel);
  if (!abs.startsWith(path.join(lexicalRoot, path.sep))) return null;
  if (!existsSync(abs)) return abs;

  try {
    const canonicalRoot = realpathSync(lexicalRoot);
    const canonicalFile = realpathSync(abs);
    if (!canonicalFile.startsWith(path.join(canonicalRoot, path.sep))) {
      return null;
    }
    return canonicalFile;
  } catch {
    return null;
  }
}

// ── open in editor ─────────────────────────────────────────────────────────

type OpenPayload = {
  file?: string;
  line?: number;
  col?: number;
  dryRun?: boolean;
};

export function createOpenHandler(opts: InspectorServerOptions = {}) {
  const editor = opts.editor ?? process.env.HS_EDITOR ?? "cursor";
  const root = opts.root ?? process.cwd();

  return async function POST(req: Request): Promise<Response> {
    const guarded = await readGuardedBody<OpenPayload>(req);
    if ("res" in guarded) return guarded.res;
    const body = guarded.body;

    const rel = typeof body.file === "string" ? body.file : "";
    const line = Number.isFinite(body.line) ? Number(body.line) : 1;
    const col = Number.isFinite(body.col) ? Number(body.col) : 1;
    if (!rel) return json({ error: "no file" }, 400);

    const abs = resolveInRoot(root, rel);
    if (!abs) return json({ error: "path not allowed" }, 403);
    if (!existsSync(abs)) return json({ error: "file not found" }, 404);

    const target = `${abs}:${line}:${col}`;
    if (body.dryRun) return json({ ok: true, dryRun: true, editor, target });

    try {
      const child = spawn(editor, ["-g", target], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } catch (err) {
      return json({ error: "spawn failed", detail: String(err) }, 500);
    }
    return json({ ok: true, target });
  };
}

// ── inline text edit → deterministic write-back ──────────────────────────────

/* biome-ignore lint/suspicious/noExplicitAny: babel AST nodes, walked loosely. */
type Node = any;

function decodeEntities(s: string): string {
  return s
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#123;/g, "{")
    .replace(/&#125;/g, "}")
    .replace(/&amp;/g, "&");
}

/** Escape a plain string so it's valid as JSX text. */
function escapeJsxText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/{/g, "&#123;")
    .replace(/}/g, "&#125;");
}

/** Collapse whitespace + decode entities, for comparing source vs rendered. */
function norm(s: string): string {
  return decodeEntities(s).replace(/\s+/g, " ").trim();
}

/** Find the JSXElement whose opening tag starts at (line, col) — col is 1-based. */
function findElementAt(root: Node, line: number, col: number): Node | null {
  const stack: Node[] = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (node.type === "JSXElement") {
      const s = node.openingElement?.loc?.start;
      if (s && s.line === line && s.column === col - 1) return node;
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "range")
        continue;
      const val = (node as Record<string, unknown>)[key];
      if (Array.isArray(val)) {
        for (const c of val) if (c && typeof c === "object") stack.push(c);
      } else if (val && typeof val === "object" && "type" in val) {
        stack.push(val);
      }
    }
  }
  return null;
}

type EditOp = { index: number; expectedOld?: string; newText: string };
export type InspectorSourceStamp = {
  file: string;
  line: number;
  col: number;
};
type Stamp = InspectorSourceStamp;
type EditPayload = {
  candidates?: Stamp[];
  // legacy single-target form
  file?: string;
  line?: number;
  col?: number;
  edits?: EditOp[];
  dryRun?: boolean;
};

type Patch = { start: number; end: number; text: string };

/** Try to build patches for `edits` against the element at (line,col) in `ast`.
 *  Returns null if this candidate doesn't own matching text runs. */
function matchCandidate(
  ast: Node,
  line: number,
  col: number,
  edits: EditOp[],
): Patch[] | null {
  const el = findElementAt(ast, line, col);
  if (!el) return null;
  const runs: Node[] = (el.children ?? []).filter(
    (c: Node) => c.type === "JSXText" && c.value.trim() !== "",
  );
  const patches: Patch[] = [];
  for (const e of edits) {
    // Prefer the run at the reported index. But the browser's DOM text-run index
    // can drift from the source JSXText index when the element interleaves text
    // with a {expression} (which renders a DOM text node yet is not a JSXText
    // child). So if the indexed run doesn't match, fall back to a UNIQUE
    // content match on expectedOld — index-independent and unambiguous.
    const want = e.expectedOld != null ? norm(e.expectedOld) : null;
    let node = runs[e.index];
    if (want != null && (!node || norm(node.value) !== want)) {
      const byText = runs.filter((r: Node) => norm(r.value) === want);
      node = byText.length === 1 ? byText[0] : undefined;
    }
    if (!node) return null; // no run / ambiguous → wrong candidate
    if (want != null && norm(node.value) !== want) return null;
    const value: string = node.value;
    const lead = value.length - value.trimStart().length;
    const trail = value.length - value.trimEnd().length;
    patches.push({
      start: node.start + lead,
      end: node.end - trail,
      text: escapeJsxText(e.newText.trim()),
    });
  }
  return patches;
}

function hasOverlappingPatches(patches: Patch[]): boolean {
  const ordered = [...patches].sort((a, b) => a.start - b.start);
  return ordered.some((patch, index) => {
    const previous = ordered[index - 1];
    return previous !== undefined && patch.start < previous.end;
  });
}

const sourceWriteQueues = new Map<string, Promise<void>>();

async function withSourceWriteLock<T>(
  file: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = sourceWriteQueues.get(file) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  sourceWriteQueues.set(file, tail);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (sourceWriteQueues.get(file) === tail) sourceWriteQueues.delete(file);
  }
}

/**
 * Replace a source file atomically only while it still matches the content we
 * parsed. The temporary file lives beside the target, so rename is atomic and
 * a failed/interrupted write cannot leave the source file half-truncated.
 */
async function atomicWriteIfUnchanged(
  file: string,
  expected: string,
  next: string,
): Promise<boolean> {
  if ((await readFile(file, "utf8")) !== expected) return false;

  const info = await stat(file);
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.hogsend-${process.pid}-${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let replaced = false;

  try {
    handle = await open(temporary, "wx", info.mode & 0o7777);
    await handle.writeFile(next, "utf8");
    await handle.chmod(info.mode & 0o7777);
    await handle.sync();
    await handle.close();
    handle = undefined;

    if ((await readFile(file, "utf8")) !== expected) return false;
    await rename(temporary, file);
    replaced = true;
    return true;
  } finally {
    await handle?.close().catch(() => {});
    if (!replaced) await unlink(temporary).catch(() => {});
  }
}

export function createEditHandler(opts: InspectorServerOptions = {}) {
  const root = opts.root ?? process.cwd();

  return async function POST(req: Request): Promise<Response> {
    const guarded = await readGuardedBody<EditPayload>(req);
    if ("res" in guarded) return guarded.res;
    const body = guarded.body;

    const edits = Array.isArray(body.edits) ? body.edits : [];
    if (!edits.length) return json({ ok: true, unchanged: true });

    let candidates: Stamp[] = Array.isArray(body.candidates)
      ? body.candidates
      : [];
    if (
      !candidates.length &&
      typeof body.file === "string" &&
      Number.isFinite(body.line) &&
      Number.isFinite(body.col)
    ) {
      candidates = [
        { file: body.file, line: Number(body.line), col: Number(body.col) },
      ];
    }
    if (!candidates.length) return json({ error: "candidates required" }, 400);

    // Parse each referenced file once, then try candidates NEAREST-first; the
    // first whose element owns text runs matching the edits wins.
    const files = new Map<string, { content: string; ast: Node } | null>();
    for (const cand of candidates) {
      const abs = resolveInRoot(root, cand.file);
      if (!abs) continue;
      if (!files.has(abs)) {
        if (!existsSync(abs)) {
          files.set(abs, null);
        } else {
          const content = await readFile(abs, "utf8");
          try {
            const ast = parser.parse(content, {
              sourceType: "module",
              plugins: ["jsx", "typescript"],
            });
            files.set(abs, { content, ast });
          } catch {
            files.set(abs, null);
          }
        }
      }
      const entry = files.get(abs);
      if (!entry) continue;

      const patches = matchCandidate(entry.ast, cand.line, cand.col, edits);
      if (!patches) continue;
      if (hasOverlappingPatches(patches)) {
        return json({ ok: false, reason: "overlapping text edits" }, 409);
      }

      if (body.dryRun) {
        return json({
          ok: true,
          dryRun: true,
          file: cand.file,
          edits: patches.length,
        });
      }

      return withSourceWriteLock(abs, async () => {
        if (!existsSync(abs)) {
          return json({ ok: false, reason: "source file changed" }, 409);
        }
        const current = await readFile(abs, "utf8");
        let currentAst: Node;
        try {
          currentAst = parser.parse(current, {
            sourceType: "module",
            plugins: ["jsx", "typescript"],
          });
        } catch {
          return json({ ok: false, reason: "source file changed" }, 409);
        }
        const currentPatches = matchCandidate(
          currentAst,
          cand.line,
          cand.col,
          edits,
        );
        if (!currentPatches) {
          return json({ ok: false, reason: "source file changed" }, 409);
        }
        if (hasOverlappingPatches(currentPatches)) {
          return json({ ok: false, reason: "overlapping text edits" }, 409);
        }

        currentPatches.sort((a, b) => b.start - a.start);
        let next = current;
        for (const patch of currentPatches) {
          next =
            next.slice(0, patch.start) + patch.text + next.slice(patch.end);
        }
        try {
          parser.parse(next, {
            sourceType: "module",
            plugins: ["jsx", "typescript"],
          });
        } catch {
          return json(
            { ok: false, reason: "edit produced invalid source" },
            409,
          );
        }
        if (!(await atomicWriteIfUnchanged(abs, current, next))) {
          return json({ ok: false, reason: "source file changed" }, 409);
        }
        return json({
          ok: true,
          file: cand.file,
          edits: currentPatches.length,
        });
      });
    }

    return json({ ok: false, reason: "no matching source element" }, 409);
  };
}

// ── Tailwind/static className editing ───────────────────────────────────────

type StylePayload = {
  action?: unknown;
  target?: unknown;
  expectedClassName?: unknown;
  className?: unknown;
  dryRun?: unknown;
};

type StaticClassName = {
  className: string;
  literalStart: number;
  literalEnd: number;
  quote: '"' | "'";
};

const MAX_CLASS_NAME_LENGTH = 20_000;

function isStamp(value: unknown): value is Stamp {
  if (!value || typeof value !== "object") return false;
  const stamp = value as Partial<Stamp>;
  return (
    typeof stamp.file === "string" &&
    stamp.file.length > 0 &&
    Number.isInteger(stamp.line) &&
    Number(stamp.line) > 0 &&
    Number.isInteger(stamp.col) &&
    Number(stamp.col) > 0
  );
}

function findStaticClassName(
  ast: Node,
  source: string,
  line: number,
  col: number,
): StaticClassName | null {
  const el = findElementAt(ast, line, col);
  const attributes: Node[] = el?.openingElement?.attributes ?? [];
  const attr = attributes.find(
    (candidate: Node) =>
      candidate.type === "JSXAttribute" &&
      candidate.name?.type === "JSXIdentifier" &&
      candidate.name.name === "className",
  );
  if (
    !attr ||
    attr.value?.type !== "StringLiteral" ||
    !Number.isInteger(attr.value.start) ||
    !Number.isInteger(attr.value.end)
  ) {
    return null;
  }

  const start = Number(attr.value.start);
  const end = Number(attr.value.end);
  const quote = source[start];
  if (
    (quote !== '"' && quote !== "'") ||
    source[end - 1] !== quote ||
    end - start < 2
  ) {
    return null;
  }

  return {
    className: attr.value.value,
    literalStart: start,
    literalEnd: end,
    quote,
  };
}

function renderJsxStringLiteral(
  value: string,
  preferredQuote: '"' | "'",
): string | null {
  const alternateQuote = preferredQuote === '"' ? "'" : '"';
  if (!value.includes(preferredQuote)) {
    return `${preferredQuote}${value}${preferredQuote}`;
  }
  if (!value.includes(alternateQuote)) {
    return `${alternateQuote}${value}${alternateQuote}`;
  }
  return null;
}

type StyleSource =
  | { ok: true; content: string; match: StaticClassName }
  | { ok: false; reason: string };

async function readStyleSource(
  absoluteFile: string,
  target: Stamp,
): Promise<StyleSource> {
  if (!existsSync(absoluteFile)) {
    return { ok: false, reason: "source file not found" };
  }

  const content = await readFile(absoluteFile, "utf8");
  let ast: Node;
  try {
    ast = parser.parse(content, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
    });
  } catch {
    return { ok: false, reason: "source could not be parsed" };
  }
  const match = findStaticClassName(ast, content, target.line, target.col);
  return match
    ? { ok: true, content, match }
    : { ok: false, reason: "no static className found" };
}

/**
 * Read or write a direct static JSX `className="..."` by an exact source
 * stamp. The browser deliberately sends ONE target: unlike text editing, class
 * editing must never fall through the Fiber ancestry and silently mutate a
 * wrapper that merely happens to have a static class list.
 */
export function createStyleHandler(opts: InspectorServerOptions = {}) {
  const root = path.resolve(opts.root ?? process.cwd());

  return async function POST(req: Request): Promise<Response> {
    const guarded = await readGuardedBody<StylePayload | null>(req);
    if ("res" in guarded) return guarded.res;
    const body = guarded.body;

    if (!body || typeof body !== "object") {
      return json({ error: "invalid body" }, 400);
    }
    if (body.action !== "inspect" && body.action !== "write") {
      return json({ error: "invalid action" }, 400);
    }
    if (!isStamp(body.target)) {
      return json({ error: "target required" }, 400);
    }
    const target = body.target;
    const abs = resolveInRoot(root, target.file);
    if (!abs) return json({ error: "path not allowed" }, 403);

    if (body.action === "inspect") {
      const source = await readStyleSource(abs, target);
      if (!source.ok) {
        return json({ ok: false, reason: source.reason }, 409);
      }
      return json({
        ok: true,
        target,
        className: source.match.className,
      });
    }
    if (
      typeof body.expectedClassName !== "string" ||
      typeof body.className !== "string" ||
      body.className.length > MAX_CLASS_NAME_LENGTH ||
      body.className.includes("\0")
    ) {
      return json({ error: "className values required" }, 400);
    }
    const expectedClassName = body.expectedClassName;
    const className = body.className;

    return withSourceWriteLock(abs, async () => {
      const source = await readStyleSource(abs, target);
      if (!source.ok) {
        return json({ ok: false, reason: source.reason }, 409);
      }
      const { content, match } = source;
      if (match.className !== expectedClassName) {
        return json(
          {
            ok: false,
            reason: "class list changed",
            className: match.className,
          },
          409,
        );
      }
      if (match.className === className) {
        return json({
          ok: true,
          unchanged: true,
          target,
          className: match.className,
        });
      }
      const literal = renderJsxStringLiteral(className, match.quote);
      if (!literal) {
        return json(
          {
            error:
              "className contains both quote delimiters; open the source editor for this value",
          },
          400,
        );
      }
      const next =
        content.slice(0, match.literalStart) +
        literal +
        content.slice(match.literalEnd);
      let nextAst: Node;
      try {
        nextAst = parser.parse(next, {
          sourceType: "module",
          plugins: ["jsx", "typescript"],
        });
      } catch {
        return json(
          {
            error:
              "className does not round-trip as a static JSX string; open the source editor for this value",
          },
          400,
        );
      }
      const nextMatch = findStaticClassName(
        nextAst,
        next,
        target.line,
        target.col,
      );
      if (nextMatch?.className !== className) {
        return json(
          {
            error:
              "className does not round-trip as a static JSX string; open the source editor for this value",
          },
          400,
        );
      }
      if (body.dryRun) {
        return json({
          ok: true,
          dryRun: true,
          target,
          className,
        });
      }
      if (!(await atomicWriteIfUnchanged(abs, content, next))) {
        return json({ ok: false, reason: "source file changed" }, 409);
      }
      return json({ ok: true, target, className });
    });
  };
}
