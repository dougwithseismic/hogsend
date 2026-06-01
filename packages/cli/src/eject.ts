import { existsSync } from "node:fs";
import { cp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

/** Options for {@link eject}. */
export interface EjectOptions {
  /** Scoped package name to eject, e.g. "@hogsend/engine". */
  pkg: string;
  /** Consumer repo root (the dir containing the consumer package.json). */
  consumerRoot: string;
  /**
   * Where the package source currently lives (the workspace/registry copy).
   * In-monorepo: <repoRoot>/packages/<name>. In a scaffolded app it is the
   * resolved node_modules path. The caller resolves this; eject() never
   * guesses it.
   */
  sourceDir: string;
  /** Overwrite an existing vendor/<name>. */
  force?: boolean;
}

/** Result of a successful {@link eject}. */
export interface EjectResult {
  pkg: string;
  /** Absolute path to vendor/<name>. */
  vendorPath: string;
  /** The dep spec before the rewrite, e.g. "workspace:^". */
  depSpecBefore: string;
  /** The dep spec after the rewrite, "file:./vendor/<name>". */
  depSpecAfter: string;
  /** Number of files copied into vendor/<name>. */
  copiedFiles: number;
  /** The install command the operator must run next. */
  followUp: string;
}

/** Typed failure thrown by {@link eject} for expected, user-facing errors. */
export class EjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EjectError";
  }
}

/** Directory/file names excluded from the vendor copy. */
const EXCLUDED_NAMES = new Set([
  "node_modules",
  "dist",
  ".turbo",
  ".changeset",
  "CHANGELOG.md",
]);

interface PackageJson {
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

type DepMap = "dependencies" | "devDependencies";

async function readPackageJson(file: string): Promise<PackageJson> {
  const raw = await readFile(file, "utf8");
  return JSON.parse(raw) as PackageJson;
}

async function writePackageJson(
  file: string,
  value: PackageJson,
): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Pure eject: copies a single package's source into the consumer's
 * `vendor/<name>` and rewrites only that consumer dependency to a
 * `file:./vendor/<name>` link. Every other dependency is left untouched, so
 * the rest of the `@hogsend/*` set keeps upgrading via `pnpm up`.
 *
 * This function performs filesystem operations only — it never runs an install
 * and never resolves `sourceDir` itself, which keeps it hermetically testable.
 */
export async function eject(opts: EjectOptions): Promise<EjectResult> {
  const { pkg, consumerRoot, sourceDir, force = false } = opts;

  // 1. Resolve names.
  const vendorName = basename(pkg);
  const vendorPath = join(consumerRoot, "vendor", vendorName);

  // 2. Validate the consumer dependency exists (before any side effects).
  const consumerPkgPath = join(consumerRoot, "package.json");
  const consumerPkg = await readPackageJson(consumerPkgPath);
  let depMap: DepMap | undefined;
  let depSpecBefore: string | undefined;
  if (consumerPkg.dependencies?.[pkg] !== undefined) {
    depMap = "dependencies";
    depSpecBefore = consumerPkg.dependencies[pkg];
  } else if (consumerPkg.devDependencies?.[pkg] !== undefined) {
    depMap = "devDependencies";
    depSpecBefore = consumerPkg.devDependencies[pkg];
  }
  if (!depMap || depSpecBefore === undefined) {
    throw new EjectError(
      `${pkg} is not a dependency of the consumer package.json`,
    );
  }

  // 3. Guard the vendor dir.
  if (existsSync(vendorPath)) {
    if (!force) {
      throw new EjectError(
        `vendor/${vendorName} already exists; pass --force to overwrite`,
      );
    }
    await rm(vendorPath, { recursive: true, force: true });
  }

  // 4. Copy source with an exclude filter. Returning false for a directory
  //    prunes the whole subtree (Node 22 fs.cp filter semantics).
  let copiedFiles = 0;
  await cp(sourceDir, vendorPath, {
    recursive: true,
    filter: (source) => {
      const rel = relative(sourceDir, source);
      if (rel === "") {
        return true;
      }
      const segments = rel.split(sep);
      const name = basename(rel);
      // Exclude any path segment that is an excluded name (prunes subtrees).
      if (segments.some((segment) => EXCLUDED_NAMES.has(segment))) {
        return false;
      }
      if (name.endsWith(".test.ts")) {
        return false;
      }
      return true;
    },
  });

  // Count copied files (directories excluded) for the result summary.
  copiedFiles = await countFiles(vendorPath);

  // 5. Sanitize the vendored package.json.
  const vendoredPkgPath = join(vendorPath, "package.json");
  const vendoredPkg = await readPackageJson(vendoredPkgPath);
  if (vendoredPkg.private === true) {
    delete vendoredPkg.private;
  }
  await writePackageJson(vendoredPkgPath, vendoredPkg);

  // 6. Rewrite the consumer dep in place (preserving key order).
  const depSpecAfter = `file:./vendor/${vendorName}`;
  // biome-ignore lint/style/noNonNullAssertion: depMap validated above.
  consumerPkg[depMap]![pkg] = depSpecAfter;
  await writePackageJson(consumerPkgPath, consumerPkg);

  // 7. Return the result.
  return {
    pkg,
    vendorPath,
    depSpecBefore,
    depSpecAfter,
    copiedFiles,
    followUp: "pnpm install",
  };
}

/** Recursively counts regular files under a directory. */
async function countFiles(dir: string): Promise<number> {
  const { readdir } = await import("node:fs/promises");
  let count = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      count += await countFiles(full);
    } else if (entry.isFile()) {
      count += 1;
    } else {
      const info = await stat(full);
      if (info.isFile()) {
        count += 1;
      }
    }
  }
  return count;
}
