#!/usr/bin/env node
/**
 * release-doctor — enforce the monorepo's release / version-integrity invariants.
 *
 *   node scripts/release-doctor.mjs            # --check (default): assert every
 *                                              # invariant; exit 1 on any violation
 *   node scripts/release-doctor.mjs --sync     # auto-fix the mechanical drift
 *                                              # (ENGINE_VERSION <- @hogsend/engine)
 *
 * The release pipeline relies on several invariants that are otherwise tribal
 * knowledge in `docs/RELEASING.md` and the `release` skill — and that have
 * silently broken public releases before. This script turns them into an
 * executable gate:
 *
 *   --sync  runs inside the changeset `version` step (see the root
 *           `version-packages` script). It rewrites the ONE value a machine can
 *           safely derive — `ENGINE_VERSION` in template-manifest.ts — to match
 *           the freshly-bumped engine version, so the scaffold's
 *           `^{{ENGINE_VERSION}}` pins land on the new line. The change lands in
 *           the "Version Packages" PR where it is reviewable.
 *
 *   --check runs as a CI preflight (and at the top of the release workflow). It
 *           ASSERTS the invariants a machine must NOT auto-"fix": version-line
 *           uniformity, the three scaffold package lists agreeing, no
 *           force-major peer trap, no migration-number collision, publish
 *           visibility. A violation fails the build with a precise message.
 *
 * Pure node:fs, zero deps. Run from anywhere — paths resolve from the repo root.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const r = (p) => join(ROOT, p);
const readText = (p) => readFileSync(r(p), "utf8");
const readJson = (p) => JSON.parse(readText(p));

const MANIFEST = "packages/create-hogsend/src/template-manifest.ts";
const VERIFY_SH = "packages/create-hogsend/scripts/verify-scaffold.sh";
const TEMPLATE_PKG = "packages/create-hogsend/template/_package.json";

const engineVersion = () => readJson("packages/engine/package.json").version;

function manifestEngineVersion() {
  const m = readText(MANIFEST).match(/ENGINE_VERSION\s*=\s*["']([^"']+)["']/);
  if (!m) throw new Error(`ENGINE_VERSION not found in ${MANIFEST}`);
  return m[1];
}

function manifestPackages() {
  const m = readText(MANIFEST).match(/HOGSEND_PACKAGES\s*=\s*\[([^\]]*)\]/s);
  if (!m) throw new Error(`HOGSEND_PACKAGES not found in ${MANIFEST}`);
  return [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
}

function verifyShPackages() {
  const m = readText(VERIFY_SH).match(/PACKAGES=\(([^)]*)\)/);
  if (!m) throw new Error(`PACKAGES=() not found in ${VERIFY_SH}`);
  return m[1].trim().split(/\s+/).filter(Boolean);
}

function templateHogsendDeps() {
  const deps = readJson(TEMPLATE_PKG).dependencies || {};
  return Object.entries(deps)
    .filter(([k]) => k.startsWith("@hogsend/"))
    .map(([k, v]) => [k.slice("@hogsend/".length), v]);
}

/**
 * Union of package names bumped across every pending changeset. Parses the
 * YAML frontmatter of each `.changeset/*.md` (README excluded) with a plain
 * regex — frontmatter lines are `"pkg-name": patch|minor|major`. The UNION
 * matters: a fix changeset + a separate uniform-line changeset is the blessed
 * pattern, so uniformity is evaluated across all pending changesets together,
 * never per file.
 */
function pendingChangesetBumps() {
  let files = [];
  try {
    files = readdirSync(r(".changeset")).filter(
      (f) => f.endsWith(".md") && f !== "README.md",
    );
  } catch {
    return new Set();
  }
  const bumped = new Set();
  for (const f of files) {
    const m = readText(`.changeset/${f}`).match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) continue;
    for (const line of m[1].split(/\r?\n/)) {
      const pkg = line.match(/^\s*["']?([^"':\s]+)["']?\s*:/);
      if (pkg) bumped.add(pkg[1]);
    }
  }
  return bumped;
}

