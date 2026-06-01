import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { color } from "../lib/output.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend patch <package> [--cwd <dir>]

Thin wrapper over pnpm's native patch flow. Runs \`pnpm patch <package>\`, which
extracts the package into a temp dir and prints the path to edit. After editing,
commit the patch with the command pnpm prints (\`pnpm patch-commit <dir>\`).

This does NOT replace scripts/patch-check.sh (the patch re-apply contract).

Options:
  --cwd <dir>    Project root to run pnpm in (defaults to current directory).
  -h, --help     Show this help.`;

async function run(ctx: CommandContext): Promise<void> {
  const { values, positionals } = parseArgs({
    args: ctx.argv,
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    ctx.out.log(usage);
    return;
  }

  const pkg = positionals[0];
  if (!pkg) {
    ctx.out.fail(
      "patch requires a package name, e.g. hogsend patch @hogsend/engine",
    );
  }

  const cwd = values.cwd ?? process.cwd();

  // pnpm patch is interactive-ish (prints an editable dir). Stream it through
  // unless --json, where we suppress chrome and report the spawn result only.
  const result = spawnSync("pnpm", ["patch", pkg], {
    cwd,
    stdio: ctx.json ? "ignore" : "inherit",
  });

  if (ctx.json) {
    ctx.out.json({
      package: pkg,
      command: `pnpm patch ${pkg}`,
      status: result.status,
      ok: result.status === 0,
    });
    if (result.status !== 0) process.exit(1);
    return;
  }

  if (result.status !== 0) {
    ctx.out.fail(`pnpm patch ${pkg} exited with code ${result.status ?? "?"}`);
  }

  ctx.out.note(
    [
      "pnpm extracted the package to a temp dir (printed above).",
      "Edit the files, then commit the patch:",
      "",
      color.cyan("pnpm patch-commit <dir>"),
    ].join("\n"),
    "Next steps",
  );
}

export const patchCommand: Command = {
  name: "patch",
  summary: "Patch a package via pnpm's native patch flow",
  usage,
  run,
};
