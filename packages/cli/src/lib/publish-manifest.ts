import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Which directory is the app, and which engine version is it built against.
 *
 * Both answers come from the repository rather than from a flag, because both
 * are facts about the code being shipped and a flag would let them drift from
 * it — and the engine version in particular is what the control plane refuses a
 * mismatched deploy on (`checkEngineVersion`). A version the operator typed
 * would turn that gate into a formality.
 */

/** The dependency that makes a directory a Hogsend app. */
export const ENGINE_PACKAGE = "@hogsend/engine";

export class ScaffoldError extends Error {
  readonly code: "not_a_scaffold" | "no_engine_version";

  constructor(code: ScaffoldError["code"], message: string) {
    super(message);
    this.name = "ScaffoldError";
    this.code = code;
  }
}

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(dir: string): PackageJson | null {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as PackageJson)
      : null;
  } catch {
    return null;
  }
}

function engineRange(pkg: PackageJson): string | undefined {
  return (
    pkg.dependencies?.[ENGINE_PACKAGE] ?? pkg.devDependencies?.[ENGINE_PACKAGE]
  );
}

export interface ScaffoldRoot {
  /** Absolute path to the directory holding the app's package.json. */
  dir: string;
  /** `package.json#name` — the manifest's `appName`. */
  appName: string;
  /** The declared `@hogsend/engine` range, e.g. `^0.57.0`. */
  engineRange: string;
}

/**
 * Walk UP from `start` to the first directory whose `package.json` depends on
 * `@hogsend/engine`.
 *
 * Upward rather than downward because that is how a human uses it: `hogsend
 * publish` typed from `src/journeys/` should publish the app, not fail. It
 * stops at the first match rather than the outermost one, so running it inside
 * an app in a monorepo publishes THAT app and not the workspace root.
 */
