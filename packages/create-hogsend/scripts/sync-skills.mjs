#!/usr/bin/env node
// sync-skills.mjs — copy the canonical Claude Code skills into the template so
// every scaffolded app ships `.claude/skills/**` (package.json files[] includes
// "template", so the generated dir rides along in the published tarball).
//
// Runs as create-hogsend's `prebuild`. The SINGLE source of truth for skills is
// packages/cli/skills/ (the same tree @hogsend/cli ships + `hogsend skills add`
// installs). We read it directly from the monorepo source tree — it is committed
// source, not a build artifact, so there is NO turbo edge to @hogsend/cli and
// none is needed. create-hogsend is always built inside the monorepo before
// publish, so the relative path is always present.
//
// The copied dir (template/.claude/skills/) is a BUILD ARTIFACT and is
// gitignored; edit skills only in packages/cli/skills/.
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const cliRoot = resolve(pkgRoot, "..", "cli");
const cliSkills = resolve(cliRoot, "skills");
const claudeDir = resolve(pkgRoot, "template", ".claude");
const dest = resolve(claudeDir, "skills");
const stampFile = resolve(claudeDir, ".hogsend-skills.json");

// Basenames copy.ts treats specially: anything in RENAME_MAP or TOKEN_FILES
// (matched by basename, at ANY depth) would be silently renamed,
// token-substituted, or JSON-parsed (package.json -> tarball-dep rewrite) when
// the template is copied into a scaffolded app. A skill file with one of these
// names would be corrupted on emit, so we refuse to ship one. Keep this in sync
// with src/template-manifest.ts (RENAME_MAP keys + TOKEN_FILES) + the two
// CLAUDE files.
const RESERVED_BASENAMES = new Set([
  // RENAME_MAP keys
  "gitignore",
  "npmrc",
  "env.example",
  "node-version",
  "_package.json",
  // TOKEN_FILES
  "package.json",
  "README.md",
  "footer.tsx",
  "welcome.tsx",
  "logo.tsx",
  "registry.ts",
  // CLAUDE orientation files (rename + token targets)
  "CLAUDE.md",
  "CLAUDE.template.md",
]);

function fail(msg) {
  console.error(`[sync-skills] ${msg}`);
  process.exit(1);
}

/** Every file under `dir`, recursively, as absolute paths. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

if (!existsSync(cliSkills)) {
  fail(
    `canonical skills not found at ${cliSkills}. create-hogsend must be built ` +
      "inside the monorepo (the skills source lives in packages/cli/skills).",
  );
}

// Count installable skills (a subdir with a SKILL.md) — mirror the CLI's own
// discovery so "what ships in the scaffold" == "what `hogsend skills add` sees".
const skillDirs = readdirSync(cliSkills).filter(
  (name) =>
    statSync(join(cliSkills, name)).isDirectory() &&
    existsSync(join(cliSkills, name, "SKILL.md")),
);
if (skillDirs.length === 0) {
  fail(`no skills (SKILL.md subdirs) found under ${cliSkills}`);
}

// Refuse any reserved basename BEFORE copying — fail the build, don't ship a
// corrupted skill.
for (const file of walk(cliSkills)) {
  const base = file.slice(file.lastIndexOf("/") + 1);
  if (RESERVED_BASENAMES.has(base)) {
    fail(
      `skill file "${file}" uses reserved basename "${base}" — copy.ts would ` +
        "rename/token-substitute/JSON-parse it on scaffold. Rename it.",
    );
  }
}

rmSync(dest, { recursive: true, force: true });
cpSync(cliSkills, dest, { recursive: true });

// Provenance stamp so a freshly-scaffolded app's `hogsend doctor` can already
// tell when these skills have fallen behind a newer CLI. Records the
// @hogsend/cli version that produced them (skills version on the CLI line, not
// the engine line). No timestamp — keeps the published tarball reproducible.
let cliVersion = "0.0.0";
try {
  const cliPkg = JSON.parse(
    readFileSync(resolve(cliRoot, "package.json"), "utf8"),
  );
  if (typeof cliPkg.version === "string") cliVersion = cliPkg.version;
} catch {
  // Non-fatal — the stamp just records 0.0.0 (always "stale", harmlessly).
}
writeFileSync(
  stampFile,
  `${JSON.stringify({ cliVersion, skills: [...skillDirs].sort() }, null, 2)}\n`,
);

console.log(
  `[sync-skills] copied ${skillDirs.length} skill(s) ` +
    `(${skillDirs.join(", ")}) -> ${dest} [stamp v${cliVersion}]`,
);
