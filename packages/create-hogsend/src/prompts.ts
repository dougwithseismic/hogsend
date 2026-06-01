import { stdin, stdout } from "node:process";
import { parseArgs } from "node:util";
import { cancel, confirm, isCancel, select, text } from "@clack/prompts";

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

Run with no app name in a terminal for an interactive setup.
`.trim();

const APP_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

function isPackageManager(value: string): value is PackageManager {
  return (VALID_PMS as string[]).includes(value);
}

function validateAppName(name: string | undefined): string | undefined {
  if (!name) return "Project name is required.";
  if (!APP_NAME_RE.test(name)) {
    return 'Use lowercase letters, digits, "-", "_", "." (start alphanumeric).';
  }
  return undefined;
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

/** Abort cleanly on Ctrl-C / Esc from any clack prompt. */
function bail<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Scaffolding cancelled — nothing was created.");
    process.exit(0);
  }
  return value as T;
}

/**
 * Resolve CLI options. Flags always win; in an interactive terminal, any value
 * not supplied by a flag is prompted for with a clack flow. In a non-interactive
 * context (CI, piped) every required value must come from flags/positionals.
 *
 * NOTE: the clack `intro()` is emitted by the caller (index.ts) before this runs,
 * so these prompts render under the same session rail.
 */
export async function resolveOptions(argv: string[]): Promise<CliOptions> {
  const { values, positionals } = parse(argv);

  if (values.help) {
    stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  // Package manager from flag (validated up front).
  let packageManager: PackageManager | undefined;
  if (values.pm !== undefined) {
    if (!isPackageManager(values.pm)) {
      throw new Error(
        `Invalid --pm "${values.pm}". Expected one of: ${VALID_PMS.join(", ")}.`,
      );
    }
    packageManager = values.pm;
  }

  let appName = positionals[0];
  const interactive = Boolean(stdin.isTTY);

  // Non-interactive (CI / piped): everything must come from flags. No prompts.
  if (!interactive) {
    if (!appName) throw new Error(`Missing app name.\n\n${USAGE}`);
    const err = validateAppName(appName);
    if (err) throw new Error(`Invalid app name "${appName}". ${err}`);
    return {
      appName,
      packageManager: packageManager ?? "pnpm",
      install: !values["no-install"],
      git: !values["no-git"],
      useTarballs: values["use-tarballs"],
    };
  }

  // Interactive: prompt for whatever a flag/positional didn't provide.
  if (appName) {
    const err = validateAppName(appName);
    if (err) throw new Error(`Invalid app name "${appName}". ${err}`);
  } else {
    appName = bail(
      await text({
        message: "Project name?",
        placeholder: "acme-lifecycle",
        validate: validateAppName,
      }),
    );
  }

  if (packageManager === undefined) {
    packageManager = bail(
      await select({
        message: "Package manager?",
        initialValue: "pnpm" as PackageManager,
        options: VALID_PMS.map((pm) => ({ value: pm, label: pm })),
      }),
    );
  }

  const install = values["no-install"]
    ? false
    : bail(
        await confirm({
          message: "Install dependencies now?",
          initialValue: true,
        }),
      );

  const git = values["no-git"]
    ? false
    : bail(
        await confirm({
          message: "Initialize a git repo?",
          initialValue: true,
        }),
      );

  return {
    appName,
    packageManager,
    install,
    git,
    useTarballs: values["use-tarballs"],
  };
}