export function findScaffoldRoot(start: string = process.cwd()): ScaffoldRoot {
  let dir = resolve(start);

  for (;;) {
    const pkg = readPackageJson(dir);
    const range = pkg ? engineRange(pkg) : undefined;
    if (pkg && range) {
      if (!pkg.name) {
        throw new ScaffoldError(
          "not_a_scaffold",
          `${join(dir, "package.json")} depends on ${ENGINE_PACKAGE} but has no "name". Give the app a name before publishing.`,
        );
      }
      return { dir, appName: pkg.name, engineRange: range };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new ScaffoldError(
    "not_a_scaffold",
    `No Hogsend app found at or above ${resolve(start)} — looked for a package.json depending on ${ENGINE_PACKAGE}. Run this from inside your app, or scaffold one with \`pnpm dlx create-hogsend@latest\`.`,
  );
}

/** Where an engine version was read from — reported so the operator can check. */
export type EngineVersionSource =
  | "pnpm-lock"
  | "package-lock"
  | "yarn-lock"
  | "node_modules"
  | "package.json";

export interface ResolvedEngineVersion {
  version: string;
  source: EngineVersionSource;
}

/**
 * The `@hogsend/engine` version this app is actually built against.
 *
 * Resolution order, and why:
 *  1. **the lockfile** — the EXACT version an install would produce, which is
 *     what the build on the far side will resolve too. This is the answer the
 *     version gate is meant to compare;
 *  2. **`node_modules/@hogsend/engine/package.json`** — the exact version
 *     installed HERE. Right for a repository with no lockfile committed;
 *  3. **the declared range with its operator stripped** — the documented
 *     FALLBACK, and a lossy one: `^0.57.0` resolves to `0.57.0`, which is the
 *     floor of the range rather than what an install would pick. It is the last
 *     resort because it can be WRONG (an install would have taken 0.57.3), and
 *     wrong here is not silent: the control plane compares it against the
 *     stack's recorded version and refuses a disagreement with a 409 naming
 *     both. The operator then either commits a lockfile or passes
 *     `--allow-upgrade` deliberately.
 *
 * A range with no leading digits at all (`workspace:*`, `latest`, a git URL) is
 * not a version and is refused rather than guessed at.
 */
export function resolveEngineVersion(root: string): ResolvedEngineVersion {
  const fromPnpm = fromPnpmLock(join(root, "pnpm-lock.yaml"));
  if (fromPnpm) return { version: fromPnpm, source: "pnpm-lock" };

  const fromNpm = fromPackageLock(join(root, "package-lock.json"));
  if (fromNpm) return { version: fromNpm, source: "package-lock" };

  const fromYarn = fromYarnLock(join(root, "yarn.lock"));
  if (fromYarn) return { version: fromYarn, source: "yarn-lock" };

  const installed = readPackageJson(
    join(root, "node_modules", ENGINE_PACKAGE),
  ) as (PackageJson & { version?: string }) | null;
  if (installed?.version) {
    return { version: installed.version, source: "node_modules" };
  }

  const pkg = readPackageJson(root);
  const range = pkg ? engineRange(pkg) : undefined;
  const stripped = range?.replace(/^[\^~>=<\s v]+/, "").trim();
  if (stripped && /^\d+\.\d+\.\d+/.test(stripped)) {
    return { version: stripped, source: "package.json" };
  }

  throw new ScaffoldError(
    "no_engine_version",
    `Could not determine the ${ENGINE_PACKAGE} version for ${root}. Commit a lockfile or install dependencies, then publish again.`,
  );
}

/**
 * pnpm's lockfile, read as text rather than as YAML.
 *
 * The shape being matched is the `importers` block pnpm writes for every
 * workspace, where the specifier and the resolved version sit on consecutive
 * lines under the package name:
 *
 *     '@hogsend/engine':
 *       specifier: ^0.57.0
 *       version: 0.57.0
 *
 * A YAML parser would be a dependency to read three lines; a `version:` on the
 * line after the specifier is unambiguous enough to read directly, and a
 * lockfile that does not match simply falls through to the next source.
 */
function fromPnpmLock(file: string): string | null {
  if (!existsSync(file)) return null;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (!new RegExp(`^\\s*'?${ENGINE_PACKAGE}'?:\\s*$`).test(line)) continue;
    for (
      let ahead = index + 1;
      ahead < Math.min(index + 4, lines.length);
      ahead += 1
    ) {
      const match = /^\s*version:\s*['"]?([^'"\s(]+)/.exec(
        lines[ahead] as string,
      );
      if (match?.[1] && /^\d+\.\d+\.\d+/.test(match[1])) return match[1];
    }
  }
  return null;
}

/** npm's lockfile v2/v3: the installed tree is keyed by node_modules path. */
function fromPackageLock(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      packages?: Record<string, { version?: string }>;
      dependencies?: Record<string, { version?: string }>;
    };
    const v3 = parsed.packages?.[`node_modules/${ENGINE_PACKAGE}`]?.version;
    if (v3) return v3;
    return parsed.dependencies?.[ENGINE_PACKAGE]?.version ?? null;
  } catch {
    return null;
  }
}

/** yarn classic: a `"@scope/name@range":` heading followed by `version "x"`. */
function fromYarnLock(file: string): string | null {
  if (!existsSync(file)) return null;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.startsWith(" ") || !line.includes(`${ENGINE_PACKAGE}@`)) continue;
    for (
      let ahead = index + 1;
      ahead < Math.min(index + 6, lines.length);
      ahead += 1
    ) {
      const match = /^\s+version:?\s+"?([^"\s]+)"?/.exec(
        lines[ahead] as string,
      );
      if (match?.[1]) return match[1];
    }
  }
  return null;
}

/** The JSON the intake reads. Keys beyond these are kept by the server. */
export interface PublishManifest {
  appName: string;
  engineVersion: string;
  nodeVersion: string;
  allowUpgrade: boolean;
}

export function buildManifest(input: {
  appName: string;
  engineVersion: string;
  allowUpgrade: boolean;
  nodeVersion?: string;
}): PublishManifest {
  return {
    appName: input.appName,
    engineVersion: input.engineVersion,
    // `process.versions.node` is bare ("22.13.0"); the manifest keeps it bare
    // so the far side can compare it without parsing a `v`.
    nodeVersion: input.nodeVersion ?? process.versions.node,
    allowUpgrade: input.allowUpgrade,
  };
}
