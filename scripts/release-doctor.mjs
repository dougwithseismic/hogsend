#!/usr/bin/env node
/**
 * release-doctor — enforce the monorepo's release / version-integrity invariants.
 *
 *   node scripts/release-doctor.mjs            # --check (default): assert every
 *                                              # invariant; exit 1 on any violation
 *   node scripts/release-doctor.mjs --sync     # auto-fix the mechanical drift
 *                                              # (ENGINE_VERSION <- @hogsend/engine)
 *   node scripts/release-doctor.mjs --fix-changeset
 *                                              # write the companion changeset that
 *                                              # keeps the engine version line
 *                                              # uniform (run after authoring a
 *                                              # changeset that touches one
 *                                              # engine-line package)
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

/** Parse "1.2.3" -> [1, 2, 3]; ignores any -prerelease/+build suffix. */
const parseSemver = (v) =>
  v
    .split(/[-+]/)[0]
    .split(".")
    .map((n) => Number(n) || 0);
/** The "major.minor" release line of a version, e.g. "0.45". */
const minorLine = (v) => parseSemver(v).slice(0, 2).join(".");
/** a >= b, compared as semver (major, then minor, then patch). */
const semverGte = (a, b) => {
  const [A, B] = [parseSemver(a), parseSemver(b)];
  for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return A[i] > B[i];
  return true;
};

function manifestEngineVersion() {
  const m = readText(MANIFEST).match(/ENGINE_VERSION\s*=\s*["']([^"']+)["']/);
  if (!m) throw new Error(`ENGINE_VERSION not found in ${MANIFEST}`);
  return m[1];
}

function manifestPnpmVersion() {
  const m = readText(MANIFEST).match(/PNPM_VERSION\s*=\s*["']([^"']+)["']/);
  if (!m) throw new Error(`PNPM_VERSION not found in ${MANIFEST}`);
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
  const pkg = readJson(TEMPLATE_PKG);
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  return Object.entries(deps)
    .filter(([k]) => k.startsWith("@hogsend/"))
    .map(([k, v]) => [k.slice("@hogsend/".length), v]);
}

const BUMP_RANK = { patch: 1, minor: 2, major: 3 };
const RANK_BUMP = ["", "patch", "minor", "major"];

/**
 * Map of package name -> highest bump type across every pending changeset.
 * Parses the YAML frontmatter of each `.changeset/*.md` (README excluded) with a
 * plain regex — frontmatter lines are `"pkg-name": patch|minor|major`. Returns a
 * Map so callers get the bump TYPE (needed by --fix-changeset to pick a uniform
 * level), while the legacy `.has(name)` membership check still works unchanged.
 * The UNION across files matters: a fix changeset + a separate uniform-line
 * changeset is the blessed pattern, so uniformity is evaluated across all pending
 * changesets together, never per file. `excludeFile` skips one basename (the
 * companion file --fix-changeset owns) so it reasons about the OTHER changesets.
 */
