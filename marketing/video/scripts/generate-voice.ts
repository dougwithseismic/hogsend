import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { campaign } from "../src/videos/codex-campaign/campaign";
import {
  createVoicePlan,
  resolveVoiceProvider,
  type VoicePlan,
  type VoiceProvider,
} from "./lib/voice";

const here = dirname(fileURLToPath(import.meta.url));
const videoRoot = resolve(here, "..");
const args = new Set(process.argv.slice(2));
const valueAfter = (flag: string) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
};
const requestedProvider = valueAfter("--provider") as VoiceProvider | undefined;
const provider = resolveVoiceProvider(requestedProvider);
if (provider !== "openai" && provider !== "system") {
  throw new Error("--provider must be openai or system");
}

const settings =
  provider === "openai"
    ? {
        provider,
        model: process.env.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts",
        voice: valueAfter("--voice") ?? process.env.OPENAI_TTS_VOICE ?? "marin",
        instructions:
          "Confident product builder. Direct, warm, brisk, and natural. No announcer voice.",
      }
    : {
        provider,
        model: "macos-say",
        voice:
          valueAfter("--voice") ?? process.env.SYSTEM_TTS_VOICE ?? "Daniel",
        instructions: "Confident product builder at a brisk, natural pace.",
      };

const plan = createVoicePlan(campaign, settings);
const outputDir = join(videoRoot, "public", "audio", campaign.id);
const manifestPath = join(outputDir, "manifest.json");
mkdirSync(outputDir, { recursive: true });

let previous: VoicePlan | undefined;
if (existsSync(manifestPath)) {
  previous = JSON.parse(readFileSync(manifestPath, "utf8")) as VoicePlan;
}

const openai = provider === "openai" ? new OpenAI() : undefined;

for (const clip of plan.clips) {
  const outputPath = join(videoRoot, "public", clip.file);
  const previousClip = previous?.clips.find(
    (candidate) => candidate.id === clip.id,
  );
  if (
    !args.has("--force") &&
    existsSync(outputPath) &&
    previousClip?.contentHash === clip.contentHash
  ) {
    console.log(`voice cache hit: ${clip.id}`);
    continue;
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  if (provider === "openai") {
    if (!process.env.OPENAI_API_KEY || !openai) {
      throw new Error("OPENAI_API_KEY is required for --provider openai");
    }
    const response = await openai.audio.speech.create({
      model: settings.model,
      voice: settings.voice as "marin",
      input: clip.text,
      instructions: settings.instructions,
      response_format: "mp3",
    });
    writeFileSync(outputPath, Buffer.from(await response.arrayBuffer()));
  } else {
    const aiffPath = `${outputPath}.aiff`;
    execFileSync("say", [
      "-v",
      settings.voice,
      "-r",
      process.env.SYSTEM_TTS_RATE ?? "205",
      "-o",
      aiffPath,
      clip.text,
    ]);
    execFileSync("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-i",
      aiffPath,
      "-codec:a",
      "libmp3lame",
      "-q:a",
      "2",
      outputPath,
    ]);
    rmSync(aiffPath, { force: true });
  }
  console.log(`voice generated: ${clip.id}`);
}

writeFileSync(
  manifestPath,
  `${JSON.stringify({ ...plan, generatedAt: new Date().toISOString() }, null, 2)}\n`,
);
console.log(`voice manifest: ${manifestPath}`);
