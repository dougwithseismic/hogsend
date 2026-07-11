/**
 * `hogsend blueprints` — list Journey Blueprints and promote them to code.
 *
 * `promote` is the user-facing half of "promote to code" (spec §11): it pulls
 * a blueprint from the admin API, runs the pure codegen
 * (`lib/blueprint-codegen.ts`) to produce a real `defineJourney()` file,
 * writes it into the consumer app's `src/journeys/` on a fresh git branch,
 * registers it in `src/journeys/index.ts`, and — after an explicit
 * confirmation — calls `POST /v1/admin/blueprints/{id}/promote` to stamp the
 * blueprint promoted + disabled (the generated code becomes the source of
 * truth). Nothing is ever committed or pushed; the user reviews the staged
 * diff themselves.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { cancel, confirm, isCancel, multiselect } from "@clack/prompts";
import {
  type CodegenBlueprintInput,
  camelCase,
  generateJourneyFile,
} from "../lib/blueprint-codegen.js";
import { isHttpError } from "../lib/http.js";
import { color } from "../lib/output.js";
import { bail } from "../lib/prompt.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend blueprints <subcommand> [options]

Journey Blueprints (agent/Studio-authored journeys stored in the DB) — list
them and promote them to code-first defineJourney() files.

Subcommands:
  list                List blueprints with status, trigger, and promotion state.
  promote [id...]     Generate a defineJourney() file per blueprint, register it
                      in src/journeys/index.ts on a NEW git branch, then mark
                      the blueprint promoted (disabled — the generated code
                      becomes the source of truth). Omit ids for an interactive
                      picker over the not-yet-promoted blueprints.

list options:
  --status <s>        Filter by status (draft | enabled | disabled).
  --limit <n>         Page size (default 50).
  --offset <n>        Page offset (default 0).

promote options:
  --cwd <dir>         Consumer app root (default: current directory). Must
                      contain package.json and src/journeys/index.ts.
  --yes, -y           Skip the confirmation prompt (required non-interactively).
  --dry-run           Print the generated file(s) and stop — no git branch, no
                      writes, no promote calls.
  --branch <name>     Branch to create (default: promote-blueprint-<id>, or a
                      timestamped name for a batch).
  --journey-id <id>   Id for the generated journey (meta.id, export name, file
                      name). Only valid when promoting exactly ONE blueprint;
                      defaults to the blueprint id.
  --allow-reenrollment
                      Required alongside --journey-id when the new id differs
                      from the blueprint id: renaming discards the entryLimit
                      "once" history and re-enrolls (re-emails) everyone who
                      already completed the blueprint.

Global options (handled by the router): --url, --admin-key, --json, -h/--help.

Examples:
  hogsend blueprints list
  hogsend blueprints promote                                # interactive picker
  hogsend blueprints promote activation-nudge-blueprint --journey-id activation-nudge
  hogsend blueprints promote bp-a bp-b --dry-run

promote never commits or pushes — review the staged diff, then commit yourself.`;

const badge = `${color.bgMagenta(color.black(" hogsend "))} blueprints`;

// ---------------------------------------------------------------------------
// API response shapes (fields typed as codegen wants them — the generic
// http.get<T> cast is where the Record<string, number> → duration-object
// narrowing happens, per SerializedBlueprint being structurally compatible)
// ---------------------------------------------------------------------------

interface BlueprintListItem {
  id: string;
  name: string;
  status: "draft" | "enabled" | "disabled";
  triggerEvent: string;
  promotedAt: string | null;
  promotedToJourneyId: string | null;
}

interface ListResponse {
  blueprints: BlueprintListItem[];
  total: number;
  limit: number;
  offset: number;
}

/** Detail row (GET /v1/admin/blueprints/{id}) — codegen fields + promotion state. */
interface BlueprintDetail {
  id: string;
  name: string;
  description: string | null;
  status: "draft" | "enabled" | "disabled";
  triggerEvent: string;
  triggerWhere: CodegenBlueprintInput["triggerWhere"];
  entryLimit: CodegenBlueprintInput["entryLimit"];
  entryPeriod: CodegenBlueprintInput["entryPeriod"];
  exitOn: CodegenBlueprintInput["exitOn"];
  suppress: CodegenBlueprintInput["suppress"];
  graph: CodegenBlueprintInput["graph"];
  promotedAt: string | null;
  promotedToJourneyId: string | null;
}

