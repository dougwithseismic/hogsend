import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { parseArgs } from "node:util";
import { EjectError, eject } from "../eject.js";
import { color } from "../lib/output.js";
import type { Command, CommandContext } from "./types.js";

const usage = `hogsend eject <package> [--force] [--cwd <dir>]

Copy a @hogsend/* package's source into vendor/<name> and rewrite the consumer
dependency to file:./vendor/<name>. Every other dependency keeps upgrading.

Options:
  --force        Overwrite an existing vendor/<name>.
  --cwd <dir>    Consumer repo root (defaults to the current directory).
  -h, --help     Show this help.

After ejecting, run: pnpm install`;

/**
 * Resolve the on-disk source directory for an installed package. Strategy 1:
 * probe node_modules/<pkg>/package.json (following pnpm/workspace symlinks).
 * Strategy 2: resolve the package entry via createRequire and walk up.
 */
function resolveSourceDir(pkg: string, consumerRoot: string): string | null {
  const direct = join(consumerRoot, "node_modules", pkg, "package.json");
  if (existsSync(direct)) {
    return dirname(realpathSync(direct));
  }
  const require = createRequire(`${consumerRoot}${sep}`);
  try {
    const entry = require.resolve(pkg);
    let dir = dirname(entry);
    while (dir !== dirname(dir)) {
      if (existsSync(join(dir, "package.json"))) return dir;
      dir = dirname(dir);
    }
  } catch {
    // fall through
  }
  return null;
}

async function run(ctx: CommandContext): Promise<void> {
  const { values, positionals } = parseArgs({
    args: ctx.argv,
    allowPositionals: true,
    options: {
      force: { type: "boolean", default: false },
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
      "eject requires a package name, e.g. hogsend eject @hogsend/engine",
    );
  }

  const consumerRoot = values.cwd ?? process.cwd();
  const sourceDir = resolveSourceDir(pkg, consumerRoot);
  if (!sourceDir) {
    ctx.out.fail(
      `cannot resolve ${pkg} from ${consumerRoot}. Is it installed? Run pnpm install first.`,
    );
  }

  try {
    const result = await ctx.out.step(`Ejecting ${pkg}`, () =>
      eject({ pkg, consumerRoot, sourceDir, force: values.force }),
    );
    if (ctx.json) {
      ctx.out.json(result);
      return;
    }
    ctx.out.note(
      [
        `copied ${result.copiedFiles} files -> ${result.vendorPath}`,
        `dependency ${result.depSpecBefore} -> ${color.cyan(result.depSpecAfter)}`,
        "",
        `Now run: ${color.cyan(result.followUp)}`,
      ].join("\n"),
      `Ejected ${result.pkg}`,
    );
  } catch (error) {
    if (error instanceof EjectError) {
      ctx.out.fail(error.message);
    }
    throw error;
  }
}

export const ejectCommand: Command = {
  name: "eject",
  summary: "Vendor a @hogsend/* package into vendor/<name>",
  usage,
  run,
};
