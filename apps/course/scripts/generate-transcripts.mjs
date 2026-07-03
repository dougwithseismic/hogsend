// Bundles content/transcripts/<id>.md into lib/transcripts.generated.json —
// { [videoId]: string } — so the VideoTranscript block can render the on-page
// collapsible from committed data (no runtime fs read, no MDX-escaping of the
// caption text). Runs in the same prebuild/predev/check-types hook as the
// workbook manifest so it can't drift from the transcript files.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const transcriptsDir = join(appDir, "content/transcripts");
const outFile = join(appDir, "lib/transcripts.generated.json");

const map = {};
if (existsSync(transcriptsDir)) {
  for (const file of readdirSync(transcriptsDir).sort()) {
    if (!file.endsWith(".md")) continue;
    const id = file.replace(/\.md$/, "");
    map[id] = readFileSync(join(transcriptsDir, file), "utf8").trim();
  }
}

writeFileSync(outFile, `${JSON.stringify(map, null, 2)}\n`);
console.log(
  `transcripts manifest: ${Object.keys(map).length} transcript(s) -> ${outFile}`,
);
