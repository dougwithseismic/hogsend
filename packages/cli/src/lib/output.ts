import {
  cancel,
  intro as clackIntro,
  note as clackNote,
  outro as clackOutro,
  spinner,
} from "@clack/prompts";
import color from "picocolors";

/**
 * Unified output sink. Two modes:
 *
 *  - human: TTY clack chrome (intro badge, spinners, notes, outro) + tables.
 *    Falls back to plain console.log lines when stdout is not a TTY.
 *  - json (`--json`): ALL chrome is a no-op; the command emits exactly one
 *    JSON document via `out.json(payload)`. Nothing else touches stdout, so a
 *    --json run is always a single valid JSON document — safe for agents.
 *
 * `interactive` is true only when human mode AND stdout is a TTY; commands key
 * spinner/prompt behaviour off it. `isJson` flips command control flow to the
 * non-interactive branch.
 */
export interface Output {
  /** True when human-mode AND stdout is a TTY (clack chrome is live). */
  readonly interactive: boolean;
  /** True when `--json` was passed. */
  readonly isJson: boolean;
  /** Session intro badge. No-op in json / non-TTY. */
  intro(title: string): void;
  /**
   * Run an async step with a spinner in interactive mode; a plain awaited call
   * otherwise. The label is logged (not spun) when non-interactive & not json.
   */
  step<T>(label: string, fn: () => Promise<T>): Promise<T>;
  /** Boxed note. No-op in json / non-TTY (prints plain lines in non-TTY human). */
  note(body: string, title?: string): void;
  /** Render an array of records as a table (human only; no-op in json). */
  table(rows: Record<string, unknown>[], columns?: string[]): void;
  /** Render a key/value object (human only; no-op in json). */
  kv(obj: Record<string, unknown>, title?: string): void;
  /** Plain human/plain-text line. No-op in json. */
  log(msg: string): void;
  /** Emit the single JSON document. Only meaningful in json mode. */
  json(payload: unknown): void;
  /** Session outro. No-op in json / non-TTY. */
  outro(msg: string): void;
  /**
   * Fail terminally. json: prints `{ "error": message }` to stdout, exit 1.
   * human (TTY): clack cancel(message), exit 1. human (non-TTY): stderr, exit 1.
   */
  fail(message: string): never;
}

function renderTable(
  rows: Record<string, unknown>[],
  columns?: string[],
): string {
  if (rows.length === 0) return color.dim("(no rows)");
  const cols =
    columns ??
    Array.from(
      rows.reduce<Set<string>>((set, row) => {
        for (const key of Object.keys(row)) set.add(key);
        return set;
      }, new Set<string>()),
    );
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  };
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => cell(r[c]).length)),
  );
  const pad = (text: string, width: number) =>
    text + " ".repeat(width - text.length);
  const header = cols
    .map((c, i) => color.bold(pad(c, widths[i] ?? 0)))
    .join("  ");
  const sep = cols.map((_, i) => "-".repeat(widths[i] ?? 0)).join("  ");
  const body = rows
    .map((r) => cols.map((c, i) => pad(cell(r[c]), widths[i] ?? 0)).join("  "))
    .join("\n");
  return `${header}\n${color.dim(sep)}\n${body}`;
}

function renderKv(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) return color.dim("(empty)");
  const width = Math.max(...keys.map((k) => k.length));
  return keys
    .map((k) => {
      const v = obj[k];
      const str =
        v === null || v === undefined
          ? ""
          : typeof v === "object"
            ? JSON.stringify(v)
            : String(v);
      return `${color.dim(`${k}:`.padEnd(width + 1))} ${str}`;
    })
    .join("\n");
}

/** Build an {@link Output} for the given mode. */
export function createOutput(opts: { json: boolean }): Output {
  const isJson = opts.json;
  const interactive = !isJson && Boolean(process.stdout.isTTY);

  return {
    interactive,
    isJson,

    intro(title) {
      if (!interactive) return;
      clackIntro(title);
    },

    async step<T>(label: string, fn: () => Promise<T>): Promise<T> {
      if (interactive) {
        const s = spinner();
        s.start(label);
        try {
          const result = await fn();
          s.stop(`${color.green("✓")} ${label}`);
          return result;
        } catch (err) {
          s.stop(`${color.red("✗")} ${label}`);
          throw err;
        }
      }
      if (!isJson) console.log(`  ${label} ...`);
      return fn();
    },

    note(body, title) {
      if (isJson) return;
      if (interactive) {
        clackNote(body, title);
        return;
      }
      if (title) console.log(`\n${title}`);
      console.log(body);
    },

    table(rows, columns) {
      if (isJson) return;
      console.log(renderTable(rows, columns));
    },

    kv(obj, title) {
      if (isJson) return;
      if (title) console.log(color.bold(title));
      console.log(renderKv(obj));
    },

    log(msg) {
      if (isJson) return;
      console.log(msg);
    },

    json(payload) {
      // Only stdout write in json mode; pretty-printed, single document.
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    },

    outro(msg) {
      if (!interactive) return;
      clackOutro(msg);
    },

    fail(message): never {
      if (isJson) {
        process.stdout.write(`${JSON.stringify({ error: message })}\n`);
      } else if (interactive) {
        cancel(message);
      } else {
        process.stderr.write(`${color.red("error")} ${message}\n`);
      }
      process.exit(1);
    },
  };
}

export { color };
