import type React from "react";
import type { ReactNode } from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { EmailCard } from "../../components/EmailCard";
import { EndCard } from "../../components/EndCard";
import { FlowDiagram } from "../../components/FlowDiagram";
import { KineticText } from "../../components/KineticText";
import { Kicker } from "../../components/Labels";
import { SceneShell } from "../../components/SceneShell";
import { FONT_MONO } from "../../fonts";
import {
  Beats,
  beat,
  pop,
  punchIn,
  slideUp,
  totalFrames,
} from "../../lib/anim";
import { defineVideo, type VideoProps } from "../../lib/define-video";
import { useFormat } from "../../lib/format";
import { theme } from "../../lib/theme";

// ---------------------------------------------------------------------------
// The AARRR funnel — one email at every lifecycle stage, each firing an
// event back to PostHog. A five-node spine; the pulse advances one node per
// beat, and the matching email pops in beside it.
// ---------------------------------------------------------------------------

const STAGES = [
  { label: "Acquisition", subject: "Welcome to Acme" },
  { label: "Activation", subject: "You're set up — here's your first win" },
  { label: "Retention", subject: "We saved your spot" },
  { label: "Referral", subject: "Know someone who'd love this?" },
  { label: "Revenue", subject: "Your trial ends in 3 days" },
] as const;

const SPINE = STAGES.map((s) => ({ label: s.label }));

// Per-hop frames for the spine pulse. Small enough that by the active node
// the pulse has arrived early in each beat, leaving the rest of the beat to
// hold on the lit stage + its email.
const HOP = 8;

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/** Beat-change punch-in wrapper (scale 1.04→1.00). */
const Punch: React.FC<{ children: ReactNode }> = ({ children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div
      style={{
        transform: `scale(${punchIn(frame, fps)})`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        width: "100%",
      }}
    >
      {children}
    </div>
  );
};

/**
 * The "→ PostHog" fanout chip — the event each stage email fans back to the
 * warehouse. Pops in after the email has landed.
 */
const FanoutChip: React.FC<{ delay: number }> = ({ delay }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();
  const s = f.fontScale;
  const a = slideUp(frame, fps, delay, 14);
  return (
    <div
      style={{
        opacity: a.opacity,
        transform: `translateY(${a.translateY}px)`,
        display: "inline-flex",
        alignItems: "center",
        gap: 10 * s,
        fontFamily: FONT_MONO,
        fontSize: 20 * s,
        color: theme.textBody,
        backgroundColor: theme.chipFill,
        border: `1px solid ${theme.hairlineFaint}`,
        borderRadius: 999,
        padding: `${10 * s}px ${20 * s}px`,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ color: theme.accent }}>→</span>
      PostHog
    </div>
  );
};

/**
 * One lifecycle stage: the persistent five-node spine with the pulse
 * advancing to this stage's node, the stage email popping in beside it, and
 * the "→ PostHog" fanout chip confirming the event went back out.
 */
const StageBeat: React.FC<{ index: number; subject: string }> = ({
  index,
  subject,
}) => {
  const f = useFormat();
  const s = f.fontScale;

  // Pulse leaves node 0 a few frames in and lands on the active node early,
  // so the spine reads as "advancing one node" then holds lit for the email.
  const pulseStart = 4;
  const arrival = pulseStart + index * HOP;
  // The email lands just after the pulse reaches this stage's node.
  const emailDelay = arrival + 6;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: f.isPortrait ? "column" : "row",
        alignItems: "center",
        justifyContent: "center",
        gap: f.isPortrait ? 48 * s : 80 * s,
        width: "100%",
      }}
    >
      <FlowDiagram
        nodes={SPINE}
        pulseStart={pulseStart}
        hopFrames={HOP}
        scale={f.isPortrait ? 0.66 : 0.82}
      />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: f.isPortrait ? "center" : "flex-start",
          gap: 18 * s,
          width: f.isPortrait ? "100%" : Math.min(f.width * 0.4, 700),
        }}
      >
        <EmailCardWrap delay={emailDelay}>
          <EmailCard
            subject={subject}
            from="Acme <hello@acme.com>"
            width="100%"
          />
        </EmailCardWrap>
        <FanoutChip delay={emailDelay + 12} />
      </div>
    </div>
  );
};

/**
 * Holds the email hidden until its delay, so the spine pulse reads first and
 * the email is a clean spring-pop entrance (EmailCard's own slide starts at
 * its own frame 0, so we gate the mount with opacity + a pop-scale).
 */
const EmailCardWrap: React.FC<{ delay: number; children: ReactNode }> = ({
  delay,
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = pop(frame, fps, delay);
  const live = frame >= delay;
  return (
    <div
      style={{
        width: "100%",
        opacity: live ? p : 0,
        transform: `scale(${live ? interpolate(p, [0, 1], [0.96, 1]) : 0.96})`,
        transformOrigin: "left center",
      }}
    >
      {children}
    </div>
  );
};

// ---------------------------------------------------------------------------
// The video
// ---------------------------------------------------------------------------

const STAGE_FRAMES = 66;

const beats = [
  beat("intro", 60, () => (
    <SceneShell glow drift>
      <Punch>
        <Kicker text="Lifecycle" delay={2} />
        <div style={{ height: 28 }} />
        <KineticText text="An email at every stage" size="md" delay={8} />
      </Punch>
    </SceneShell>
  )),
  ...STAGES.map((stage, i) =>
    beat(`stage-${stage.label.toLowerCase()}`, STAGE_FRAMES, () => (
      <SceneShell drift driftFrames={STAGE_FRAMES}>
        <Punch>
          <StageBeat index={i} subject={stage.subject} />
        </Punch>
      </SceneShell>
    )),
  ),
  beat("end", 60, () => (
    <SceneShell glow glowPosition="bottom" dots>
      <EndCard
        line="Lifecycle email, as code."
        command="pnpm dlx create-hogsend@latest"
        domain="hogsend.com"
      />
    </SceneShell>
  )),
];

const DURATION = totalFrames(beats);
// Asserted budget: 60 (intro) + 5 × 66 (stages) + 60 (end) = 450.
if (DURATION !== 450) {
  throw new Error(`aarrr-lifecycle-map: expected 450 frames, got ${DURATION}`);
}

const AarrrLifecycleMap: React.FC<VideoProps> = () => <Beats beats={beats} />;

export const video = defineVideo({
  id: "aarrr-lifecycle-map",
  durationInFrames: DURATION,
  fps: 30,
  component: AarrrLifecycleMap,
});
