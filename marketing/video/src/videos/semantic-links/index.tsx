import type React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { EndCard } from "../../components/EndCard";
import { KineticText } from "../../components/KineticText";
import { SceneShell } from "../../components/SceneShell";
import { Beats, beat, punchIn } from "../../lib/anim";
import { defineVideo, type VideoProps } from "../../lib/define-video";
import { useFormat } from "../../lib/format";
import { AnswerEmail } from "./AnswerEmail";
import { BranchCode } from "./BranchCode";

/**
 * semantic-links — 12s · 360 frames · 6 script beats.
 * A link click is a typed answer — every button in an email becomes an
 * event your journey branches on.
 *
 * Script beats 2+3 (email in, then click + event chip) are one
 * continuous 120-frame scene so the cursor stays unbroken; its internal
 * timings land exactly on the script's frame boundaries.
 */

const CodeBeat: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <SceneShell drift driftFrames={60}>
      <div style={{ transform: `scale(${punchIn(frame, fps)})` }}>
        <BranchCode />
      </div>
    </SceneShell>
  );
};

const TagBeat: React.FC = () => {
  const f = useFormat();
  return (
    <SceneShell glow drift>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          rowGap: 10 * f.fontScale,
        }}
      >
        <KineticText
          text="Every click in an email becomes"
          size="md"
          delay={2}
          stagger={2}
          maxWidth="none"
        />
        <KineticText
          text="an *event* your journey can branch on."
          size="md"
          delay={16}
          stagger={2}
          maxWidth="none"
        />
      </div>
    </SceneShell>
  );
};

const SemanticLinks: React.FC<VideoProps> = () => {
  return (
    <Beats
      beats={[
        // 0–59 · hook
        beat("hook", 60, () => (
          <SceneShell glow drift>
            <KineticText
              text="A click is a typed *answer*."
              size="lg"
              delay={4}
              maxWidth="none"
            />
          </SceneShell>
        )),
        // 60–179 · email in (60–119) + click → event chip (120–179)
        beat("email", 120, () => (
          <SceneShell drift driftFrames={120}>
            <AnswerEmail />
          </SceneShell>
        )),
        // 180–239 · the journey branches on the answer
        beat("code", 60, () => <CodeBeat />),
        // 240–299 · the tag
        beat("tag", 60, () => <TagBeat />),
        // 300–359 · standard end card
        beat("end", 60, () => (
          <SceneShell glow>
            <EndCard line="Lifecycle email, shipped like a feature." />
          </SceneShell>
        )),
      ]}
    />
  );
};

export const video = defineVideo({
  id: "semantic-links",
  durationInFrames: 360,
  fps: 30,
  component: SemanticLinks,
});