interface ValidationReport {
  valid: boolean;
  issues: Array<{
    nodeId?: string;
    edgeId?: string;
    path: Array<string | number>;
    code: string;
    message: string;
  }>;
}

function toCodegenInput(bp: BlueprintDetail): CodegenBlueprintInput {
  return {
    id: bp.id,
    name: bp.name,
    description: bp.description,
    triggerEvent: bp.triggerEvent,
    triggerWhere: bp.triggerWhere,
    entryLimit: bp.entryLimit,
    entryPeriod: bp.entryPeriod,
    exitOn: bp.exitOn,
    suppress: bp.suppress,
    graph: bp.graph,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** `err instanceof Error ? err.message : String(err)`, named for reuse. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Find the `]` that closes the `[` at `openIdx`, skipping over brackets that
 * appear inside comments or string/template literals — a plain char scan
 * would miscount on a stray `[`/`]` inside a comment (e.g. "see docs] for
 * details") or a string, silently corrupting the file. Returns -1 if
 * unclosed.
 */
function findMatchingBracket(source: string, openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? source.length : nl + 1;
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === ch) {
          j += 1;
          break;
        }
        j += 1;
      }
      i = j;
      continue;
    }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * Register a generated journey in a `src/journeys/index.ts`-shaped source
 * string: append an import after the last existing import statement, add the
 * export name into the `export const journeys = [ ... ]` array literal, and
 * — if present — into a trailing plain re-export block (the create-hogsend
 * template's `export { a, b, c };` "direct reference" line; optional, not
 * every scaffold has one, so a miss there is silent, not an error).
 *
 * Deliberately string-based, not an AST pass — the scaffolded file
 * (create-hogsend template) has a very regular shape. Throws with a clear
 * message when the file doesn't look like that shape (the caller surfaces it
 * and tells the user to register the journey by hand).
 */
export function registerJourneyInIndex(
  source: string,
  journeyId: string,
): string {
  const exportName = camelCase(journeyId);
  const specifier = `./${journeyId}.js`;

  if (source.includes(`"${specifier}"`) || source.includes(`'${specifier}'`)) {
    throw new Error(
      `src/journeys/index.ts already imports "${specifier}" — is ${journeyId} already registered?`,
    );
  }

  // Locate the journeys array literal.
  const open = /export\s+const\s+journeys[^=;]*=\s*\[/.exec(source);
  if (!open) {
    throw new Error(
      "could not find the `export const journeys = [...]` array in src/journeys/index.ts — register the generated journey there yourself",
    );
  }
  const openIdx = open.index + open[0].length - 1; // the '[' itself
  const closeIdx = findMatchingBracket(source, openIdx);
  if (closeIdx === -1) {
    throw new Error(
      "the journeys array in src/journeys/index.ts is never closed — register the generated journey yourself",
    );
  }

  const body = source.slice(openIdx + 1, closeIdx);
  if (new RegExp(`(^|[^\\w$])${exportName}([^\\w$]|$)`).test(body)) {
    throw new Error(
      `"${exportName}" is already listed in the journeys array of src/journeys/index.ts`,
    );
  }

  // 1. Insert the array entry before the closing bracket (later in the file
  // than the imports, so this insertion doesn't shift the import indices we
  // compute afterwards... we insert the entry first for exactly that reason).
  const beforeClose = source.slice(0, closeIdx);
  const trimmedBody = body.trimEnd();
  // A single-line array without a trailing comma needs one before our entry.
  // Tolerates a same-line trailing comment after the comma (e.g. "b, // …")
  // — trimEnd() alone would leave the comment text at the end and wrongly
  // conclude the comma is missing.
  const hasTrailingComma = /,\s*(\/\/[^\n]*)?$/.test(trimmedBody);
  const comma = trimmedBody.length > 0 && !hasTrailingComma ? "," : "";
  const entry = `${comma}${beforeClose.endsWith("\n") ? "" : "\n"}  ${exportName},\n`;
  let result = beforeClose + entry + source.slice(closeIdx);

  // 2. Insert the import right after the last existing import statement.
  const importLine = `import { ${exportName} } from "${specifier}";`;
  let lastImportEnd = -1;
  for (const match of result.matchAll(
    /^import[\s\S]*?from\s*["'][^"']+["'];/gm,
  )) {
    lastImportEnd = match.index + match[0].length;
  }
  result =
    lastImportEnd === -1
      ? `${importLine}\n${result}`
      : `${result.slice(0, lastImportEnd)}\n${importLine}${result.slice(lastImportEnd)}`;

  // 3. Trailing plain re-export block, if any — `export { x } from "...";`
  // (a re-export FROM another module) never matches, since `from` sits
  // between `}` and `;`; only a bare `export { a, b, c };` does.
  result = result.replace(
    /export\s*\{([^}]*)\}\s*;/,
    (_whole, inner: string) => {
      const trimmedInner = inner.trim();
      const sep =
        trimmedInner.length > 0 && !trimmedInner.endsWith(",") ? ", " : "";
      return `export { ${trimmedInner}${sep}${exportName} };`;
    },
  );

  return result;
}