const sameSet = (a, b) => {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/**
 * Dir names of every publishable engine-line package under `packages/`, scanned
 * from disk: the `@hogsend/*` scope plus the bare `hogsend` CLI alias. Excludes
 * private packages and other names (so `create-hogsend` — its own version line —
 * and `@repo/typescript-config` drop out).
 */
function enginePackagesFromDisk() {
  return readdirSync(r("packages"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => {
      let pkg;
      try {
        pkg = readJson(`packages/${n}/package.json`);
      } catch {
        return false;
      }
      return (
        typeof pkg.name === "string" &&
        (pkg.name.startsWith("@hogsend/") || pkg.name === "hogsend") &&
        !pkg.private &&
        pkg.publishConfig?.access === "public"
      );
    });
}

/**
 * Every publishable `@hogsend/*` package shares the engine version line. DERIVED
 * FROM DISK (not HOGSEND_PACKAGES) so opt-in packages that ship on the line but
 * are NOT scaffold defaults — e.g. `@hogsend/plugin-postmark` — are still held to
 * version-line uniformity, publish-visibility, and the peer-trap checks. The
 * scaffold-default subset stays HOGSEND_PACKAGES; the three-list check below
 * proves THAT subset agrees with verify-scaffold's PACKAGES and the template's
 * @hogsend deps. Disk-derived = no list to keep in sync; a new publishable
 * @hogsend package is covered automatically.
 */
const ENGINE_LINE = enginePackagesFromDisk();

/** Each check returns null when satisfied, or a precise violation string. */
const checks = [
  {
    name: "ENGINE_VERSION matches @hogsend/engine version",
    fn: () => {
      const e = engineVersion();
      const m = manifestEngineVersion();
      return e === m
        ? null
        : `ENGINE_VERSION=${m} but @hogsend/engine=${e} — run: pnpm release-doctor --sync`;
    },
  },
  {
    name: "all engine-line packages share one version",
    fn: () => {
      const versions = ENGINE_LINE.map((n) => [
        n,
        readJson(`packages/${n}/package.json`).version,
      ]);
      const distinct = new Set(versions.map(([, v]) => v));
      return distinct.size === 1
        ? null
        : `engine-line versions diverge: ${versions.map(([n, v]) => `${n}@${v}`).join(", ")}`;
    },
  },
  {
    // create-hogsend is a separate scope (not @hogsend/*) so it falls outside
    // ENGINE_LINE — but its template pins `^{{ENGINE_VERSION}}` and it must
    // republish every release or `create-hogsend@latest` scaffolds a stale app.
    // It silently drifted to 0.22.0 while the line reached 0.30.0 BECAUSE no
    // check held it to the line. This is that check: the scaffolder rides the
    // engine version, caught up + bumped with the line in the release changeset.
    name: "create-hogsend tracks the engine version line",
    fn: () => {
      const e = engineVersion();
      const c = readJson("packages/create-hogsend/package.json").version;
      return c === e
        ? null
        : `create-hogsend@${c} but @hogsend/engine@${e} — the scaffolder must ride the engine line so its ^{{ENGINE_VERSION}} pins stay current; bump create-hogsend with the line (see .claude/skills/release)`;
    },
  },
  {
    // Catches the split-version-line trap at PR time instead of letting it
    // surface as a uniformity failure on the Version Packages PR much later
    // (hit on PR #121: a changeset bumping only @hogsend/plugin-resend).
    // create-hogsend and private packages are not engine-line, so bumping
    // them alone is fine; no pending changesets (Version PR state) passes.
    name: "pending changesets keep the engine version line uniform",
    fn: () => {
      const bumped = pendingChangesetBumps();
      const lineNames = ENGINE_LINE.map(
        (n) => readJson(`packages/${n}/package.json`).name,
      );
      const touched = lineNames.filter((n) => bumped.has(n));
      if (touched.length === 0) return null;
      const missing = lineNames.filter((n) => !bumped.has(n)).sort();
      return missing.length === 0
        ? null
        : `pending changesets bump ${touched.length}/${lineNames.length} engine-line packages but miss: ${missing.join(", ")} — add an explicit changeset bumping the full engine line (see .claude/skills/release)`;
    },
  },
  {
    name: "HOGSEND_PACKAGES == verify-scaffold PACKAGES == template @hogsend deps",
    fn: () => {
      const a = manifestPackages();
      const b = verifyShPackages();
      const c = templateHogsendDeps().map(([n]) => n);
      if (!sameSet(a, b))
        return `HOGSEND_PACKAGES [${[...a].sort()}] != verify-scaffold PACKAGES [${[...b].sort()}]`;
      if (!sameSet(a, c))
        return `HOGSEND_PACKAGES [${[...a].sort()}] != template _package.json @hogsend deps [${[...c].sort()}]`;
      return null;
    },
  },
  {
    name: "template @hogsend deps all pin ^{{ENGINE_VERSION}}",
    fn: () => {
      const bad = templateHogsendDeps().filter(
        ([, v]) => v !== "^{{ENGINE_VERSION}}",
      );
      return bad.length === 0
        ? null
        : `non-token pins: ${bad.map(([n, v]) => `${n}:${v}`).join(", ")}`;
    },
  },
  {
    name: "no @hogsend/* in any publishable package's peerDependencies (force-major trap)",
    fn: () => {
      const offenders = [];
      for (const n of ENGINE_LINE) {
        const pkg = readJson(`packages/${n}/package.json`);
        const peers = Object.keys(pkg.peerDependencies || {}).filter((k) =>
          k.startsWith("@hogsend/"),
        );
        if (peers.length)
          offenders.push(`${pkg.name} peerDeps: ${peers.join(", ")}`);
      }
      return offenders.length === 0 ? null : offenders.join("; ");
    },
  },
  {
    name: "no duplicate migration numbers (parallel-PR collision)",
    fn: () => {
      const files = readdirSync(r("packages/db/drizzle")).filter((f) =>
        /^\d{4}_.*\.sql$/.test(f),
      );
      const seen = new Map();
      for (const f of files.sort()) {
        const num = f.slice(0, 4);
        if (seen.has(num))
          return `duplicate migration number ${num}: ${seen.get(num)} and ${f}`;
        seen.set(num, f);
      }
      return null;
    },
  },
  {
    name: "public packages declare publishConfig.access=public; api stays private",
    fn: () => {
      const errs = [];
      for (const n of [...ENGINE_LINE, "create-hogsend"]) {
        const pkg = readJson(`packages/${n}/package.json`);
        if (pkg.private)
          errs.push(`${pkg.name} is private:true but should publish`);
        if (pkg.publishConfig?.access !== "public")
          errs.push(`${pkg.name} missing publishConfig.access:public`);
      }
      if (!readJson("apps/api/package.json").private)
        errs.push("@hogsend/api must be private");
      return errs.length === 0 ? null : errs.join("; ");
    },
  },
];

function sync() {
  const e = engineVersion();
  const text = readText(MANIFEST);
  const next = text.replace(
    /(ENGINE_VERSION\s*=\s*["'])[^"']+(["'])/,
    `$1${e}$2`,
  );
  if (next === text) {
    console.log(`release-doctor --sync: ENGINE_VERSION already ${e}`);
    return;
  }
  writeFileSync(r(MANIFEST), next);
  console.log(`release-doctor --sync: ENGINE_VERSION -> ${e}`);
}

function runChecks() {
  let failed = 0;
  for (const { name, fn } of checks) {
    let err = null;
    try {
      err = fn();
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    if (err) {
      failed += 1;
      console.error(`✗ ${name}\n    ${err}`);
    } else {
      console.log(`✓ ${name}`);
    }
  }
  if (failed) {
    console.error(`\nrelease-doctor: ${failed} invariant(s) violated`);
    process.exit(1);
  }
  console.log(`\nrelease-doctor: all ${checks.length} invariants OK`);
}

if (process.argv.includes("--sync")) {
  sync();
} else {
  runChecks();
}
