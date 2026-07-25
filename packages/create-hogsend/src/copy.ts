import { randomBytes } from "node:crypto";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import {
  OPTIONAL_PLUGINS,
  type OptionalPluginId,
  optionalPlugin,
} from "./optional-plugins.js";
import type { PackageManager, PosthogOptions } from "./prompts.js";
import {
  ENGINE_VERSION,
  HOGSEND_PACKAGES,
  PNPM_VERSION,
  RENAME_MAP,
  TOKEN_FILES,
} from "./template-manifest.js";

export interface CopyOptions {
  templateDir: string;
  targetDir: string;
  appName: string;
  packageManager: PackageManager;
  /** Emit `.claude/` (skills) + `CLAUDE.md`. Gated by the `--skills` prompt/flag. */
  skills: boolean;
  /** Opt-in provider plugins to pin as dependencies (`--with` / multiselect). */
  optionalPlugins?: OptionalPluginId[];
  /** Absolute dir of `file:` tarballs to rewrite @hogsend/* deps against. */
  tarballDir?: string;
}

function applyTokens(content: string, appName: string): string {
  return content
    .split("{{APP_NAME}}")
    .join(appName)
    .split("{{ENGINE_VERSION}}")
    .join(ENGINE_VERSION);
}

/** Pin Corepack when the generated app selected pnpm. */
function rewritePackageManager(
  pkgJson: string,
  packageManager: PackageManager,
): string {
  const pkg = JSON.parse(pkgJson) as { packageManager?: string };
  if (packageManager === "pnpm") {
    pkg.packageManager = `pnpm@${PNPM_VERSION}`;
  } else {
    delete pkg.packageManager;
  }
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/**
 * The tarball `file:` override map for every `@hogsend/<pkg>` dependency —
 * scaffold defaults AND the opt-in plugins. The plugins are always pinned
 * (selected or not) because the engine lists all three under
 * `optionalDependencies`, so a tarball install would otherwise try to resolve
 * the unpublished engine-line version from the registry.
 */
function tarballOverrides(tarballDir: string): Record<string, string> {
  const overrides: Record<string, string> = {};
  const names: string[] = [
    ...HOGSEND_PACKAGES,
    ...OPTIONAL_PLUGINS.map((p) => p.pkg.replace("@hogsend/", "")),
  ];
  for (const name of names) {
    overrides[`@hogsend/${name}`] =
      `file:${tarballDir}/hogsend-${name}-${ENGINE_VERSION}.tgz`;
  }
  return overrides;
}

/**
 * Rewrite each `@hogsend/<pkg>` dependency value to a local tarball `file:`
 * specifier so the scaffold resolves the (not-yet-published) packages from
 * `pnpm pack` / `npm pack` output. Used only by the verification harness.
 */
function rewriteTarballDeps(pkgJson: string, tarballDir: string): string {
  const pkg = JSON.parse(pkgJson) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const overrides = tarballOverrides(tarballDir);
  for (const [dep, spec] of Object.entries(overrides)) {
    if (pkg.dependencies && dep in pkg.dependencies) {
      pkg.dependencies[dep] = spec;
    }
    if (pkg.devDependencies && dep in pkg.devDependencies) {
      pkg.devDependencies[dep] = spec;
    }
  }
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/**
 * Pin each selected opt-in plugin as a DIRECT dependency of the generated app,
 * on the same `^<engine version>` line as the scaffold defaults. Direct is the
 * whole point: the app bundles the engine, so the engine's runtime-assembled
 * `import("@hogsend/plugin-<id>")` resolves against the APP's node_modules,
 * where an engine-only `optionalDependency` is never linked (#611). Runs
 * BEFORE the tarball rewrite so `--use-tarballs` covers these too. Keys are
 * re-sorted so the injected deps land alphabetically like the template's.
 */
function addOptionalPluginDeps(
  pkgJson: string,
  plugins: OptionalPluginId[],
): string {
  const pkg = JSON.parse(pkgJson) as {
    dependencies?: Record<string, string>;
  };
  const deps = pkg.dependencies ?? {};
  for (const id of plugins) {
    deps[optionalPlugin(id).pkg] = `^${ENGINE_VERSION}`;
  }
  pkg.dependencies = Object.fromEntries(
    Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)),
  );
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/**
 * Surface each selected plugin's credential block in the emitted `.env.example`
 * (commented keys only — never a fake credential value). Skipped when the
 * template already documents the credential (Apollo's block ships in the
 * template), so a selection never duplicates it. Same timing as
 * `applyDomainToEnv` — after `copyTemplate`, before install/bootstrap.
 */
export async function applyOptionalPluginsToEnv(
  targetDir: string,
  plugins: OptionalPluginId[],
): Promise<void> {
  if (plugins.length === 0) return;
  const envPath = join(targetDir, RENAME_MAP["env.example"] ?? ".env.example");
  let content = await readFile(envPath, "utf8");
  for (const id of plugins) {
    const { envKey, envBlock } = optionalPlugin(id);
    // Match a settable `KEY=` line (live or commented), NOT a prose mention —
    // the template's email-provider paragraph names POSTMARK_SERVER_TOKEN
    // without offering a line to uncomment, and that must not suppress the
    // block. Same line shape `setEnvLine` targets.
    if (new RegExp(`^#?\\s*${envKey}=`, "m").test(content)) continue;
    content = `${content.replace(/\n*$/, "\n")}\n${envBlock}\n`;
  }
  await writeFile(envPath, content);
}

/**
 * Append the same tarball override map to the emitted `pnpm-workspace.yaml` —
 * pnpm 11's settings root. Without it the harness silently resolves transitive
 * `@hogsend/*` dependencies from the registry instead of the packed tarballs.
 */
function rewriteWorkspaceOverrides(yaml: string, tarballDir: string): string {
  const lines = Object.entries(tarballOverrides(tarballDir))
    .map(([dep, spec]) => `  "${dep}": "${spec}"`)
    .join("\n");
  return `${yaml.trimEnd()}\n\n# TEST-ONLY (--use-tarballs): pin @hogsend/* to local tarballs.\noverrides:\n${lines}\n`;
}

/** Recursively copy `template/` into the target, renaming + token-replacing. */
export async function copyTemplate(opts: CopyOptions): Promise<void> {
  await walk(opts.templateDir, opts.templateDir, opts.targetDir, opts);
}

/**
 * Set (or uncomment) one `KEY=value` line in an env file's content. Replaces
 * the FIRST commented `# KEY=...` placeholder or live `KEY=...` line; appends
 * when neither exists, so the patch is robust to template drift.
 */
function setEnvLine(content: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^#?\\s*${key}=.*$`, "m");
  if (re.test(content)) {
    return content.replace(re, line);
  }
  return `${content.replace(/\n*$/, "\n")}${line}\n`;
}

/**
 * Patch the scaffolded env example for a `--domain` scaffold: uncomments/sets
 * `EMAIL_FROM=hello@<domain>` + `EMAIL_DOMAIN=<domain>`. The template's
 * `env.example` is emitted as `.env.example` (RENAME_MAP). Runs right after
 * `copyTemplate` and BEFORE install/bootstrap, so the bootstrap-copied `.env`
 * inherits the values.
 */
export async function applyDomainToEnv(
  targetDir: string,
  domain: string,
): Promise<void> {
  const envPath = join(targetDir, RENAME_MAP["env.example"] ?? ".env.example");
  let content = await readFile(envPath, "utf8");
  content = setEnvLine(content, "EMAIL_FROM", `hello@${domain}`);
  content = setEnvLine(content, "EMAIL_DOMAIN", domain);
  await writeFile(envPath, content);
}

/**
 * Patch the scaffolded env example with the first Studio admin: uncomments/sets
 * `STUDIO_ADMIN_EMAIL` (+ `STUDIO_ADMIN_PASSWORD` when given — already
 * validated ≥ 8 chars by the flag parser; shorter would fail the app's env
 * validation at every boot). The API mints the admin on FIRST BOOT via
 * `bootstrapAdminFromEnv` (no-op once any user exists); with no password set,
 * the engine generates one and prints it once to the boot log. Same mechanism +
 * timing as `applyDomainToEnv` — before install/bootstrap, so bootstrap's
 * `.env` copy inherits the values.
 */
export async function applyAdminToEnv(
  targetDir: string,
  admin: { email: string; password?: string },
): Promise<void> {
  const envPath = join(targetDir, RENAME_MAP["env.example"] ?? ".env.example");
  let content = await readFile(envPath, "utf8");
  content = setEnvLine(content, "STUDIO_ADMIN_EMAIL", admin.email);
  if (admin.password !== undefined) {
    content = setEnvLine(content, "STUDIO_ADMIN_PASSWORD", admin.password);
  }
  await writeFile(envPath, content);
}

/**
 * Patch the scaffolded env example for a PostHog-enabled scaffold: uncomments/
 * sets `POSTHOG_API_KEY` + `POSTHOG_HOST` as active values, activates
 * `ENABLE_POSTHOG_DESTINATION=true`, and mints a fresh `POSTHOG_WEBHOOK_SECRET`.
 * Same mechanism + timing as `applyDomainToEnv` — runs right after
 * `copyTemplate` and BEFORE install/bootstrap, so the bootstrap-copied `.env`
 * inherits the values.
 */
export async function applyPosthogToEnv(
  targetDir: string,
  posthog: PosthogOptions,
): Promise<void> {
  const envPath = join(targetDir, RENAME_MAP["env.example"] ?? ".env.example");
  let content = await readFile(envPath, "utf8");
  content = setEnvLine(content, "POSTHOG_API_KEY", posthog.apiKey);
  content = setEnvLine(content, "POSTHOG_HOST", posthog.host);
  content = setEnvLine(content, "ENABLE_POSTHOG_DESTINATION", "true");
  content = setEnvLine(
    content,
    "POSTHOG_WEBHOOK_SECRET",
    randomBytes(32).toString("hex"),
  );
  await writeFile(envPath, content);
}

/**
 * The top-level names the scaffold will write (rename map applied). Used to
 * detect collisions when scaffolding into a non-empty current directory (`.`).
 */
export async function emittedTopLevelNames(
  templateDir: string,
): Promise<string[]> {
  const entries = await readdir(templateDir, { withFileTypes: true });
  return entries.map((e) => RENAME_MAP[e.name] ?? e.name);
}

async function walk(
  current: string,
  templateRoot: string,
  targetRoot: string,
  opts: CopyOptions,
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(current, entry.name);
    const rel = relative(templateRoot, srcPath);

    // Skills + the agent orientation file are opt-out (--no-skills). Both names
    // only exist at the template root, so an entry-name check skips the whole
    // .claude/ tree (no recurse) and the CLAUDE.template.md -> CLAUDE.md emit.
    if (
      !opts.skills &&
      (entry.name === ".claude" || entry.name === "CLAUDE.template.md")
    ) {
      continue;
    }

    if (entry.isDirectory()) {
      await mkdir(join(targetRoot, rel), { recursive: true });
      await walk(srcPath, templateRoot, targetRoot, opts);
      continue;
    }

    const renamed = RENAME_MAP[entry.name] ?? entry.name;
    const relDir = rel.slice(0, rel.length - entry.name.length);
    const destPath = join(targetRoot, relDir, renamed);
    await mkdir(join(targetRoot, relDir), { recursive: true });

    const { tarballDir } = opts;
    const isTokenFile = (TOKEN_FILES as readonly string[]).includes(renamed);
    const isTarballWorkspace =
      renamed === "pnpm-workspace.yaml" && tarballDir !== undefined;
    if (!isTokenFile && !isTarballWorkspace) {
      await copyFile(srcPath, destPath);
      continue;
    }

    let content = await readFile(srcPath, "utf8");
    content = applyTokens(content, opts.appName);
    if (renamed === "package.json") {
      content = rewritePackageManager(content, opts.packageManager);
      if (opts.optionalPlugins?.length) {
        content = addOptionalPluginDeps(content, opts.optionalPlugins);
      }
      if (tarballDir) {
        content = rewriteTarballDeps(content, tarballDir);
      }
    }
    if (isTarballWorkspace && tarballDir) {
      content = rewriteWorkspaceOverrides(content, tarballDir);
    }
    await writeFile(destPath, content);
  }
}
