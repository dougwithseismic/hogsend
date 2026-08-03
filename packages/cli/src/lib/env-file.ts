/**
 * Merging values into a `.env` without rewriting it.
 *
 * Pure, and separate from the command, because the thing that can go wrong here
 * is silent and expensive: a dotenv round-trip that parses the file into an
 * object and re-serialises it drops every comment, reorders every key and
 * normalises every quote — an unreviewable diff over a file people keep secrets
 * and notes in. So this never parses-and-reprints. It edits the ONE line an
 * existing key is assigned on and appends the keys that are genuinely new,
 * leaving every other byte of the file exactly where it was.
 *
 * The other rule it owns: an existing DIFFERENT value is a CONFLICT, not an
 * update. Overwriting a key someone is already using is destructive and, since
 * the old value only ever lived in this file, unrecoverable — so the merge
 * reports it and the caller decides (the command refuses without `--force`).
 *
 * SECRET HYGIENE: nothing here returns, logs or embeds a VALUE in a
 * message. `MergeOutcome` names keys only, so a caller cannot accidentally
 * print one.
 */

/** What happened to one key. Never carries the value. */
export type EnvKeyOutcome =
  /** The key was not in the file; it was appended. */
  | "added"
  /** The key was present with an empty (placeholder) value; it was filled in. */
  | "filled"
  /** The key was present with exactly this value; the file is untouched. */
  | "unchanged"
  /** The key was present with a DIFFERENT value. Overwritten only with force. */
  | "conflict";

export interface MergeOutcome {
  /** The file's new text. Identical to the input when nothing changed. */
  content: string;
  /** Per key, in the order the caller asked for them. Values never appear. */
  results: { key: string; outcome: EnvKeyOutcome }[];
  /** Keys that already held a different value. Empty when there is no clash. */
  conflicts: string[];
  /** True when `content` differs from the input. */
  changed: boolean;
}

export interface MergeOptions {
  /** Overwrite a key that already holds a different value. */
  force?: boolean;
  /** Header comment written above a block of appended keys. */
  comment?: string;
}

/**
 * The assignment for `key` on this line, or null.
 *
 * Deliberately strict: a commented-out `# HOGSEND_API_KEY=…` is NOT an
 * assignment (filling it in would silently un-comment a line someone disabled
 * on purpose), and neither is `HOGSEND_API_KEY_OLD=…`. `export FOO=bar` IS one,
 * because a shell-sourced `.env` is a real and common shape.
 */
function assignmentOn(line: string, key: string): { value: string } | null {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(
    line,
  );
  if (!match || match[1] !== key) return null;
  return { value: unquote((match[2] ?? "").trim()) };
}

/**
 * The value as dotenv would read it: surrounding matched quotes removed, and an
 * unquoted trailing `# comment` dropped. Comparing raw text instead would
 * report `KEY="x"` and `KEY=x` as a conflict when they are the same value.
 */
function unquote(raw: string): string {
  const quoted = /^(['"])([\s\S]*)\1\s*$/.exec(raw);
  if (quoted) return quoted[2] ?? "";
  const hash = raw.indexOf(" #");
  return (hash === -1 ? raw : raw.slice(0, hash)).trim();
}

/**
 * Quote only when the value needs it. An unquoted `hsk_…` is what every other
 * tool writes and what a human expects to see, so quoting unconditionally would
 * make the diff noisier than the change.
 */
function render(key: string, value: string): string {
  const needsQuotes = value === "" || /[\s#'"$`\\]/.test(value);
  return needsQuotes
    ? `${key}="${value.replace(/(["\\])/g, "\\$1")}"`
    : `${key}=${value}`;
}

export function mergeEnv(
  existing: string,
  updates: Record<string, string>,
  options: MergeOptions = {},
): MergeOutcome {
  // Splitting on \n and rejoining on \n preserves \r\n too: the \r rides along
  // at the end of each line and is written back untouched.
  const lines = existing.length === 0 ? [] : existing.split("\n");
  const results: MergeOutcome["results"] = [];
  const conflicts: string[] = [];
  const appended: string[] = [];
  let changed = false;

  for (const [key, value] of Object.entries(updates)) {
    // The LAST assignment is the one dotenv-style readers end up with in most
    // loaders' precedence, and it is the one a human reading top-to-bottom
    // believes is in force. Editing an earlier shadowed one would change
    // nothing while looking like it had.
    let index = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (assignmentOn(lines[i] ?? "", key)) {
        index = i;
        break;
      }
    }

    if (index === -1) {
      appended.push(render(key, value));
      results.push({ key, outcome: "added" });
      changed = true;
      continue;
    }

    const current = assignmentOn(lines[index] ?? "", key)?.value ?? "";
    if (current === value) {
      results.push({ key, outcome: "unchanged" });
      continue;
    }
    if (current !== "" && options.force !== true) {
      conflicts.push(key);
      results.push({ key, outcome: "conflict" });
      continue;
    }
    lines[index] = render(key, value);
    results.push({ key, outcome: current === "" ? "filled" : "conflict" });
    changed = true;
  }

  // A refused conflict must leave the file EXACTLY as it was — including the
  // keys that would have been appended, so a half-applied pull is impossible.
  if (conflicts.length > 0) {
    return { content: existing, results, conflicts, changed: false };
  }

  // Nothing to do means nothing to WRITE. Falling through would append a
  // trailing newline to a file that had none, so a no-op pull would still show
  // up as a diff.
  if (!changed) return { content: existing, results, conflicts, changed };

  if (appended.length > 0) {
    const block: string[] = [];
    if (lines.length > 0 && (lines.at(-1) ?? "").trim() !== "") block.push("");
    if (options.comment) block.push(`# ${options.comment}`);
    block.push(...appended);
    lines.push(...block);
  }

  let content = lines.join("\n");
  // A trailing newline, but only added — never removed from a file that has
  // one and never doubled.
  if (content.length > 0 && !content.endsWith("\n")) content += "\n";

  return { content, results, conflicts, changed };
}
