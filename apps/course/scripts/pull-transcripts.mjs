// Pulls YouTube auto-captions for the course's embedded videos and writes a
// clean, readable transcript per video to content/transcripts/<id>.md — the
// raw material for each "watch & digest" atom (the on-page collapsible
// transcript is generated from these by generate-transcripts.mjs).
//
// Usage:
//   node scripts/pull-transcripts.mjs               # scan content, pull any MISSING
//   node scripts/pull-transcripts.mjs <id> [<id>…]  # pull these ids (re-pull ok)
//   node scripts/pull-transcripts.mjs --all         # re-pull every video found
//
// Requires yt-dlp on PATH. External YouTube can rate-limit (HTTP 429), so we
// throttle between videos; a failure on one id is logged and skipped, never
// fatal — re-run to fill gaps.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coursesDir = join(appDir, "content/courses");
const outDir = join(appDir, "content/transcripts");

/** VTT (incl. YouTube auto-caption) → clean prose. Drops timing/index/tags and
 *  the rolling-caption duplication, then paragraphs on sentence ends. */
function cleanVtt(vtt) {
  const out = [];
  let last = "";
  for (let line of vtt.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/^(WEBVTT|Kind:|Language:|NOTE)/.test(line)) continue;
    if (line.includes("-->")) continue; // cue timing
    if (/^\d+$/.test(line.trim())) continue; // cue index
    line = line
      .replace(/<[^>]+>/g, "") // inline <00:00:00.000><c> tags
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<")
      .replace(/&#39;/g, "'")
      .trim();
    if (!line) continue;
    if (line === last) continue; // exact rolling dup
    if (last?.endsWith(line)) continue; // partial rolling dup
    out.push(line);
    last = line;
  }
  const text = out.join(" ").replace(/\s+/g, " ").trim();

  // Paragraph on sentence boundaries so the collapsible reads, not walls.
  const paras = [];
  let buf = "";
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    buf += (buf ? " " : "") + sentence;
    if (buf.split(/\s+/).length >= 55) {
      paras.push(buf);
      buf = "";
    }
  }
  if (buf) paras.push(buf);
  return paras.join("\n\n");
}

/** Every distinct YouTube id referenced by the course MDX (VideoEmbed id=… and
 *  youtube="…https://youtu.be/ID" attribute forms). */
function scanVideoIds() {
  const ids = new Set();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        walk(p);
      } else if (name.endsWith(".mdx")) {
        const src = readFileSync(p, "utf8");
        for (const m of src.matchAll(/<VideoEmbed[^>]*\sid="([\w-]{11})"/g)) {
          ids.add(m[1]);
        }
        for (const m of src.matchAll(
          /youtube="[^"]*(?:youtu\.be\/|v=)([\w-]{11})/g,
        )) {
          ids.add(m[1]);
        }
      }
    }
  };
  walk(coursesDir);
  return [...ids];
}

function pull(id, tmp) {
  execFileSync(
    "yt-dlp",
    [
      "--skip-download",
      "--write-auto-sub",
      "--write-sub",
      "--sub-lang",
      "en",
      "--sub-format",
      "vtt",
      "--sleep-requests",
      "1",
      "-o",
      join(tmp, "%(id)s.%(ext)s"),
      `https://www.youtube.com/watch?v=${id}`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  // Prefer human-authored en.vtt; fall back to any en* variant yt-dlp wrote.
  const files = readdirSync(tmp).filter(
    (f) => f.startsWith(id) && f.endsWith(".vtt"),
  );
  const chosen =
    files.find((f) => f === `${id}.en.vtt`) ??
    files.find((f) => f.includes(".en")) ??
    files[0];
  if (!chosen) throw new Error("no captions");
  return cleanVtt(readFileSync(join(tmp, chosen), "utf8"));
}

const args = process.argv.slice(2);
const all = args.includes("--all");
const explicit = args.filter((a) => !a.startsWith("--"));

mkdirSync(outDir, { recursive: true });
const targets =
  explicit.length > 0
    ? explicit
    : scanVideoIds().filter(
        (id) => all || !existsSync(join(outDir, `${id}.md`)),
      );

if (targets.length === 0) {
  console.log(
    "transcripts: nothing to pull (all present; use --all to refresh)",
  );
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), "hs-transcripts-"));
let ok = 0;
const failed = [];
try {
  for (const id of targets) {
    try {
      const text = pull(id, tmp);
      const words = text.split(/\s+/).length;
      writeFileSync(join(outDir, `${id}.md`), `${text}\n`);
      console.log(`  ✓ ${id} (${words} words)`);
      ok += 1;
    } catch (err) {
      failed.push(id);
      console.log(`  ✗ ${id} — ${String(err.message || err).split("\n")[0]}`);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(
  `transcripts: ${ok}/${targets.length} pulled -> ${outDir}` +
    (failed.length ? ` (failed: ${failed.join(", ")} — re-run to retry)` : ""),
);
