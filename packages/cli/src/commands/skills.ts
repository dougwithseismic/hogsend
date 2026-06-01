import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { multiselect } from "@clack/prompts";
import { color } from "../lib/output.js";
import { bail } from "../lib/prompt.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend skills <subcommand> [options]

Manage the Claude Code skills bundled with @hogsend/cli. Bundled skills teach
agents how to drive the hogsend CLI; \`add\` copies them into your project's
./.claude/skills/<name>/ so Claude Code can discover them.

Subcommands:
  list                      List bundled skills + whether each is installed.
  add [name] [--force]      Copy a bundled skill into ./.claude/skills/<name>/.
                            Omit name for an interactive multiselect (human),
                            or copy all bundled skills (--json / non-interactive).

Options:
  --force        Overwrite an already-installed skill.
  --json         Emit machine-readable JSON only (implies non-interactive).
  -h, --help     Show this help.

Examples:
  hogsend skills list
  hogsend skills list --json
  hogsend skills add
  hogsend skills add hogsend-cli --force`;

/**
 * Resolve the directory holding the bundled skills shipped in the tarball.
 * At runtime bin.js lives at <pkg>/dist/bin.js, so the skills dir (shipped via
 * package.json files[]) is one level up at <pkg>/skills.
 */
function bundledSkillsDir(): string {
  return fileURLToPath(new URL("../skills", import.meta.url));
}

/** Target directory for installed skills in the consumer project. */
function installDir(cwd: string): string {
  return join(cwd, ".claude", "skills");
}

interface BundledSkill {
  name: string;
  description: string;
  installed: boolean;
}

/** A single line `key: value` reader for SKILL.md YAML frontmatter. */
function readFrontmatterField(skillDir: string, field: string): string {
  const skillFile = join(skillDir, "SKILL.md");
  if (!existsSync(skillFile)) return "";
  // Tiny frontmatter scan — avoids a YAML dep. Reads only the top block.
  const raw = readFileSyncSafe(skillFile);
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return "";
  const block = fmMatch[1] ?? "";
  for (const line of block.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m && m[1] === field) {
      return (m[2] ?? "").replace(/^["']|["']$/g, "").trim();
    }
  }
  return "";
}

/** Read a file as utf8, returning "" on any error (never throws). */
function readFileSyncSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Enumerate bundled skills (each is a subdir with a SKILL.md). */
function listBundledSkills(cwd: string): BundledSkill[] {
  const dir = bundledSkillsDir();
  if (!existsSync(dir)) return [];
  const target = installDir(cwd);
  const entries = readdirSync(dir).filter((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() && existsSync(join(full, "SKILL.md"));
  });
  return entries.sort().map((name) => ({
    name,
    description: readFrontmatterField(join(dir, name), "description"),
    installed: existsSync(join(target, name)),
  }));
}

function runList(ctx: CommandContext): void {
  const skills = listBundledSkills(process.cwd());

  if (ctx.json) {
    ctx.out.json({
      bundledSkillsDir: bundledSkillsDir(),
      installDir: installDir(process.cwd()),
      skills,
    });
    return;
  }

  ctx.out.intro(`${color.bgMagenta(color.black(" hogsend "))} skills`);
  if (skills.length === 0) {
    ctx.out.note(
      "No bundled skills found in this package build.",
      "skills list",
    );
    ctx.out.outro("Nothing to install.");
    return;
  }
  ctx.out.table(
    skills.map((s) => ({
      name: s.name,
      installed: s.installed ? color.green("yes") : color.dim("no"),
      description:
        s.description.length > 60
          ? `${s.description.slice(0, 57)}...`
          : s.description,
    })),
    ["name", "installed", "description"],
  );
  ctx.out.outro(
    `Install with ${color.cyan("hogsend skills add <name>")} (or just ${color.cyan("hogsend skills add")}).`,
  );
}

interface CopyResult {
  name: string;
  installed: boolean;
  skipped: boolean;
  path: string;
}

/** Copy one bundled skill into the project, honouring --force. */
function copySkill(name: string, cwd: string, force: boolean): CopyResult {
  const src = join(bundledSkillsDir(), name);
  const dest = join(installDir(cwd), name);
  const exists = existsSync(dest);
  if (exists && !force) {
    return { name, installed: false, skipped: true, path: dest };
  }
  mkdirSync(installDir(cwd), { recursive: true });
  cpSync(src, dest, { recursive: true, force: true });
  return { name, installed: true, skipped: false, path: dest };
}

async function runAdd(ctx: CommandContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  const cwd = process.cwd();
  const bundled = listBundledSkills(cwd);
  if (bundled.length === 0) {
    ctx.out.fail("no bundled skills found in this package build");
  }

  const requested = positionals[0];
  const force = Boolean(values.force);

  // Resolve which skills to install.
  let names: string[];
  if (requested) {
    const match = bundled.find((s) => s.name === requested);
    if (!match) {
      ctx.out.fail(
        `unknown skill "${requested}". Available: ${bundled.map((s) => s.name).join(", ")}`,
      );
    }
    names = [requested];
  } else if (ctx.out.interactive) {
    const picked = bail(
      await multiselect({
        message: "Which skills do you want to install?",
        options: bundled.map((s) => ({
          value: s.name,
          label: s.name,
          hint: s.installed ? "installed" : undefined,
        })),
        required: true,
      }),
    ) as string[];
    names = picked;
  } else {
    // Non-interactive (json or non-TTY) with no name => install all.
    names = bundled.map((s) => s.name);
  }

  const results = names.map((name) => copySkill(name, cwd, force));

  if (ctx.json) {
    ctx.out.json({
      installDir: installDir(cwd),
      force,
      results,
    });
    return;
  }

  ctx.out.intro(`${color.bgMagenta(color.black(" hogsend "))} skills add`);
  for (const r of results) {
    if (r.skipped) {
      ctx.out.log(
        `${color.yellow("skip")} ${r.name} ${color.dim("(already installed; use --force to overwrite)")}`,
      );
    } else {
      ctx.out.log(`${color.green("✓")} ${r.name} ${color.dim(`-> ${r.path}`)}`);
    }
  }
  const installedCount = results.filter((r) => r.installed).length;
  const skippedCount = results.filter((r) => r.skipped).length;
  ctx.out.outro(
    `Installed ${installedCount} skill${installedCount === 1 ? "" : "s"}` +
      (skippedCount > 0 ? `, skipped ${skippedCount}.` : "."),
  );
}

async function run(ctx: CommandContext): Promise<void> {
  const sub = ctx.argv[0];

  switch (sub) {
    case "list":
      runList(ctx);
      return;
    case "add":
      await runAdd(ctx, ctx.argv.slice(1));
      return;
    case undefined:
    case "-h":
    case "--help":
      ctx.out.log(usage);
      return;
    default:
      ctx.out.fail(
        `unknown skills subcommand "${sub}". Use: list | add. See hogsend skills --help.`,
      );
  }
}

export const skillsCommand: Command = {
  name: "skills",
  summary: "List + install bundled Claude Code skills into .claude/skills",
  usage,
  run,
};
