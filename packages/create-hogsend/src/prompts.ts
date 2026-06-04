import { basename } from "node:path";
import { stdin, stdout } from "node:process";
import { parseArgs } from "node:util";
import { cancel, confirm, isCancel, select, text } from "@clack/prompts";

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

export interface CliOptions {
  /** Target directory relative to cwd: "." for the current folder, or a name. */
  dir: string;
  /** Sanitized package/display name (derived from the folder when dir is "."). */
  appName: string;
  packageManager: PackageManager;
  install: boolean;
  git: boolean;
  /** Run `pnpm bootstrap` after install (Docker, .env, Hatchet token, migrate). */
  setup: boolean;
  /** TEST-ONLY: resolve `@hogsend/*` from `file:` tarballs in this dir. */
  useTarballs?: string;
}

const VALID_PMS: PackageManager[] = ["pnpm", "npm", "yarn", "bun"];

export const USAGE = `
create-hogsend — scaffold a Hogsend lifecycle orchestration app.

Usage:
  pnpm dlx create-hogsend <app-name> [options]
  pnpm dlx create-hogsend .            # scaffold into the current folder

Options:
  -y, --yes                  Accept all defaults, no prompts (install + setup)
  --pm <pnpm|npm|yarn|bun>   Package manager (default: pnpm)
  --setup                    Run local setup after install (Docker, .env, migrate)
  --no-setup                 Skip local setup
  --no-install               Skip dependency install
  --no-git                   Skip git init + initial commit
  --use-tarballs <dir>       TEST-ONLY: resolve @hogsend/* from local tarballs
  -h, --help                 Show this help

Run with no app name in a terminal for an interactive setup.
Docs: docs.hogsend.com
`.trim();

const APP_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

function isPackageManager(value: string): value is PackageManager {
  return (VALID_PMS as string[]).includes(value);
}

/** Coerce an arbitrary folder name into a valid npm-ish package name. */
function sanitizeName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "");
  return cleaned || "hogsend-app";
}

function validateAppName(name: string | undefined): string | undefined {
  if (!name) return "Project name is required.";
  if (name === "." || name === "./") return undefined;
  if (!APP_NAME_RE.test(name)) {
    return 'Use lowercase letters, digits, "-", "_", "." (start alphanumeric), or "." for the current folder.';
  }
  return undefined;
}

/** Resolve the target dir + the package name to write into the scaffold. */
function deriveNames(rawDir: string): { dir: string; appName: string } {
  if (rawDir === "." || rawDir === "./") {
    return { dir: ".", appName: sanitizeName(basename(process.cwd())) };
  }
  return { dir: rawDir, appName: rawDir };
}

interface RawArgs {
  values: {
    yes?: boolean;
    pm?: string;
    setup?: boolean;
    "no-setup"?: boolean;
    "no-install"?: boolean;
    "no-git"?: boolean;
    "use-tarballs"?: string;
    help?: boolean;
  };
  positionals: string[];
}

function parse(argv: string[]): RawArgs {
  // `node:util` parseArgs has no built-in `--no-x` negation, so the skip flags
  // are declared as explicit `no-install` / `no-git` / `no-setup` booleans.
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      yes: { type: "boolean", short: "y", default: false },
      pm: { type: "string" },
      setup: { type: "boolean", default: false },
      "no-setup": { type: "boolean", default: false },
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

  let rawDir = positionals[0];
  const interactive = Boolean(stdin.isTTY);
  // Ask nothing when piped/CI (no TTY) or when the user opted into all defaults
  // with --yes. Everything then comes from flags + defaults.
  const skipPrompts = !interactive || values.yes === true;

  if (skipPrompts) {
    if (!rawDir) {
      const why = values.yes
        ? 'With --yes you must pass a name (or "."). '
        : "";
      throw new Error(`Missing app name. ${why}\n${USAGE}`);
    }
    const err = validateAppName(rawDir);
    if (err) throw new Error(`Invalid app name "${rawDir}". ${err}`);
    const { dir, appName } = deriveNames(rawDir);
    const install = !values["no-install"];
    // --yes implies setup; plain CI needs an explicit --setup. Both honour
    // --no-setup, and bootstrap (runs `tsx`) is pointless without an install.
    const wantSetup = values.yes === true || values.setup === true;
    return {
      dir,
      appName,
      packageManager: packageManager ?? "pnpm",
      install,
      git: !values["no-git"],
      setup: wantSetup && !values["no-setup"] && install,
      useTarballs: values["use-tarballs"],
    };
  }

  // Interactive: prompt for whatever a flag/positional didn't provide.
  if (rawDir) {
    const err = validateAppName(rawDir);
    if (err) throw new Error(`Invalid app name "${rawDir}". ${err}`);
  } else {
    rawDir = bail(
      await text({
        message: 'Project name? (or "." for the current folder)',
        placeholder: "acme-lifecycle",
        validate: validateAppName,
      }),
    );
  }
  const { dir, appName } = deriveNames(rawDir);

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

  // Setup needs deps installed first; only offer it when we're installing.
  const setup =
    values["no-setup"] || !install
      ? false
      : values.setup
        ? true
        : bail(
            await confirm({
              message:
                "Set up local infra now? (Docker, .env, Hatchet token, migrate)",
              initialValue: true,
            }),
          );

  return {
    dir,
    appName,
    packageManager,
    install,
    git,
    setup,
    useTarballs: values["use-tarballs"],
  };
}
