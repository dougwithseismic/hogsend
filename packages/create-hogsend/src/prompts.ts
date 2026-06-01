import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

export interface CliOptions {
  appName: string;
  packageManager: PackageManager;
  install: boolean;
  git: boolean;
  /** TEST-ONLY: resolve `@hogsend/*` from `file:` tarballs in this dir. */
  useTarballs?: string;
}

const VALID_PMS: PackageManager[] = ["pnpm", "npm", "yarn", "bun"];

export const USAGE = `
create-hogsend — scaffold a Hogsend lifecycle orchestration app.

Usage:
  pnpm dlx create-hogsend <app-name> [options]

Options:
  --pm <pnpm|npm|yarn|bun>   Package manager (default: pnpm)
  --no-install               Skip dependency install
  --no-git                   Skip git init + initial commit
  --use-tarballs <dir>       TEST-ONLY: resolve @hogsend/* from local tarballs
  -h, --help                 Show this help
`.trim();

function isPackageManager(value: string): value is PackageManager {
  return (VALID_PMS as string[]).includes(value);
}

interface RawArgs {
  values: {
    pm?: string;
    "no-install"?: boolean;
    "no-git"?: boolean;
    "use-tarballs"?: string;
    help?: boolean;
  };
  positionals: string[];
}

function parse(argv: string[]): RawArgs {
  // `node:util` parseArgs has no built-in `--no-x` negation, so the skip flags
  // are declared as explicit `no-install` / `no-git` booleans.
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      pm: { type: "string" },
      "no-install": { type: "boolean", default: false },
      "no-git": { type: "boolean", default: false },
      "use-tarballs": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
}

/**
 * Resolve CLI options from argv, prompting for any missing required values when
 * attached to a TTY. Throws on invalid input or when required values are missing
 * in a non-interactive context.
 */
export async function resolveOptions(argv: string[]): Promise<CliOptions> {
  const { values, positionals } = parse(argv);

  if (values.help) {
    stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  let appName = positionals[0];
  let packageManager: PackageManager = "pnpm";

  if (values.pm !== undefined) {
    if (!isPackageManager(values.pm)) {
      throw new Error(
        `Invalid --pm "${values.pm}". Expected one of: ${VALID_PMS.join(", ")}.`,
      );
    }
    packageManager = values.pm;
  }

  if (!appName) {
    if (!stdin.isTTY) {
      throw new Error(`Missing app name.\n\n${USAGE}`);
    }
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      appName = (await rl.question("Project name: ")).trim();
      if (values.pm === undefined) {
        const answer = (await rl.question("Package manager [pnpm]: ")).trim();
        if (answer) {
          if (!isPackageManager(answer)) {
            throw new Error(
              `Invalid package manager "${answer}". Expected one of: ${VALID_PMS.join(", ")}.`,
            );
          }
          packageManager = answer;
        }
      }
    } finally {
      rl.close();
    }
  }

  if (!appName) {
    throw new Error(`App name is required.\n\n${USAGE}`);
  }

  // Keep names filesystem- and npm-friendly.
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(appName)) {
    throw new Error(
      `Invalid app name "${appName}". Use lowercase letters, digits, "-", "_", ".".`,
    );
  }

  return {
    appName,
    packageManager,
    install: !values["no-install"],
    git: !values["no-git"],
    useTarballs: values["use-tarballs"],
  };
}
