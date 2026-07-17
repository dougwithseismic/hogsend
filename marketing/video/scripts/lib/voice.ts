import { createHash } from "node:crypto";
import type { CampaignManifest } from "../../src/videos/codex-campaign/campaign";

export type VoiceProvider = "openai" | "system";

export function resolveVoiceProvider(requested: VoiceProvider | undefined) {
  return requested ?? "openai";
}

export type VoiceSettings = {
  provider: VoiceProvider;
  model: string;
  voice: string;
  instructions: string;
};

type VoiceHashInput = VoiceSettings & { text: string };

export type VoiceClip = {
  id: string;
  from: number;
  durationInFrames: number;
  text: string;
  file: string;
  contentHash: string;
};

export type VoicePlan = VoiceSettings & {
  campaign: string;
  generatedAt: string | null;
  disclosure: string;
  clips: VoiceClip[];
};

export function voiceContentHash(input: VoiceHashInput) {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 16);
}

export function createVoicePlan(
  manifest: CampaignManifest,
  settings: VoiceSettings,
): VoicePlan {
  return {
    ...settings,
    campaign: manifest.id,
    generatedAt: null,
    disclosure: "This voice is synthetic and generated for a Hogsend demo.",
    clips: manifest.beats.map((beat) => ({
      id: beat.id,
      from: beat.from,
      durationInFrames: beat.durationInFrames,
      text: beat.voice,
      file: `audio/${manifest.id}/${beat.id}.mp3`,
      contentHash: voiceContentHash({ ...settings, text: beat.voice }),
    })),
  };
}
