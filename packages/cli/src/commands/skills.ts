import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { multiselect } from "@clack/prompts";
import { color } from "../lib/output.js";
import { bail } from "../lib/prompt.js";
import {
  bundledSkillsDir,
  type CopyResult,
  copySkill,
  installDir,
  listBundledSkills,
  writeSkillsStamp,
} from "../lib/skills.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend skills <subcommand> [options]

Manage the Claude Code skills bundled with @hogsend/cli. Bundled skills teach
agents how to drive the hogsend CLI; \`add\` copies them into your project's
./.claude/skills/<name>/ so Claude Code can discover them.

Subcommands:
  list                      List bundled skills + whether each is installed.
  add [name] [--force]      Copy a bundled skill into ./.claude/skills/<name>/.
                            Omit name for an interactive multiselect (human),
                            or copy all bundled skills (--all / --json /
                            non-interactive).

Options:
  --all          Install every bundled skill (skips the interactive picker).
  --force        Overwrite an already-installed skill. Use after upgrading the
                 engine to refresh vendored skills to the latest guidance.
  --json         Emit machine-readable JSON only (implies non-interactive).
  -h, --help     Show this help.

Examples:
  hogsend skills list
  hogsend skills list --json
  hogsend skills add
  hogsend skills add --all
  hogsend skills add hogsend-cli --force
  hogsend skills add --all --force         # refresh everything after an upgrade

Tip: \`hogsend upgrade\` bumps the engine AND refreshes these skills in one step.`;

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
    `Install with ${color.cyan("hogsend skills add <name>")} (or ${color.cyan("hogsend skills add --all")}). ` +
      `Refresh after an engine upgrade with ${color.cyan("--force")}.`,
  );
}

async function runAdd(ctx: CommandContext, argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      all: { type: "boolean", default: false },
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
  } else if (values.all) {
    // Explicit install-all — skip the picker even in a TTY.
    names = bundled.map((s) => s.name);
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

  const results: CopyResult[] = names.map((name) =>
    copySkill(name, cwd, force),
  );

  // Stamp the now-installed set with this CLI's version, so `hogsend doctor`
  // can later tell whether the vendored skills have fallen behind the engine.
  if (results.some((r) => r.installed)) {
    const installedNames = listBundledSkills(cwd)
      .filter((s) => existsSync(join(installDir(cwd), s.name)))
      .map((s) => s.name);
    writeSkillsStamp(cwd, installedNames);
  }

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
