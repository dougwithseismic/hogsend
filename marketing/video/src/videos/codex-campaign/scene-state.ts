import { easeOutCubic, progress } from "@hogsend/brand-media";
import { type CampaignBeatId, campaign } from "./campaign";

export type SceneState = {
  beat: CampaignBeatId;
  localFrame: number;
  lineProgress: number;
  thermalMix: number;
  thermalX: number;
  thermalY: number;
  glow: number;
};

export function getSceneState(frame: number): SceneState {
  const boundedFrame = Math.max(0, Math.min(campaign.durationInFrames, frame));
  const fallback = campaign.beats.at(-1);
  if (!fallback) throw new Error("Codex campaign needs at least one beat.");
  const active =
    campaign.beats.find(
      (beat) =>
        boundedFrame >= beat.from &&
        boundedFrame < beat.from + beat.durationInFrames,
    ) ?? fallback;
  const localFrame = boundedFrame - active.from;

  return {
    beat: active.id,
    localFrame,
    lineProgress: easeOutCubic(progress(boundedFrame, 0, 30)),
    thermalMix: 0.5 + Math.sin(boundedFrame / 45) * 0.5,
    thermalX: Math.sin(boundedFrame / 54) * 24,
    thermalY: Math.cos(boundedFrame / 70) * 14,
    glow: 0.72 + Math.sin(boundedFrame / 36) * 0.18,
  };
}