function pendingChangesetBumps(excludeFile) {
  let files = [];
  try {
    files = readdirSync(r(".changeset")).filter(
      (f) => f.endsWith(".md") && f !== "README.md" && f !== excludeFile,
    );
  } catch {
    return new Map();
  }
  const bumped = new Map();
  for (const f of files) {
    const m = readText(`.changeset/${f}`).match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) continue;
    for (const line of m[1].split(/\r?\n/)) {
      const entry = line.match(
        /^\s*["']?([^"':\s]+)["']?\s*:\s*(patch|minor|major)\s*$/,
      );
      if (!entry) continue;
      const [, name, type] = entry;
      const prev = bumped.get(name);
      if (!prev || BUMP_RANK[type] > BUMP_RANK[prev]) bumped.set(name, type);
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

/**
 * Read `packages/<name>/package.json` for each name, run `predicate(pkg)`,
 * and flatten the resulting offender strings (predicate returns `[]` for a
 * clean package). Shared by the per-package checks below so each stays just
 * its predicate instead of re-deriving the read/loop/collect boilerplate.
 */
function scanPackages(names, predicate) {
  return names.flatMap((n) =>
    predicate(readJson(`packages/${n}/package.json`)),
  );
}

/** Each check returns null when satisfied, or a precise violation string. */
const checks = [
  {
    name: "root and scaffold pin the same pnpm version",
    fn: () => {
      const packageManager = readJson("package.json").packageManager;
      const expected = `pnpm@${manifestPnpmVersion()}`;
      return packageManager === expected
        ? null
        : `root packageManager=${packageManager} but scaffold=${expected}`;
    },
  },
  {
    name: "GitHub Actions avoid the broken pnpm self-update bootstrap",
    fn: () => {
      // action-setup v6 bootstraps an older pnpm and runs `pnpm self-update`.
      // In CI that currently crashes before the repository install starts. v5
      // is Node 24 compatible and installs the requested package manager
      // directly from packageManager instead.
      const offenders = readdirSync(r(".github/workflows"))
        .filter((file) => /\.ya?ml$/.test(file))
        .flatMap((file) =>
          [
            ...readText(`.github/workflows/${file}`).matchAll(
              /pnpm\/action-setup@([^\s#]+)/g,
            ),
          ]
            .map((match) => match[1])
            .filter((version) => version !== "v5")
            .map((version) => `${file}:${version}`),
        );
      return offenders.length === 0
        ? null
        : `replace ${offenders.join(", ")} with pnpm/action-setup@v5`;
    },
  },
  {
    name: "Docker builds pin the repository pnpm version",
    fn: () => {
      const version = manifestPnpmVersion();
      const expected = `corepack prepare pnpm@${version}`;
      const files = ["Dockerfile", "Dockerfile.docs", "Dockerfile.course"];
      const stale = files.filter((file) => !readText(file).includes(expected));
      return stale.length === 0
        ? null
        : `${stale.join(", ")} must contain ${expected}`;
    },
  },
  {
    name: "Docker deploy uses scoped, offline workspace injection",
    fn: () => {
      const workspace = readText("pnpm-workspace.yaml");
      const dockerfile = readText("Dockerfile");
      if (/^\s*injectWorkspacePackages\s*:/m.test(workspace)) {
        return "pnpm-workspace.yaml must not enable injectWorkspacePackages globally";
      }
      if (/pnpm\s+config\s+set\s+inject-workspace-packages/i.test(dockerfile)) {
        return "Dockerfile must not persist inject-workspace-packages in global pnpm config";
      }
      const deploys =
        dockerfile.match(
          /pnpm\s+--offline\s+--config\.inject-workspace-packages=true\s+\\\s*\n\s*--filter\s+@hogsend\/(api|db)\s+deploy\s+--prod/g,
        ) ?? [];
      return deploys.length === 2
        ? null
        : "Dockerfile must deploy api and db offline with command-scoped workspace injection";
    },
  },
  {
    name: "Railway services watch their Docker build inputs",
    fn: () => {
      const requirements = {
        "railway.toml": ["Dockerfile", ".dockerignore", "pnpm-workspace.yaml"],
        "railway.worker.toml": [
          "Dockerfile",
          ".dockerignore",
          "pnpm-workspace.yaml",
        ],
        "railway.docs.toml": [
          "Dockerfile.docs.dockerignore",
          "package.json",
          "packages/**",
          "pnpm-workspace.yaml",
        ],
        "railway.course.toml": [
          ".dockerignore",
          "package.json",
          "packages/**",
          "pnpm-workspace.yaml",
        ],
      };
      const missing = Object.entries(requirements).flatMap(
        ([file, required]) => {
          const match = readText(file).match(
            /watchPatterns\s*=\s*\[([^\]]*)\]/s,
          );
          const watched = new Set(
            match
              ? [...match[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1])
              : [],
          );
          return required
            .filter((input) => !watched.has(input))
            .map((input) => `${file}:${input}`);
        },
      );
      return missing.length === 0
        ? null
        : `Railway watchPatterns missing ${missing.join(", ")}`;
    },
  },
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
    // ENGINE_LINE — but its template pins `^{{ENGINE_VERSION}}` and must ride
    // the engine's MINOR line so those caret pins resolve to the current engine
    // (`^0.45.x` matches any 0.45.z). It silently drifted to 0.22.0 while the
    // line reached 0.30.0 BECAUSE no check held it to the line — this check
    // guards that.
    //
    // It must be the ENGINE'S MINOR LINE, not exact equality. A scaffold-only
    // release (e.g. #477's bootstrap fix) legitimately bumps create-hogsend a
    // PATCH ahead of the engine, and strict `c === e` then rejected that — the
    // Version PR AND every later PR's Release-integrity run failed on
    // create-hogsend being ahead, wedging the whole pipeline (there is no way
    // to cut a create-hogsend-only patch without tripping it). So: same
    // major.minor as engine, and never LAGGING engine's patch within the line
    // (that would be a stale scaffold). Being a patch AHEAD on the same minor
    // is fine — the caret absorbs it and the next engine-line release re-levels.
    name: "create-hogsend tracks the engine version line",
    fn: () => {
      const e = engineVersion();
      const c = readJson("packages/create-hogsend/package.json").version;
      if (minorLine(c) === minorLine(e) && semverGte(c, e)) return null;
      return `create-hogsend@${c} is off the @hogsend/engine@${e} minor line — the scaffolder must share the engine's major.minor (it may sit a patch ahead, but never behind or on a different minor) so its ^{{ENGINE_VERSION}} pins resolve to the current engine; bump create-hogsend onto the line (see .claude/skills/release)`;
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
      const offenders = scanPackages(ENGINE_LINE, (pkg) => {
        const peers = Object.keys(pkg.peerDependencies || {}).filter((k) =>
          k.startsWith("@hogsend/"),
        );
        return peers.length
          ? [`${pkg.name} peerDeps: ${peers.join(", ")}`]
          : [];
      });
      return offenders.length === 0 ? null : offenders.join("; ");
    },
  },
  {
    // Packages that ship raw `.ts` source (main/types point straight at
    // `src/`, no build step emitting a `.d.ts` boundary — @hogsend/engine,
    // @hogsend/cli, ...) are type-checked by the CONSUMER's own `tsc`, deep
    // into node_modules. A `@types/*` package only in `devDependencies` never
    // installs for a consumer (devDeps don't propagate), so the moment
    // reachable source imports a runtime or peer dep whose types live in
    // `devDependencies`, every downstream consumer's `check-types` breaks the
    // next time it bumps past that release — while THIS repo's own
    // check-types stays green (its devDependency is right there). Hit by
    // @hogsend/engine's `qrcode` import (vanity-links/QR, #385): `hogsend
    // upgrade` broke pre-existing consumers even though CI was green.
    name: "raw-source packages keep @types/* alongside their base runtime or peer dep (not devDependencies)",
    fn: () => {
      const offenders = scanPackages(ENGINE_LINE, (pkg) => {
        const entry = pkg.types || pkg.main || "";
        const isRawSource = /\.tsx?$/.test(entry) && !entry.endsWith(".d.ts");
        if (!isRawSource) return [];
        const runtimeOrPeerDeps = new Set([
          ...Object.keys(pkg.dependencies || {}),
          ...Object.keys(pkg.peerDependencies || {}),
        ]);
        const bad = Object.keys(pkg.devDependencies || {}).filter(
          (k) =>
            k.startsWith("@types/") &&
            runtimeOrPeerDeps.has(k.slice("@types/".length)),
        );
        return bad.length ? [`${pkg.name}: ${bad.join(", ")}`] : [];
      });
      return offenders.length === 0
        ? null
        : `move to "dependencies" or "peerDependencies" (raw-source package, devDependencies never reach consumers): ${offenders.join("; ")}`;
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
      const errs = scanPackages([...ENGINE_LINE, "create-hogsend"], (pkg) => {
        const e = [];
        if (pkg.private)
          e.push(`${pkg.name} is private:true but should publish`);
        if (pkg.publishConfig?.access !== "public")
          e.push(`${pkg.name} missing publishConfig.access:public`);
        return e;
      });
      if (!readJson("apps/api/package.json").private)
        errs.push("@hogsend/api must be private");
      return errs.length === 0 ? null : errs.join("; ");
    },
  },
];

const COMPANION_FILE = "engine-line-uniform.md";
const COMPANION = `.changeset/${COMPANION_FILE}`;

/**
 * --fix-changeset: write (or refresh) the companion changeset that keeps the
 * engine version line uniform, so a contributor who authored a changeset
 * touching ONE engine-line package (e.g. `@hogsend/react`) doesn't have to
 * hand-list the other ~15 — the exact foot-gun that broke a release and the
 * "pending changesets keep the engine version line uniform" check catches.
 *
 * It reads the OTHER pending changesets (excluding the file it owns), finds the
 * highest bump type applied to any engine-line package, and emits
 * `.changeset/engine-line-uniform.md` raising every still-missing or
 * lower-ranked engine-line package PLUS `create-hogsend` to that level — the
 * minimal set that lands the whole line on one number under `changeset version`.
 * Idempotent (it owns that one filename) and self-correcting on bump-level
 * changes. No-op when nothing on the line is bumped, or it's already uniform.
 */
function fixChangeset() {
  const bumped = pendingChangesetBumps(COMPANION_FILE);
  const lineNames = ENGINE_LINE.map(
    (n) => readJson(`packages/${n}/package.json`).name,
  );
  let rank = 0;
  for (const n of lineNames) {
    const t = bumped.get(n);
    if (t && BUMP_RANK[t] > rank) rank = BUMP_RANK[t];
  }
  if (rank === 0) {
    console.log(
      "release-doctor --fix-changeset: no engine-line package is bumped by a pending changeset — author your fix changeset first, then re-run.",
    );
    return;
  }
  const type = RANK_BUMP[rank];
  const targets = [...lineNames, "create-hogsend"];
  const need = targets.filter((n) => {
    const t = bumped.get(n);
    return !t || BUMP_RANK[t] < rank;
  });
  if (need.length === 0) {
    console.log(
      `release-doctor --fix-changeset: engine line already uniform at ${type} across pending changesets — nothing to write.`,
    );
    return;
  }
  const body = `${[
    "---",
    ...need.map((n) => `"${n}": ${type}`),
    "---",
    "",
    "Keep the engine version line uniform: bump every engine-line package (and the",
    "`create-hogsend` scaffolder) alongside the change(s) above, so all `@hogsend/*`",
    "publish on one version and the scaffold's `^{{ENGINE_VERSION}}` caret pins stay",
    "aligned. Generated by `pnpm release-doctor --fix-changeset`.",
  ].join("\n")}\n`;
  writeFileSync(r(COMPANION), body);
  console.log(
    `release-doctor --fix-changeset: wrote ${COMPANION} (${need.length} package(s) @ ${type}). Run \`pnpm release-doctor\` to verify.`,
  );
}

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
} else if (process.argv.includes("--fix-changeset")) {
  fixChangeset();
} else {
  runChecks();
}