export const JOURNEY_ID_WITH_MULTIPLE =
  "--journey-id is only valid when promoting exactly one blueprint — it names the single generated journey";

/** journeyId doubles as the generated file name — keep it path-safe. */
const JOURNEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The refusal message when --journey-id renames the journey without the ack. */
export function reenrollmentRefusal(
  blueprintId: string,
  journeyId: string,
): string {
  return `--journey-id "${journeyId}" renames the journey away from the blueprint id "${blueprintId}": the blueprint id IS the journey id, so this re-enrolls every user who already completed the blueprint and re-sends their emails. Pass --allow-reenrollment to do this intentionally.`;
}

/**
 * The blueprint id IS the journey id, and that continuity is what lets the
 * entryLimit "once" history survive promotion. A --journey-id that differs from
 * the blueprint id silently breaks it, so it needs --allow-reenrollment. A
 * matching id (the default) needs no acknowledgment. Returns true when the
 * caller must refuse (rename without the ack).
 */
export function reenrollmentNeedsAck(opts: {
  blueprintId: string;
  journeyId: string;
  allowReenrollment: boolean;
}): boolean {
  return opts.journeyId !== opts.blueprintId && !opts.allowReenrollment;
}

export interface PromoteFlags {
  cwd: string;
  yes: boolean;
  dryRun: boolean;
  branch: string | undefined;
  journeyId: string | undefined;
  allowReenrollment: boolean;
  ids: string[];
  help: boolean;
}

/**
 * Parse the argv slice for `blueprints promote`. Positionals are blueprint
 * ids (de-duplicated, order preserved). Throws on invalid combinations —
 * the caller maps the message onto `ctx.out.fail`.
 */
export function parsePromoteArgs(
  argv: string[],
  defaultCwd: string,
): PromoteFlags {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
      yes: { type: "boolean", short: "y", default: false },
      "dry-run": { type: "boolean", default: false },
      branch: { type: "string" },
      "journey-id": { type: "string" },
      "allow-reenrollment": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const ids = [...new Set(positionals)];
  const journeyId = values["journey-id"];
  if (journeyId !== undefined && ids.length > 1) {
    throw new Error(JOURNEY_ID_WITH_MULTIPLE);
  }
  if (journeyId !== undefined && !JOURNEY_ID_RE.test(journeyId)) {
    throw new Error(
      `invalid --journey-id "${journeyId}" — use letters, digits, dots, dashes, underscores (it becomes the file name)`,
    );
  }

  return {
    cwd: values.cwd ?? defaultCwd,
    yes: values.yes ?? false,
    dryRun: values["dry-run"] ?? false,
    branch: values.branch,
    journeyId,
    allowReenrollment: values["allow-reenrollment"] ?? false,
    ids,
    help: values.help ?? false,
  };
}

