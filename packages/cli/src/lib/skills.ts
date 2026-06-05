import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared skill-install machinery, used by `hogsend skills`, `hogsend upgrade`,
 * and the `hogsend doctor` staleness nudge. The CLI ships a `skills/` dir in its
 * published tarball (package.json files[]); these helpers copy it into a
 * consumer project's ./.claude/skills/ and track which CLI version produced it.
 */

export interface BundledSkill {
  name: string;
  description: string;
  installed: boolean;
}

export interface CopyResult {
  name: string;
  installed: boolean;
  skipped: boolean;
  path: string;
}

/** Persisted record of the last skill install — drives the staleness nudge. */
export interface SkillsStamp {
  /** The @hogsend/cli version that produced the installed skills. */
  cliVersion: string;
  /** Installed skill names. */
  skills: string[];
  /** ISO timestamp of the install/refresh (omitted by build-time stamps). */
  updatedAt?: string;
}

/**
 * Resolve the directory holding the bundled skills shipped in the tarball.
 * At runtime the CLI is bundled into <pkg>/dist/bin.js, so the skills dir
 * (shipped via package.json files[]) is one level up at <pkg>/skills.
 */
export function bundledSkillsDir(): string {
  return fileURLToPath(new URL("../skills", import.meta.url));
}

/** Target directory for installed skills in the consumer project. */
export function installDir(cwd: string): string {
  return join(cwd, ".claude", "skills");
}

/** Path to the install stamp (sibling of skills/, NOT inside it). */
export function stampPath(cwd: string): string {
  return join(cwd, ".claude", ".hogsend-skills.json");
}

/** This CLI's own version (read from its package.json at <pkg>/package.json). */
export function cliVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Read a file as utf8, returning "" on any error (never throws). */
function readFileSyncSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** A single-line `key: value` reader for SKILL.md YAML frontmatter. */
function readFrontmatterField(skillDir: string, field: string): string {
  const skillFile = join(skillDir, "SKILL.md");
  if (!existsSync(skillFile)) return "";
  // Tiny frontmatter scan — avoids a YAML dep. Reads only the top block.
  const raw = readFileSyncSafe(skillFile);
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return "";
  const block = fmMatch[1] ?? "";
  for (const line of block.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m && m[1] === field) {
      return (m[2] ?? "").replace(/^["']|["']$/g, "").trim();
    }
  }
  return "";
}

/** Enumerate bundled skills (each is a subdir with a SKILL.md). */
export function listBundledSkills(cwd: string): BundledSkill[] {
  const dir = bundledSkillsDir();
  if (!existsSync(dir)) return [];
  const target = installDir(cwd);
  const entries = readdirSync(dir).filter((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() && existsSync(join(full, "SKILL.md"));
  });
  return entries.sort().map((name) => ({
    name,
    description: readFrontmatterField(join(dir, name), "description"),
    installed: existsSync(join(target, name)),
  }));
}

/** Copy one bundled skill into the project, honouring --force. */
export function copySkill(
  name: string,
  cwd: string,
  force: boolean,
): CopyResult {
  const src = join(bundledSkillsDir(), name);
  const dest = join(installDir(cwd), name);
  const exists = existsSync(dest);
  if (exists && !force) {
    return { name, installed: false, skipped: true, path: dest };
  }
  mkdirSync(installDir(cwd), { recursive: true });
  cpSync(src, dest, { recursive: true, force: true });
  return { name, installed: true, skipped: false, path: dest };
}

/** Record which CLI version produced the currently-installed skills. */
export function writeSkillsStamp(cwd: string, skills: string[]): void {
  const stamp: SkillsStamp = {
    cliVersion: cliVersion(),
    skills: [...skills].sort(),
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(stampPath(cwd), `${JSON.stringify(stamp, null, 2)}\n`);
}

/** Read the install stamp, or null when absent/unreadable. */
export function readSkillsStamp(cwd: string): SkillsStamp | null {
  try {
    const parsed = JSON.parse(readFileSync(stampPath(cwd), "utf8")) as
      | SkillsStamp
      | undefined;
    return parsed && typeof parsed.cliVersion === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** Numeric semver compare on the release line (prerelease tags ignored). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    (v.split("-")[0] ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Staleness verdict for the skills installed in `cwd`. Returns null when no
 * stamp exists (not a tracked app), else whether the installed skills came from
 * an OLDER CLI than the one running now.
 */
export function skillsStaleness(
  cwd: string,
): { stale: boolean; installed: string; current: string } | null {
  const stamp = readSkillsStamp(cwd);
  if (!stamp) return null;
  const current = cliVersion();
  return {
    stale: compareVersions(stamp.cliVersion, current) < 0,
    installed: stamp.cliVersion,
    current,
  };
}
