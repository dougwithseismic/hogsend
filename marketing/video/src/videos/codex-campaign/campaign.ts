export type CampaignBeatId = "hook" | "build" | "ship" | "cta";

export type CampaignBeat = {
  id: CampaignBeatId;
  from: number;
  durationInFrames: number;
  caption: string;
  voice: string;
};

export type CampaignManifest = {
  id: "codex-campaign";
  fps: 30;
  durationInFrames: 450;
  beats: readonly CampaignBeat[];
};

export const campaign = {
  id: "codex-campaign",
  fps: 30,
  durationInFrames: 450,
  beats: [
    {
      id: "hook",
      from: 0,
      durationInFrames: 90,
      caption: "Stop chasing customers by hand.",
      voice: "Stop chasing customers by hand.",
    },
    {
      id: "build",
      from: 90,
      durationInFrames: 160,
      caption: "Tell Codex what should happen.",
      voice: "Tell Codex what should happen.",
    },
    {
      id: "ship",
      from: 250,
      durationInFrames: 140,
      caption:
        "It builds the marketing, tests every path, and ships it with your product.",
      voice:
        "It builds the marketing, tests every path, and ships it with your product.",
    },
    {
      id: "cta",
      from: 390,
      durationInFrames: 60,
      caption: "Build with Hogsend.",
      voice: "Build with Hogsend.",
    },
  ],
} as const satisfies CampaignManifest;

export function validateCampaign(manifest: CampaignManifest) {
  if (manifest.fps !== 30 || manifest.durationInFrames !== 450) {
    throw new Error("Campaign must be exactly 450 frames at 30fps.");
  }
  if (manifest.beats[0]?.from !== 0) {
    throw new Error("Campaign must start at frame 0.");
  }
  if ((manifest.beats[0]?.durationInFrames ?? Number.POSITIVE_INFINITY) > 90) {
    throw new Error("Campaign hook must finish by frame 90.");
  }

  let cursor = 0;
  for (const beat of manifest.beats) {
    if (beat.from !== cursor) {
      throw new Error(`Campaign has a gap or overlap at beat ${beat.id}.`);
    }
    if (!beat.caption.trim() || !beat.voice.trim()) {
      throw new Error(`Campaign beat ${beat.id} needs caption and voice copy.`);
    }
    cursor += beat.durationInFrames;
  }
  if (cursor !== manifest.durationInFrames) {
    throw new Error("Campaign beats must cover all 450 frames.");
  }
}
