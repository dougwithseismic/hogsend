// One-shot uploader for rendered marketing clips → the private Tigris/S3
// bucket that apps/docs/app/api/clips/[key]/route.ts streams from.
//
// The read route SigV4-signs `GET ${CLIPS_S3_HOST}/${key}`; this mirrors it
// with SigV4 PUTs of the same object names, so a clip "exists" on the site the
// moment its `<id>-169.mp4` + `<id>-poster.jpg` land here.
//
// Usage (creds are read from apps/docs/.env.local, or the ambient env):
//   node marketing/video/scripts/upload-clips.mjs <file> [<file> ...]
//   node marketing/video/scripts/upload-clips.mjs --all-discord
//
// The object key is the basename of each file (e.g. discord-welcome-169.mp4),
// which is exactly what <ClipVideo clip="discord-welcome" /> requests.

import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { AwsClient } from "aws4fetch";

const ROOT = resolve(import.meta.dirname, "../../..");
const RENDERS = resolve(ROOT, "marketing/renders/clips");

const DISCORD_FILES = [
  "discord-welcome-169.mp4",
  "discord-welcome-poster.jpg",
  "discord-link-169.mp4",
  "discord-link-poster.jpg",
].map((f) => resolve(RENDERS, f));

const CONTENT_TYPE = {
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

// Load CLIPS_S3_* from apps/docs/.env.local without a dotenv dep.
async function loadEnv() {
  const out = { ...process.env };
  try {
    const raw = await readFile(resolve(ROOT, "apps/docs/.env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let [, k, v] = m;
      v = v.replace(/^["']|["']$/g, "");
      if (out[k] === undefined) out[k] = v;
    }
  } catch {
    // ambient env only
  }
  return out;
}

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i).toLowerCase();
}

async function main() {
  const args = process.argv.slice(2);
  const files = args.includes("--all-discord")
    ? DISCORD_FILES
    : args.map((a) => resolve(process.cwd(), a));

  if (files.length === 0) {
    console.error("Usage: node upload-clips.mjs <file> ... | --all-discord");
    process.exit(2);
  }

  const env = await loadEnv();
  const host = env.CLIPS_S3_HOST;
  const accessKeyId = env.CLIPS_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.CLIPS_S3_SECRET_ACCESS_KEY;
  if (!(host && accessKeyId && secretAccessKey)) {
    console.error(
      "Missing CLIPS_S3_HOST / CLIPS_S3_ACCESS_KEY_ID / CLIPS_S3_SECRET_ACCESS_KEY",
    );
    process.exit(1);
  }

  const aws = new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: "s3",
    region: "auto",
  });

  let failed = 0;
  for (const path of files) {
    const key = basename(path);
    const ext = extOf(key);
    const contentType = CONTENT_TYPE[ext] ?? "application/octet-stream";
    let body;
    try {
      body = await readFile(path);
    } catch (e) {
      console.error(`SKIP  ${key}  (cannot read ${path}: ${e.message})`);
      failed++;
      continue;
    }
    const res = await aws.fetch(`${host}/${key}`, {
      method: "PUT",
      headers: {
        "content-type": contentType,
        "content-length": String(body.length),
        "cache-control": "public, max-age=31536000, immutable",
      },
      body,
    });
    if (res.ok) {
      console.log(
        `OK    ${key}  (${(body.length / 1e6).toFixed(2)} MB, ${contentType})`,
      );
    } else {
      const text = await res.text().catch(() => "");
      console.error(
        `FAIL  ${key}  HTTP ${res.status} ${res.statusText}\n${text.slice(0, 500)}`,
      );
      failed++;
    }
  }

  if (failed) {
    console.error(`\n${failed} upload(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll uploads succeeded.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
