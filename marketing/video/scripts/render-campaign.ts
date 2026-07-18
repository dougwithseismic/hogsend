import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { campaign } from "../src/videos/codex-campaign/campaign";
import {
  getDefaultOutputRoot,
  getRenderJobs,
  type RenderFormat,
} from "./lib/output";

const here = dirname(fileURLToPath(import.meta.url));
const videoRoot = resolve(here, "..");
const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const valueAfter = (flag: string) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const requested = valueAfter("--format") ?? "all";
if (!["all", "landscape", "vertical", "square"].includes(requested)) {
  throw new Error("--format must be all, landscape, vertical, or square");
}

const outputRoot =
  valueAfter("--output") ?? getDefaultOutputRoot(videoRoot, campaign.id);
mkdirSync(outputRoot, { recursive: true });

const voice = has("--voice");
if (voice) {
  for (const beat of campaign.beats) {
    const path = resolve(
      videoRoot,
      "public",
      "audio",
      campaign.id,
      `${beat.id}.mp3`,
    );
    if (!existsSync(path)) {
      throw new Error(
        `Missing ${path}. Run pnpm --filter marketing-video voice:generate first.`,
      );
    }
  }
}

const jobs = getRenderJobs(outputRoot).filter(
  (job) => requested === "all" || job.format === requested,
);
const entry = "src/entries/codex-campaign.ts";
const props = JSON.stringify({ voice });
const runRemotion = (command: "render" | "still", commandArgs: string[]) => {
  execFileSync(
    "pnpm",
    ["exec", "remotion", command, entry, ...commandArgs, "--log=error"],
    { cwd: videoRoot, stdio: "inherit" },
  );
};

for (const job of jobs) {
  console.log(`rendering ${job.format} mp4`);
  const common = [job.composition, "--props", props];
  runRemotion("render", [
    ...common,
    job.mp4,
    "--codec=h264",
    ...(has("--draft") ? ["--scale=0.5"] : []),
  ]);
  if (has("--webm")) {
    console.log(`rendering ${job.format} webm`);
    runRemotion("render", [
      ...common,
      job.webm,
      "--codec=vp8",
      ...(has("--draft") ? ["--scale=0.5"] : []),
    ]);
  }
  runRemotion("still", [
    job.composition,
    job.poster,
    "--frame=45",
    "--props",
    props,
    ...(has("--draft") ? ["--scale=0.5"] : []),
  ]);
}

const dimensions: Record<RenderFormat, [number, number]> = {
  landscape: [1920, 1080],
  vertical: [1080, 1920],
  square: [1080, 1080],
};
const rendered = jobs.map((job) => ({
  format: job.format,
  composition: job.composition,
  width: dimensions[job.format][0],
  height: dimensions[job.format][1],
  fps: campaign.fps,
  durationInFrames: campaign.durationInFrames,
  durationSeconds: campaign.durationInFrames / campaign.fps,
  voice,
  files: {
    mp4: job.mp4,
    mp4Bytes: statSync(job.mp4).size,
    webm: has("--webm") ? job.webm : null,
    webmBytes: has("--webm") ? statSync(job.webm).size : null,
    poster: job.poster,
  },
}));
writeFileSync(
  resolve(outputRoot, "manifest.json"),
  `${JSON.stringify({ campaign: campaign.id, renderedAt: new Date().toISOString(), rendered }, null, 2)}\n`,
);
console.log(`renders ready: ${outputRoot}`);
