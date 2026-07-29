/**
 * A small, deliberate subset of `.gitignore`, for deciding what `hogsend
 * publish` uploads.
 *
 * WHY NOT A DEPENDENCY, and why not `git ls-files`:
 *  - the CLI is published to npm and its npm dependencies stay EXTERNAL at
 *    runtime (`tsup.config.ts` bundles only the workspace packages), so every
 *    dependency added here is one every consumer installs;
 *  - `git ls-files --exclude-standard` would give exact semantics but would
 *    make publishing depend on a `git` binary AND on the tree being a work
 *    tree. A scaffold published from a CI checkout, an exported directory, or
 *    a template copy is a real case, and "publish works on my machine" is the
 *    failure it produces;
 *  - the control plane's tar READER (`apps/cloud/src/lib/tarball.ts`) is
 *    hand-written for the same reason it states: the rules ARE the module, and
 *    a matcher we can read is worth more than one we can only configure.
 *
 * WHAT IS SUPPORTED: comments (`#`), blank lines, negation (`!`), directory-only
 * patterns (trailing `/`), anchoring (a leading or interior `/`), `*`, `?`,
 * `**`, and character classes (`[abc]`, `[!a-z]`). Per-directory `.gitignore`
 * files compose, with a deeper file's patterns taking precedence over a
 * shallower one's, and within one file the LAST matching pattern winning —
 * which is git's rule.
 *
 * WHAT IS NOT: `.git/info/exclude`, the global core.excludesFile, `.gitattributes`,
 * and escaped literals (`\#`, `\!`). None of them change what a scaffold ships,
 * and each would be a rule with no test behind it.
 *
 * The one thing that does NOT depend on any of this: the hard excludes in
 * `publish-tarball.ts`. A `.gitignore` that un-ignores `.env` (with `!.env`, or
 * by not ignoring it at all) must not be able to put a secret in an upload, so
 * those exclusions are applied BEFORE this matcher is ever consulted and cannot
 * be negated by anything a repository contains.
 */

export interface IgnorePattern {
  /** `!foo` — a match RE-INCLUDES rather than excludes. */
  negated: boolean;
  /** `foo/` — matches directories only. */
  dirOnly: boolean;
  /** The compiled matcher, against a path relative to the pattern's base. */
  regex: RegExp;
  /** The line it came from, for debugging. */
  source: string;
}

/** One `.gitignore`, plus the directory it governs. */
export interface IgnoreScope {
  /** Directory the patterns are relative to, as a "/"-joined relative path. */
  base: string;
  patterns: IgnorePattern[];
}

const REGEX_SPECIALS = /[.+^${}()|\\]/g;

/**
 * Translate one gitignore glob into a regex over a "/"-separated relative path.
 *
 * `anchored` decides the head: an anchored pattern (one containing a `/` other
 * than a trailing one) matches from the base directory; an unanchored one
 * matches a path SEGMENT at any depth, which is why `node_modules` in a root
 * `.gitignore` covers `apps/api/node_modules` too.
 */
function compile(glob: string, anchored: boolean): RegExp {
  let out = "";
  let index = 0;

  while (index < glob.length) {
    const char = glob[index] as string;

    if (char === "*") {
      const isDouble = glob[index + 1] === "*";
      if (isDouble) {
        const before = glob[index - 1];
        const after = glob[index + 2];
        if ((before === undefined || before === "/") && after === "/") {
          // `**/` — zero or more leading directories.
          out += "(?:[^/]+/)*";
          index += 3;
          continue;
        }
        if ((before === undefined || before === "/") && after === undefined) {
          // trailing `**` — everything below here.
          out += ".*";
          index += 2;
          continue;
        }
        // A `**` in any other position degrades to "anything, crossing /".
        out += ".*";
        index += 2;
        continue;
      }
      out += "[^/]*";
      index += 1;
      continue;
    }

    if (char === "?") {
      out += "[^/]";
      index += 1;
      continue;
    }

    if (char === "[") {
      const close = glob.indexOf("]", index + 1);
      if (close === -1) {
        out += "\\[";
        index += 1;
        continue;
      }
      let body = glob.slice(index + 1, close);
      if (body.startsWith("!")) body = `^${body.slice(1)}`;
      out += `[${body}]`;
      index = close + 1;
      continue;
    }

    out += char.replace(REGEX_SPECIALS, "\\$&");
    index += 1;
  }

  // Trailing `/**` already consumed above; anything else must match a whole
  // path OR be a directory prefix of one (git ignores a directory's contents
  // when the directory itself matches).
  const head = anchored ? "^" : "^(?:.*/)?";
  return new RegExp(`${head}${out}(?:/.*)?$`);
}

/** Parse one `.gitignore`'s text into patterns, in file order. */
export function parseIgnoreFile(text: string): IgnorePattern[] {
  const patterns: IgnorePattern[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    // Trailing whitespace is not part of a pattern (unless escaped, which this
    // subset does not support); leading whitespace is.
    const line = rawLine.replace(/\s+$/, "");
    if (line.length === 0 || line.startsWith("#")) continue;

    let body = line;
    const negated = body.startsWith("!");
    if (negated) body = body.slice(1);
    if (body.length === 0) continue;

    const dirOnly = body.endsWith("/");
    if (dirOnly) body = body.slice(0, -1);
    if (body.length === 0) continue;

    // A leading `/` anchors and is not part of the glob; an interior `/`
    // anchors and IS.
    const leadingSlash = body.startsWith("/");
    if (leadingSlash) body = body.slice(1);
    if (body.length === 0) continue;

    const anchored = leadingSlash || body.includes("/");

    patterns.push({
      negated,
      dirOnly,
      regex: compile(body, anchored),
      source: line,
    });
  }

  return patterns;
}

/**
 * Is `relPath` (relative to the walk root, "/"-separated) ignored by `scopes`?
 *
 * Scopes are supplied SHALLOWEST FIRST. Within one scope the last matching
 * pattern wins; across scopes the deepest one wins, which is what iterating in
 * order and keeping the last verdict produces.
 */
export function isIgnored(
  relPath: string,
  isDirectory: boolean,
  scopes: readonly IgnoreScope[],
): boolean {
  let ignored = false;

  for (const scope of scopes) {
    if (scope.base !== "" && !relPath.startsWith(`${scope.base}/`)) continue;
    const local =
      scope.base === "" ? relPath : relPath.slice(scope.base.length + 1);
    if (local.length === 0) continue;

    for (const pattern of scope.patterns) {
      if (pattern.dirOnly && !isDirectory) continue;
      if (!pattern.regex.test(local)) continue;
      ignored = !pattern.negated;
    }
  }

  return ignored;
}
