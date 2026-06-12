import { randomBytes } from "node:crypto";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import type { PosthogOptions } from "./prompts.js";
import {
  ENGINE_VERSION,
  HOGSEND_PACKAGES,
  RENAME_MAP,
  TOKEN_FILES,
} from "./template-manifest.js";

export interface CopyOptions {
  templateDir: string;
  targetDir: string;
  appName: string;
  /** Emit `.claude/` (skills) + `CLAUDE.md`. Gated by the `--skills` prompt/flag. */
  skills: boolean;
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

/**
 * Rewrite each `@hogsend/<pkg>` dependency value to a local tarball `file:`
 * specifier so the scaffold resolves the (not-yet-published) packages from
 * `pnpm pack` / `npm pack` output. Used only by the verification harness.
 */
function rewriteTarballDeps(pkgJson: string, tarballDir: string): string {
  const pkg = JSON.parse(pkgJson) as {
    dependencies?: Record<string, string>;
    pnpm?: { overrides?: Record<string, string> };
  };
  const overrides: Record<string, string> = {};
  for (const name of HOGSEND_PACKAGES) {
    const dep = `@hogsend/${name}`;
    const spec = `file:${tarballDir}/hogsend-${name}-${ENGINE_VERSION}.tgz`;
    if (pkg.dependencies && dep in pkg.dependencies) {
      pkg.dependencies[dep] = spec;
    }
    // `pnpm pack` rewrites each tarball's internal `workspace:` @hogsend deps
    // to a bare version (e.g. "0.0.1"), which would 404 against the registry.
    // Overrides force every transitive @hogsend/* to resolve to its tarball.
    overrides[dep] = spec;
  }
  pkg.pnpm = {
    ...pkg.pnpm,
    overrides: { ...pkg.pnpm?.overrides, ...overrides },
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
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

    const isTokenFile = (TOKEN_FILES as readonly string[]).includes(renamed);
    if (!isTokenFile) {
      await copyFile(srcPath, destPath);
      continue;
    }

    let content = await readFile(srcPath, "utf8");
    content = applyTokens(content, opts.appName);
    if (renamed === "package.json" && opts.tarballDir) {
      content = rewriteTarballDeps(content, opts.tarballDir);
    }
    await writeFile(destPath, content);
  }
}
