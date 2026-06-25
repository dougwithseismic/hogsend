#!/usr/bin/env node
/**
 * release-check — answer "will my work be in the next release?" at a glance.
 *
 *   pnpm release:check
 *
 * A read-only, non-blocking companion to `release-doctor` (which ENFORCES the
 * version-line invariants). This one just REPORTS, so before you merge the
 * "Version Packages" PR you can see exactly what that release will publish and
 * whether any in-flight work would be left out.
 *
 * It prints:
 *   - the engine-line version on this branch + what's published on npm,
 *   - the changesets pending on this branch (what the NEXT release will ship)
 *     and the version they bump to,
 *   - the open "Version Packages" PR (if any) — merging it is the publish,
 *   - open PRs that carry a changeset but are NOT merged yet — their work will
 *     NOT be in the next release until you merge them to main first.
 *
 * The npm + GitHub lookups are best-effort: if `npm`/`gh` are missing or
 * unauthed, those lines degrade to a note instead of failing.
 *
 * Pure node:fs + child_process, zero deps. Run from anywhere.
 */
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const r = (p) => join(ROOT, p);
const readJson = (p) => JSON.parse(readFileSync(r(p), "utf8"));

const RANK = { patch: 1, minor: 2, major: 3 };
const RANK_NAME = { 1: "patch", 2: "minor", 3: "major" };

function bumpVersion(v, level) {
  const [maj, min, pat] = v.split(".").map(Number);
  if (level === "major") return `${maj + 1}.0.0`;
  if (level === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

/** Parse a changeset .md → { bumps:[{pkg,level}], summary }. */
function parseChangeset(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return null;
  const bumps = [
    ...m[1].matchAll(/["']?(@?[\w/-]+)["']?\s*:\s*(major|minor|patch)/g),
  ].map((x) => ({ pkg: x[1], level: x[2] }));
  const summary =
    (m[2] || "")
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  return { bumps, summary };
}

/** Pending changesets on this branch (excludes README/config). */
function pendingChangesets() {
  let files;
  try {
    files = readdirSync(r(".changeset"));
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md")
    .map((f) => {
      const parsed = parseChangeset(readFileSync(r(`.changeset/${f}`), "utf8"));
      return parsed ? { file: f, ...parsed } : null;
    })
    .filter(Boolean);
}

function sh(cmd, timeout = 15000) {
  return execSync(cmd, {
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function npmVersion() {
  try {
    return sh("npm view @hogsend/engine version", 10000);
  } catch {
    return null;
  }
}

/** Open PRs and which of them add changeset files (best-effort via gh). */
function openPrs() {
  let prs;
  try {
    prs = JSON.parse(
      sh("gh pr list --state open --json number,title,headRefName --limit 50"),
    );
  } catch {
    return null; // gh missing / not authed → caller prints a soft note
  }
  const versionPr = prs.find(
    (p) =>
      /version packages/i.test(p.title) ||
      /changeset-release/.test(p.headRefName),
  );
  const withChangeset = [];
  for (const pr of prs) {
    if (pr === versionPr) continue;
    let names;
    try {
      names = sh(`gh pr diff ${pr.number} --name-only`);
    } catch {
      continue;
    }
    const cs = names
      .split("\n")
      .filter(
        (f) =>
          f.startsWith(".changeset/") &&
          f.endsWith(".md") &&
          !/readme/i.test(f),
      );
    if (cs.length) withChangeset.push({ ...pr, changesets: cs });
  }
  return { versionPr, withChangeset };
}

// ---------------------------------------------------------------------------

const branchVersion = readJson("packages/engine/package.json").version;
const pending = pendingChangesets();
const published = npmVersion();
const prs = openPrs();

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

const lines = [];
lines.push("");
lines.push(bold("📦 Release check — @hogsend/* engine line"));
lines.push("");

// Current state.
lines.push(
  `   On this branch:   ${bold(branchVersion)}   ${dim("(packages/engine/package.json)")}`,
);
if (published === null) {
  lines.push(`   Published on npm: ${dim("(npm lookup unavailable)")}`);
} else if (published === branchVersion) {
  lines.push(`   Published on npm: ${bold(published)}   ${green("✓ in sync")}`);
} else {
  lines.push(
    `   Published on npm: ${bold(published)}   ${yellow(`⚠ branch is ahead (a publish may be mid-flight)`)}`,
  );
}
lines.push("");

// What the next release ships.
if (pending.length === 0) {
  lines.push(
    `   ${dim("No pending changesets on this branch — nothing queued to release.")}`,
  );
  lines.push(
    `   ${dim("Merge a PR that carries a changeset to start the next release.")}`,
  );
} else {
  const maxRank = Math.max(
    ...pending.flatMap((c) => c.bumps.map((b) => RANK[b.level] ?? 0)),
    1,
  );
  const next = bumpVersion(branchVersion, RANK_NAME[maxRank]);
  lines.push(
    bold(
      `   Pending changesets → next release ${green(next)} (${RANK_NAME[maxRank]}):`,
    ),
  );
  for (const c of pending) {
    const lvl =
      RANK_NAME[Math.max(...c.bumps.map((b) => RANK[b.level] ?? 0), 1)];
    const sum =
      c.summary.length > 72 ? `${c.summary.slice(0, 69)}...` : c.summary;
    lines.push(`     • ${c.file}  ${dim(`[${lvl}]`)}  ${sum}`);
  }
}
lines.push("");

// Version Packages PR + in-flight work.
if (prs === null) {
  lines.push(
    `   ${dim("(GitHub lookup unavailable — install/auth `gh` to see the Version PR + open changeset PRs)")}`,
  );
} else {
  if (prs.versionPr) {
    lines.push(
      `   Version Packages PR: ${bold(`#${prs.versionPr.number}`)} is open — merging it ${bold("publishes")} the version above.`,
    );
  } else if (pending.length > 0) {
    lines.push(
      `   ${dim("No Version Packages PR open yet (the release workflow opens it shortly after a changeset lands on main).")}`,
    );
  }
  lines.push("");

  if (prs.withChangeset.length === 0) {
    lines.push(
      `   ${green("✓ No unmerged changeset PRs — the next release includes everything queued.")}`,
    );
  } else {
    lines.push(
      yellow(
        `   ⚠ Open PRs carry a changeset but are NOT merged — their work will NOT be in the next release:`,
      ),
    );
    for (const pr of prs.withChangeset) {
      lines.push(`     • #${pr.number}  ${pr.title}`);
    }
    lines.push("");
    lines.push(
      `   ${yellow("→ Merge these to main BEFORE merging the Version Packages PR to include them.")}`,
    );
  }
}
lines.push("");

process.stdout.write(`${lines.join("\n")}\n`);