/** Default branch name: readable for one blueprint, timestamped for a batch. */
export function defaultBranchName(ids: string[], now: Date): string {
  if (ids.length === 1 && ids[0]) {
    return `promote-blueprint-${ids[0]}`;
  }
  // 2026-07-11T14-30-05 — unique enough per run, valid as a git ref.
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, "-");
  return `promote-blueprints-${ids.length}-${stamp}`;
}

// ---------------------------------------------------------------------------
// git (thin spawnSync wrapper — no git library in this repo, by design)
// ---------------------------------------------------------------------------

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string): GitResult {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.error) {
    return { ok: false, stdout: "", stderr: res.error.message };
  }
  return {
    ok: res.status === 0,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

/**
 * Undo the promotion branch's write phase and switch back — used when the
 * user declines or cancels at the final confirm. Safe to run unconditionally
 * here: the working tree was verified clean before this branch was created
 * (git preflight), so `reset --hard HEAD` only ever discards what THIS
 * invocation just wrote/staged on it, never pre-existing work. Plain
 * `git checkout <originalBranch>` alone does NOT do this — new/modified
 * files staged on the promotion branch carry across a bare checkout onto
 * whatever branch you switch to next, which is exactly the bug this fixes.
 */
function discardPromotionBranch(
  cwd: string,
  originalBranch: string,
  branch: string,
): void {
  git(["reset", "--hard", "HEAD"], cwd);
  git(["checkout", originalBranch], cwd);
  git(["branch", "-D", branch], cwd);
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function statusLabel(status: BlueprintListItem["status"]): string {
  switch (status) {
    case "enabled":
      return color.green(status);
    case "disabled":
      return color.yellow(status);
    default:
      return color.dim(status);
  }
}

async function runList(ctx: CommandContext, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      status: { type: "string" },
      limit: { type: "string" },
      offset: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  if (
    values.status !== undefined &&
    !["draft", "enabled", "disabled"].includes(values.status)
  ) {
    ctx.out.fail("--status must be 'draft', 'enabled', or 'disabled'");
  }

  if (!ctx.json) ctx.out.intro(badge);

  const data = await ctx.out.step("Fetching blueprints", () =>
    ctx.http.get<ListResponse>("/v1/admin/blueprints", {
      status: values.status,
      limit: values.limit,
      offset: values.offset,
    }),
  );

  if (ctx.json) {
    ctx.out.json(data);
    return;
  }

  if (data.blueprints.length === 0) {
    ctx.out.note("No blueprints matched.", "Blueprints");
  } else {
    ctx.out.table(
      data.blueprints.map((b) => ({
        id: b.id,
        name: b.name,
        status: statusLabel(b.status),
        trigger: b.triggerEvent,
        promoted: b.promotedAt
          ? `${b.promotedAt.slice(0, 10)} → ${b.promotedToJourneyId}`
          : "—",
      })),
      ["id", "name", "status", "trigger", "promoted"],
    );
  }

  ctx.out.outro(
    `${data.blueprints.length} of ${data.total} blueprint(s) — offset ${data.offset}, limit ${data.limit}`,
  );
}

// ---------------------------------------------------------------------------
// promote
// ---------------------------------------------------------------------------

interface GeneratedJourney {
  /** Blueprint id. */
  id: string;
  /** The generated code journey's id (meta.id / file base / export base). */
  journeyId: string;
  fileName: string;
  source: string;
}

interface SkippedBlueprint {
  id: string;
  reason: string;
}

/** Fetch every blueprint across all pages — the server paginates (default/max page size), so a single unparameterized call can silently hide real candidates beyond page one. */
async function fetchAllBlueprints(
  ctx: CommandContext,
): Promise<BlueprintListItem[]> {
  const pageSize = 100;
  const all: BlueprintListItem[] = [];
  let offset = 0;
  for (;;) {
    const page = await ctx.http.get<ListResponse>("/v1/admin/blueprints", {
      limit: pageSize,
      offset,
    });
    all.push(...page.blueprints);
    offset += page.blueprints.length;
    if (page.blueprints.length === 0 || all.length >= page.total) break;
  }
  return all;
}

/** The two "nothing survived to codegen" exits (no candidates / all skipped) share this shape. */
function reportNothingToPromote(
  ctx: CommandContext,
  skipped: SkippedBlueprint[],
  noteBody: string,
  outroMessage: string,
  dryRun: boolean,
): void {
  if (ctx.json) {
    ctx.out.json({
      promoted: [],
      skipped,
      dryRun,
      message: "nothing to promote",
    });
    return;
  }
  ctx.out.note(noteBody, "Nothing to promote");
  ctx.out.outro(outroMessage);
}

async function runPromote(ctx: CommandContext, argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    ctx.out.log(usage);
    return;
  }

  let flags: PromoteFlags;
  try {
    flags = parsePromoteArgs(argv, process.cwd());
  } catch (err) {
    ctx.out.fail(errorMessage(err));
  }

  // 1. Does this look like a scaffolded Hogsend app?
  const cwd = flags.cwd;
  if (!existsSync(join(cwd, "package.json"))) {
    ctx.out.fail(
      `no package.json in ${cwd} — run promote from a scaffolded Hogsend app (or pass --cwd).`,
    );
  }
  const indexPath = join(cwd, "src", "journeys", "index.ts");
  if (!existsSync(indexPath)) {
    ctx.out.fail(
      `this doesn't look like a scaffolded Hogsend app — no src/journeys/index.ts at ${cwd}. Pass --cwd or run this from your app root.`,
    );
  }

  if (!ctx.json) ctx.out.intro(badge);

  // Promotion needs explicit consent. Fail BEFORE any git/file mutation when
  // no prompt can ever be shown (non-TTY / --json) and --yes wasn't passed.
  if (!flags.dryRun && !flags.yes && !ctx.out.interactive) {
    ctx.out.fail(
      "not running interactively — pass --yes to confirm promotion (or --dry-run to preview).",
    );
  }

  // 2. Git preflight — only a real run touches git at all.
  let originalBranch = "";
  if (!flags.dryRun) {
    const inside = git(["rev-parse", "--is-inside-work-tree"], cwd);
    if (!inside.ok) {
      ctx.out.fail(
        `${cwd} is not a git repository — promote writes files on a new branch. ${inside.stderr.trim()}`,
      );
    }
    const status = git(["status", "--porcelain"], cwd);
    if (!status.ok) {
      ctx.out.fail(`git status failed: ${status.stderr.trim()}`);
    }
    if (status.stdout.trim().length > 0) {
      ctx.out.fail(
        "the working tree is not clean — commit or stash your changes first.",
      );
    }
    originalBranch =
      git(["rev-parse", "--abbrev-ref", "HEAD"], cwd).stdout.trim() || "main";
  }

  // 3. Resolve target blueprint ids.
  let ids = flags.ids;
  if (ids.length === 0) {
    const allBlueprints = await ctx.out.step("Fetching blueprints", () =>
      fetchAllBlueprints(ctx),
    );
    const candidates = allBlueprints.filter((b) => b.promotedAt === null);
    if (candidates.length === 0) {
      reportNothingToPromote(
        ctx,
        [],
        "Every blueprint is already promoted (or none exist yet).",
        "Nothing to promote.",
        flags.dryRun,
      );
      return;
    }
    if (!ctx.out.interactive) {
      ctx.out.fail(
        "no blueprint ids given and not running interactively — pass one or more ids.",
      );
    }
    ids = bail(
      await multiselect({
        message: "Which blueprints do you want to promote to code?",
        options: candidates.map((b) => ({
          value: b.id,
          label: `${b.id} (${b.status})`,
          hint: b.name,
        })),
        required: true,
      }),
    ) as string[];
    if (flags.journeyId !== undefined && ids.length > 1) {
      ctx.out.fail(JOURNEY_ID_WITH_MULTIPLE);
    }
  }

  // A --journey-id that renames the journey away from the blueprint id discards
  // the entryLimit "once" history (the blueprint id IS the journey id) — refuse
  // unless the operator explicitly acknowledges the re-enrollment. --journey-id
  // is single-blueprint only, so ids[0] is the one being renamed.
  if (
    flags.journeyId !== undefined &&
    ids[0] &&
    reenrollmentNeedsAck({
      blueprintId: ids[0],
      journeyId: flags.journeyId,
      allowReenrollment: flags.allowReenrollment,
    })
  ) {
    ctx.out.fail(reenrollmentRefusal(ids[0], flags.journeyId));
  }

  // 4. Fetch → guard → validate → codegen, sequentially per blueprint.
  const generated: GeneratedJourney[] = [];
  const skipped: SkippedBlueprint[] = [];
  const skip = (id: string, reason: string): void => {
    skipped.push({ id, reason });
    ctx.out.log(`${color.yellow("skip")} ${id} — ${reason}`);
  };

  for (const id of ids) {
    let bp: BlueprintDetail;
    try {
      const res = await ctx.out.step(`Fetching blueprint ${id}`, () =>
        ctx.http.get<{ blueprint: BlueprintDetail }>(
          `/v1/admin/blueprints/${encodeURIComponent(id)}`,
        ),
      );
      bp = res.blueprint;
    } catch (err) {
      if (isHttpError(err) && err.status === 404) {
        skip(id, "not found");
        continue;
      }
      throw err;
    }

    if (bp.promotedAt !== null) {
      skip(
        id,
        `already promoted to ${bp.promotedToJourneyId} on ${bp.promotedAt.slice(0, 10)}`,
      );
      continue;
    }

    let report: ValidationReport;
    try {
      report = await ctx.out.step(`Validating ${id}`, () =>
        ctx.http.post<ValidationReport>(
          `/v1/admin/blueprints/${encodeURIComponent(id)}/validate`,
          {},
        ),
      );
    } catch (err) {
      // Skip, don't abort the batch — matches every other per-blueprint
      // failure mode in this loop (404, already-promoted, codegen throw).
      skip(id, `validation request failed: ${errorMessage(err)}`);
      continue;
    }
    if (!report.valid) {
      for (const issue of report.issues) {
        ctx.out.log(
          `  ${color.red("✗")} [${issue.code}] ${issue.message}${issue.nodeId ? color.dim(` (node ${issue.nodeId})`) : ""}`,
        );
      }
      skip(
        id,
        `stored graph failed validation (${report.issues.length} issue(s))`,
      );
      continue;
    }

    const journeyId = flags.journeyId ?? id;
    if (!JOURNEY_ID_RE.test(journeyId)) {
      skip(
        id,
        `blueprint id is not a safe file name — re-run with --journey-id <id>`,
      );
      continue;
    }
    try {
      const source = generateJourneyFile(toCodegenInput(bp), { journeyId });
      generated.push({
        id,
        journeyId,
        fileName: `${journeyId}.ts`,
        source,
      });
    } catch (err) {
      skip(id, `codegen failed: ${errorMessage(err)}`);
    }
  }

  // 5. Nothing survived — summarize and stop.
  if (generated.length === 0) {
    reportNothingToPromote(
      ctx,
      skipped,
      skipped.map((s) => `${s.id}: ${s.reason}`).join("\n") || "(nothing)",
      "No blueprint was promoted; nothing was written.",
      flags.dryRun,
    );
    return;
  }

  // 6. Dry run — print what would happen, touch nothing.
  if (flags.dryRun) {
    if (ctx.json) {
      ctx.out.json({
        dryRun: true,
        generated: generated.map(({ id, journeyId, fileName, source }) => ({
          id,
          journeyId,
          fileName,
          source,
        })),
        skipped,
      });
      return;
    }
    for (const g of generated) {
      ctx.out.log("");
      ctx.out.log(
        color.bold(
          `── would write src/journeys/${g.fileName} ${"─".repeat(20)}`,
        ),
      );
      ctx.out.log(g.source);
    }
    ctx.out.log(
      color.dim(
        `would also register ${generated.length} journey(s) in src/journeys/index.ts, ` +
          "create a branch, and mark the blueprint(s) promoted.",
      ),
    );
    ctx.out.outro("Dry run — nothing was written or promoted.");
    return;
  }

  // 7. Write phase. Compute everything fallible FIRST (index insertion, file
  // collisions), so a failure never leaves a half-written branch behind.
  const indexBefore = readFileSync(indexPath, "utf8");
  let indexAfter = indexBefore;
  for (const g of generated) {
    if (existsSync(join(cwd, "src", "journeys", g.fileName))) {
      ctx.out.fail(
        `refusing to overwrite existing file src/journeys/${g.fileName} — pass --journey-id to pick a different name, or remove the file first.`,
      );
    }
    try {
      indexAfter = registerJourneyInIndex(indexAfter, g.journeyId);
    } catch (err) {
      ctx.out.fail(`cannot update src/journeys/index.ts: ${errorMessage(err)}`);
    }
  }

  const branch =
    flags.branch ??
    defaultBranchName(
      generated.map((g) => g.journeyId),
      new Date(),
    );
  const checkout = git(["checkout", "-b", branch], cwd);
  if (!checkout.ok) {
    ctx.out.fail(`git checkout -b ${branch} failed: ${checkout.stderr.trim()}`);
  }

  // From here on, a failure leaves the user ON the new branch with partial
  // writes — every fail message from this point includes the recovery hint.
  const recoveryHint = `you're on branch ${branch}; to discard it: git reset --hard HEAD && git checkout ${originalBranch} && git branch -D ${branch}`;

  const written: string[] = [];
  try {
    for (const g of generated) {
      writeFileSync(join(cwd, "src", "journeys", g.fileName), g.source, "utf8");
      written.push(`src/journeys/${g.fileName}`);
    }
    writeFileSync(indexPath, indexAfter, "utf8");
    written.push("src/journeys/index.ts");
  } catch (err) {
    ctx.out.fail(
      `failed writing generated files: ${errorMessage(err)} (${recoveryHint})`,
    );
  }

  // Formatting is a nicety, not a gate — the generated TS is already valid.
  const fmt = spawnSync(
    "pnpm",
    ["exec", "biome", "format", "--write", ...written],
    {
      cwd,
      encoding: "utf8",
    },
  );
  if (fmt.error || fmt.status !== 0) {
    ctx.out.log(
      color.yellow(
        "warning: `pnpm exec biome format` failed — the generated files are still valid, just unformatted.",
      ),
    );
  }

  const add = git(["add", "-A"], cwd);
  if (!add.ok) {
    ctx.out.fail(`git add -A failed: ${add.stderr.trim()} (${recoveryHint})`);
  }

  // 8. Show the staged diff so the user sees exactly what landed.
  if (!ctx.json) {
    const diff = git(
      ["diff", "--staged", ctx.out.interactive ? "--color" : "--no-color"],
      cwd,
    );
    if (diff.ok && diff.stdout.trim().length > 0) {
      ctx.out.log("");
      ctx.out.log(diff.stdout.trimEnd());
      ctx.out.log("");
    }
  }

  // 9. Confirm before touching the database. The earlier gate (step 1)
  // already guarantees ctx.out.interactive is true whenever !flags.yes.
  // Cancelling (Ctrl-C/Esc) is handled explicitly here rather than via the
  // usual bail() wrapper — bail() calls process.exit(0) immediately, which
  // would skip the branch cleanup below entirely.
  let proceed: boolean;
  if (flags.yes) {
    proceed = true;
  } else {
    const answer = await confirm({
      message: `This will mark ${generated.length} blueprint(s) as promoted and disable them in the database — the generated code becomes the source of truth. Continue?`,
    });
    if (isCancel(answer)) {
      discardPromotionBranch(cwd, originalBranch, branch);
      cancel("Cancelled — the generated files were discarded.");
      process.exit(0);
    }
    proceed = answer;
  }

  if (!proceed) {
    discardPromotionBranch(cwd, originalBranch, branch);
    ctx.out.note(
      `No blueprint was promoted. Branch ${color.cyan(branch)} and its changes were discarded automatically.`,
      "Declined",
    );
    ctx.out.outro("Nothing was promoted.");
    return;
  }

  // 10. Flip each blueprint to promoted. A late failure keeps the git side —
  // the file is fine; only the DB stamp needs retrying.
  const promoted: Array<{ id: string; journeyId: string }> = [];
  const failed: Array<{ id: string; journeyId: string; error: string }> = [];
  for (const g of generated) {
    try {
      await ctx.out.step(`Promoting ${g.id} → ${g.journeyId}`, () =>
        ctx.http.post(
          `/v1/admin/blueprints/${encodeURIComponent(g.id)}/promote`,
          { journeyId: g.journeyId },
        ),
      );
      promoted.push({ id: g.id, journeyId: g.journeyId });
    } catch (err) {
      const message = isHttpError(err) ? err.message : errorMessage(err);
      failed.push({ id: g.id, journeyId: g.journeyId, error: message });
      ctx.out.log(
        `${color.red("✗")} ${g.id} — promote failed (${message}). The generated file is fine; ` +
          `retry the API call: POST /v1/admin/blueprints/${g.id}/promote {"journeyId":"${g.journeyId}"}`,
      );
    }
  }

  // 11. Final summary.
  if (ctx.json) {
    ctx.out.json({ branch, files: written, promoted, failed, skipped });
    if (failed.length > 0) process.exitCode = 1;
    return;
  }

  ctx.out.note(
    [
      `branch:   ${color.cyan(branch)}`,
      `files:    ${written.join(", ")}`,
      `promoted: ${promoted.map((p) => `${p.id} → ${p.journeyId}`).join(", ") || "(none)"}`,
      ...(skipped.length > 0
        ? [
            `skipped:  ${skipped.map((s) => `${s.id} (${s.reason})`).join(", ")}`,
          ]
        : []),
      ...(failed.length > 0
        ? [`failed:   ${failed.map((f) => `${f.id} (${f.error})`).join(", ")}`]
        : []),
      "",
      "Nothing was committed or pushed — review the diff, then commit and push yourself.",
    ].join("\n"),
    "Promote summary",
  );
  if (failed.length > 0) {
    // Not ctx.out.fail() here — it exits immediately (return type `never`),
    // which would make the outro below unreachable. Match the JSON branch's
    // convention instead: a non-zero exit code, but still finish the summary.
    process.exitCode = 1;
    ctx.out.outro(
      `${promoted.length} blueprint(s) promoted, ${failed.length} promote call(s) failed — see above for per-blueprint retry instructions.`,
    );
    return;
  }
  ctx.out.outro(
    `${promoted.length} blueprint(s) promoted. The generated code is now the source of truth.`,
  );
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

async function run(ctx: CommandContext): Promise<void> {
  const sub = ctx.argv[0];
  const rest = ctx.argv.slice(1);

  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    ctx.out.log(usage);
    return;
  }

  try {
    switch (sub) {
      case "list":
        await runList(ctx, rest);
        return;
      case "promote":
        await runPromote(ctx, rest);
        return;
      default:
        ctx.out.fail(
          `unknown blueprints subcommand "${sub}" — expected list | promote`,
        );
    }
  } catch (error) {
    if (isHttpError(error)) {
      ctx.out.fail(error.message);
    }
    throw error;
  }
}

export const blueprintsCommand: Command = {
  name: "blueprints",
  summary: "List Journey Blueprints and promote them to code",
  usage,
  run,
};
