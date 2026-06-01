#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { parseArgs } from "node:util";
import { EjectError, eject } from "./eject.js";

const USAGE = `hogsend — Hogsend project CLI

Usage:
  hogsend eject <package> [--force] [--cwd <dir>]

Commands:
  eject <package>   Copy a @hogsend/* package's source into vendor/<name> and
                    rewrite the consumer dependency to file:./vendor/<name>.
                    Every other dependency keeps upgrading via pnpm up.

Options:
  --force           Overwrite an existing vendor/<name>.
  --cwd <dir>       Consumer repo root (defaults to the current directory).
  -h, --help        Show this help.

After ejecting, run: pnpm install`;

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function fail(message: string): never {
  process.stderr.write(`${RED}error${RESET} ${message}\n`);
  process.exit(1);
}

/**
 * Resolves the on-disk source directory for an installed package from the
 * consumer root. Works for pnpm's `.pnpm` layout and workspace symlinks.
 *
 * Strategy 1 (primary): probe `<consumerRoot>/node_modules/<pkg>/package.json`
 * directly, following the symlink to its real location. This is the common
 * layout and — unlike `require.resolve("<pkg>/package.json")` — is NOT blocked
 * by the package's `exports` map (most packages don't expose `./package.json`).
 *
 * Strategy 2 (fallback): resolve the package's main entry via `createRequire`
 * and walk up to the nearest directory that contains a package.json whose
 * `name` matches.
 */
function resolveSourceDir(pkg: string, consumerRoot: string): string {
  const direct = join(consumerRoot, "node_modules", pkg, "package.json");
  if (existsSync(direct)) {
    // realpath follows pnpm/workspace symlinks to the actual source dir.
    return dirname(realpathSync(direct));
  }

  const require = createRequire(`${consumerRoot}${sep}`);
  try {
    // Resolving the entry point works even when `./package.json` is not an
    // exported subpath; we then walk up to the package root.
    const entry = require.resolve(pkg);
    let dir = dirname(entry);
    while (dir !== dirname(dir)) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        return dir;
      }
      dir = dirname(dir);
    }
  } catch {
    // fall through to the failure below
  }

  fail(
    `cannot resolve ${pkg} from ${consumerRoot}. Is it installed? Run pnpm install first.`,
  );
}

async function runEject(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      force: { type: "boolean", default: false },
      cwd: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const pkg = positionals[0];
  if (!pkg) {
    fail("eject requires a package name, e.g. hogsend eject @hogsend/engine");
  }

  const consumerRoot = values.cwd ?? process.cwd();
  const sourceDir = resolveSourceDir(pkg, consumerRoot);

  try {
    const result = await eject({
      pkg,
      consumerRoot,
      sourceDir,
      force: values.force,
    });
    process.stdout.write(
      `Ejected ${result.pkg}\n` +
        `  copied ${result.copiedFiles} files -> ${result.vendorPath}\n` +
        `  dependency ${result.depSpecBefore} -> ${result.depSpecAfter}\n` +
        `\nNow run: ${result.followUp}\n`,
    );
  } catch (error) {
    if (error instanceof EjectError) {
      fail(error.message);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  switch (command) {
    case "eject":
      await runEject(rest);
      break;
    default:
      fail(`unknown command "${command}"\n\n${USAGE}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${RED}error${RESET} ${String(error)}\n`);
  process.exit(1);
});
