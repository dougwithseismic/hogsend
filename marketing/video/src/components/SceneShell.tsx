import type React from "react";
import type { ReactNode } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { microDrift } from "../lib/anim";
import { useFormat } from "../lib/format";
import { theme } from "../lib/theme";
import { Aurora, DotGrid, Horizon, Noise } from "./Fx";

/**
 * The canvas every scene sits in, replicating the docs PageFrame: ink
 * background, two faint vertical gutter hairlines (never a closed box),
 * film-grain noise on top, an optional red aurora bloom and an optional
 * dot-grid backdrop (the docs CTA motif). `drift` adds the slow
 * 1.00→1.02 hold scale so nothing sits dead.
 *
 * On 9:16 the content area excludes the top/bottom ~12% platform-UI
 * bands automatically.
 */
export const SceneShell: React.FC<{
  children?: ReactNode;
  /** Red aurora bloom (docs GlowField atmosphere). */
  glow?: boolean;
  /** Where the bloom sits (docs hero horizon = "bottom"). */
  glowPosition?: "top" | "center" | "bottom";
  /** Animatable bloom strength (0–1); drive it from the beat. */
  glowIntensity?: number;
  /** Accent dot-grid backdrop behind the content (docs CTA). */
  dots?: boolean;
  /** The hero's red-rimmed planet rising from the bottom. */
  horizon?: boolean;
  /** Slow 1.00→1.02 scale on children across the hold. */
  drift?: boolean;
  /** Frames the drift spans (default 75). */
  driftFrames?: number;
  /** Override content alignment (defaults to centered). */
  justify?: "start" | "center" | "end";
  align?: "start" | "center" | "end";
}> = ({
  children,
  glow = false,
  glowPosition = "center",
  glowIntensity = 1,
  dots = false,
  horizon = false,
  drift = false,
  driftFrames = 75,
  justify = "center",
  align = "center",
}) => {
  const frame = useCurrentFrame();
  const f = useFormat();

  // Vertical hairlines sit halfway into the content gutter, like the
  // docs container edges. No top/bottom lines — the frame never closes.
  const lineInset = Math.round(f.pad * 0.5);
  const flexMap = {
    start: "flex-start",
    center: "center",
    end: "flex-end",
  } as const;

  return (
    <AbsoluteFill style={{ backgroundColor: theme.ink }}>
      {glow ? (
        <Aurora position={glowPosition} intensity={glowIntensity} />
      ) : null}
      {horizon ? <Horizon /> : null}
      {dots ? <DotGrid /> : null}
      {(["left", "right"] as const).map((side) => (
        <div
          key={side}
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            [side]: lineInset,
            width: 1,
            backgroundColor: theme.frameLine,
            pointerEvents: "none",
          }}
        />
      ))}
      <AbsoluteFill
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: flexMap[justify],
          alignItems: flexMap[align],
          paddingLeft: f.pad,
          paddingRight: f.pad,
          paddingTop: f.pad + f.safeTop,
          paddingBottom: f.pad + f.safeBottom,
        }}
      >
        <div
          style={{
            transform: drift
              ? `scale(${microDrift(frame, driftFrames)})`
              : undefined,
            display: "flex",
            flexDirection: "column",
            alignItems: flexMap[align],
            maxWidth: "100%",
          }}
        >
          {children}
        </div>
      </AbsoluteFill>
      <Noise />
    </AbsoluteFill>
  );
};
