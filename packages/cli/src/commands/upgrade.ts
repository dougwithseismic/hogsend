import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { confirm } from "@clack/prompts";
import { color } from "../lib/output.js";
import { bail } from "../lib/prompt.js";
import {
  copySkill,
  installDir,
  listBundledSkills,
  writeSkillsStamp,
} from "../lib/skills.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend upgrade [--cwd <dir>] [--pm <pnpm|npm|yarn|bun>] [options]

Upgrade a scaffolded Hogsend app in one step:
  1. bump every @hogsend/* dependency to latest (or --to <version>), then
  2. refresh the vendored Claude Code skills in ./.claude/skills to match.

Run this after a new engine release so your app AND the agent guidance move
together. Skills are version-stamped so \`hogsend doctor\` can warn when they
fall behind.

Options:
  --cwd <dir>        Project root to upgrade (defaults to the current directory).
  --pm <manager>     Package manager (default: detected from the lockfile, else pnpm).
  --to <version>     Target version for @hogsend/* deps (default: latest).
  --deps-only        Bump dependencies only; don't touch skills.
  --skills-only      Refresh skills only; don't touch dependencies.
  --yes, -y          Skip the confirmation prompt. Implied by --json.
  --json             Run non-interactively and emit a single JSON result.
  -h, --help         Show this help.`;

type Pm = "pnpm" | "npm" | "yarn" | "bun";
const VALID_PMS: Pm[] = ["pnpm", "npm", "yarn", "bun"];

/** Detect the package manager from a lockfile, defaulting to pnpm. */
function detectPm(cwd: string): Pm {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock")))
    return "bun";
  if (existsSync(join(cwd, "package-lock.json"))) return "npm";
  return "pnpm";
}

/** The @hogsend/* deps declared in the app's package.json. */
function hogsendDeps(cwd: string): string[] {
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  return Object.keys(all)
    .filter((n) => n.startsWith("@hogsend/"))
    .sort();
}

/** Build the install verb + args for the given pm (all but npm use `add`). */
function addArgs(pm: Pm, specs: string[]): string[] {
  return [pm === "npm" ? "install" : "add", ...specs];
}

interface StepResult {
  step: string;
  status: "ok" | "skipped" | "failed";
  detail: string;
}

async function run(ctx: CommandContext): Promise<void> {
  const { values } = parseArgs({
    args: ctx.argv,
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
      pm: { type: "string" },
      to: { type: "string" },
      "deps-only": { type: "boolean", default: false },
      "skills-only": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  if (values["deps-only"] && values["skills-only"]) {
    ctx.out.fail("--deps-only and --skills-only are mutually exclusive.");
  }

  const cwd = values.cwd ?? process.cwd();
  if (!existsSync(join(cwd, "package.json"))) {
    ctx.out.fail(
      `no package.json in ${cwd} — run upgrade from a scaffolded Hogsend app (or pass --cwd).`,
    );
  }

  let pm: Pm;
  if (values.pm !== undefined) {
    if (!(VALID_PMS as string[]).includes(values.pm)) {
      ctx.out.fail(
        `invalid --pm "${values.pm}". Expected one of: ${VALID_PMS.join(", ")}.`,
      );
    }
    pm = values.pm as Pm;
  } else {
    pm = detectPm(cwd);
  }

  const target = values.to ?? "latest";
  const doDeps = !values["skills-only"];
  const doSkills = !values["deps-only"];
  const deps = doDeps ? hogsendDeps(cwd) : [];

  if (doDeps && deps.length === 0) {
    ctx.out.fail(
      `no @hogsend/* dependencies found in ${join(cwd, "package.json")}.`,
    );
  }

  const skipConfirm = ctx.json || values.yes;
  if (!ctx.json) {
    ctx.out.intro(
      `${color.bgMagenta(color.black(" hogsend "))} ${color.dim("upgrade")}`,
    );
  }
  if (ctx.out.interactive && !skipConfirm) {
    const plan = [
      doDeps
        ? `bump ${deps.length} @hogsend/* dep(s) to ${target} (${pm})`
        : null,
      doSkills ? "refresh .claude/skills" : null,
    ]
      .filter(Boolean)
      .join(" + ");
    const proceed = bail(
      await confirm({ message: `Upgrade ${color.cyan(cwd)}: ${plan}?` }),
    );
    if (!proceed) {
      ctx.out.outro(color.dim("Nothing changed."));
      return;
    }
  }

  const results: StepResult[] = [];

  // 1. bump @hogsend/* deps via the package manager.
  if (doDeps) {
    const specs = deps.map((n) => `${n}@${target}`);
    const dep = await ctx.out.step(
      `Bumping @hogsend/* -> ${target} (${pm})`,
      async () =>
        spawnSync(pm, addArgs(pm, specs), {
          cwd,
          stdio: ctx.json ? "ignore" : "inherit",
          shell: process.platform === "win32",
        }),
    );
    results.push({
      step: "deps",
      status: dep.status === 0 ? "ok" : "failed",
      detail:
        dep.status === 0
          ? `${deps.join(", ")} -> ${target}`
          : `${pm} exited with code ${dep.status ?? "?"}`,
    });
  } else {
    results.push({ step: "deps", status: "skipped", detail: "--skills-only" });
  }

  // 2. refresh vendored skills + re-stamp (only if deps didn't hard-fail).
  const depsFailed = results.some(
    (r) => r.step === "deps" && r.status === "failed",
  );
  if (!doSkills) {
    results.push({
      step: "skills",
      status: "skipped",
      detail: "--deps-only",
    });
  } else if (depsFailed) {
    results.push({
      step: "skills",
      status: "skipped",
      detail: "skipped — dependency bump failed; fix it then re-run",
    });
  } else {
    const bundled = listBundledSkills(cwd);
    const copied = bundled.map((s) => copySkill(s.name, cwd, true));
    writeSkillsStamp(
      cwd,
      bundled.map((s) => s.name),
    );
    results.push({
      step: "skills",
      status: "ok",
      detail: `refreshed ${copied.length} skill(s) -> ${installDir(cwd)}`,
    });
  }

  const failed = results.filter((r) => r.status === "failed");
  const ok = failed.length === 0;

  if (ctx.json) {
    ctx.out.json({ ok, cwd, pm, target, steps: results });
    if (!ok) process.exit(1);
    return;
  }

  ctx.out.table(
    results.map((r) => ({
      step: r.step,
      status:
        r.status === "ok"
          ? color.green("ok")
          : r.status === "skipped"
            ? color.dim("skipped")
            : color.red("failed"),
      detail: r.detail,
    })),
    ["step", "status", "detail"],
  );

  if (!ok) {
    ctx.out.fail(
      `${failed.length} step(s) failed — see the table above. Fix and re-run hogsend upgrade.`,
    );
  }

  ctx.out.outro(
    `${color.green("Upgraded.")} ${color.dim("Engine + agent skills are on the latest line.")}`,
  );
}

export const upgradeCommand: Command = {
  name: "upgrade",
  summary: "Bump @hogsend/* deps to latest + refresh vendored skills",
  usage,
  run,
};
