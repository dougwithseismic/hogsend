import { join } from "node:path";

export type RenderFormat = "landscape" | "vertical" | "square";

const FORMATS = [
  ["landscape", "169"],
  ["vertical", "916"],
  ["square", "11"],
] as const satisfies readonly [RenderFormat, string][];

export function getDefaultOutputRoot(videoRoot: string, campaign: string) {
  return join(videoRoot, "..", "out", "videos", campaign);
}

export function getRenderJobs(outputRoot: string) {
  return FORMATS.map(([format, suffix]) => ({
    format,
    composition: `codex-campaign-${suffix}`,
    mp4: join(outputRoot, `codex-campaign-${format}.mp4`),
    webm: join(outputRoot, `codex-campaign-${format}.webm`),
    poster: join(outputRoot, `codex-campaign-${format}-poster.png`),
  }));
}
