import {
  BrandFrame,
  type BrandTemplatePresetKey,
  getBrandTemplateGeometry,
} from "@hogsend/brand-media";
import type React from "react";
import type { ReactNode } from "react";
import {
  Audio,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { defineVideo, type VideoProps } from "../../lib/define-video";
import { campaign, validateCampaign } from "./campaign";
import { CAMPAIGN_SHOTS, type CampaignShot } from "./edit";
import { impactFlash } from "./motion";
import { KineticShot } from "./shots";

validateCampaign(campaign);

const presetForSize = (
  width: number,
  height: number,
): BrandTemplatePresetKey =>
  height > width
    ? "story"
    : height === width
      ? "social-square"
      : "stream-screen";

const CampaignShell: React.FC<{
  shot: CampaignShot;
  children: ReactNode;
}> = ({ shot, children }) => {
  const localFrame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const preset = presetForSize(width, height);
  const geometry = getBrandTemplateGeometry(preset);
  const globalFrame = shot.from + localFrame;
  const flash = impactFlash(localFrame);
  const shortEdge = Math.min(width, height);

  return (
    <BrandFrame
      preset={preset}
      treatment="signed"
      palette="default"
      resolveAsset={(path) => staticFile(path.replace(/^\//, ""))}
      motion={{
        lineProgress: Math.min(1, globalFrame / 10),
        thermalMix: Math.max(
          0,
          Math.min(1, 0.5 + Math.sin(globalFrame / 17) * 0.34 + flash * 0.2),
        ),
        thermalX: Math.sin(globalFrame / 19) * 34,
        thermalY: Math.cos(globalFrame / 23) * 20,
        glow: Math.min(1, 0.68 + flash * 0.32),
      }}
    >
      <div
        style={{
          position: "absolute",
          zIndex: 10,
          left: geometry.safeX,
          top: geometry.contentY,
          width: geometry.safeWidth,
          height: geometry.contentHeight,
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          padding: Math.max(24, shortEdge * 0.035),
        }}
      >
        {children}
      </div>
      {flash > 0 ? (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            zIndex: 8,
            inset: 0,
            background: "rgba(246,72,56,0.18)",
            mixBlendMode: "screen",
            opacity: flash,
          }}
        />
      ) : null}
    </BrandFrame>
  );
};

const VoiceTrack: React.FC = () => (
  <>
    {campaign.beats.map((beat) => (
      <Sequence
        key={beat.id}
        from={beat.from}
        durationInFrames={beat.durationInFrames}
        name={`Voice · ${beat.id}`}
      >
        <Audio src={staticFile(`audio/${campaign.id}/${beat.id}.mp3`)} />
      </Sequence>
    ))}
  </>
);

const CodexCampaign: React.FC<VideoProps> = ({ voice = false }) => (
  <>
    {CAMPAIGN_SHOTS.map((shot, index) => (
      <Sequence
        key={shot.id}
        from={shot.from}
        durationInFrames={shot.to - shot.from}
        name={`${String(index + 1).padStart(2, "0")} · ${shot.id}`}
      >
        <CampaignShell shot={shot}>
          <KineticShot shot={shot} index={index} />
        </CampaignShell>
      </Sequence>
    ))}
    {voice ? <VoiceTrack /> : null}
  </>
);

export const video = defineVideo({
  id: campaign.id,
  durationInFrames: campaign.durationInFrames,
  fps: campaign.fps,
  component: CodexCampaign,
});
