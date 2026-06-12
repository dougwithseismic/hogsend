import type React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { useFormat } from "../lib/format";

/**
 * Atmospheric primitives ported from the docs site (components/ds/fx.tsx
 * + global.css). These are the texture layer that makes the ink read as
 * "the Hogsend site", not a black slide: film grain, the red aurora
 * bloom, and the dot grid behind CTAs.
 */

// ---------------------------------------------------------------------------
// Noise — the docs `.noise` overlay: SVG fractal turbulence at ~3% opacity.
// Deterministic (the SVG is static), tiled across the frame, mounted on top
// of everything inside SceneShell.
// ---------------------------------------------------------------------------

const NOISE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="250" height="250"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>`;
const NOISE_URI = `data:image/svg+xml,${encodeURIComponent(NOISE_SVG)}`;

export const Noise: React.FC<{ opacity?: number }> = ({ opacity = 0.035 }) => (
  <AbsoluteFill
    style={{
      backgroundImage: `url("${NOISE_URI}")`,
      backgroundRepeat: "repeat",
      opacity,
      pointerEvents: "none",
    }}
  />
);

// ---------------------------------------------------------------------------
// Aurora — the docs GlowField atmosphere bloom, with its slow breathing
// pulse (10s period on the site → 300 frames here).
// ---------------------------------------------------------------------------

export const Aurora: React.FC<{
  /** Vertical anchor of the bloom. "bottom" is the docs hero horizon. */
  position?: "top" | "center" | "bottom";
  /** Multiplies the layer opacity (default 1). */
  intensity?: number;
  /** Disable the breathing pulse (it's subtle; on by default). */
  breathe?: boolean;
}> = ({ position = "bottom", intensity = 1, breathe = true }) => {
  const frame = useCurrentFrame();
  const y = position === "top" ? "16%" : position === "center" ? "50%" : "80%";
  // Docs: opacity 0.75 → 1 → 0.75 over 10s, easeInOut.
  const pulse = breathe
    ? 0.875 - 0.125 * Math.cos((frame / 300) * Math.PI * 2)
    : 1;
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(85% 60% at 50% ${y}, rgba(246,72,56,0.3), rgba(246,72,56,0.08) 45%, transparent 72%)`,
        filter: "blur(28px)",
        opacity: pulse * intensity,
        pointerEvents: "none",
      }}
    />
  );
};

// ---------------------------------------------------------------------------
// Horizon — the hero's planet: a huge ink circle rising from below with a
// red rim-light (docs GlowField planet, exact shadow stack).
// ---------------------------------------------------------------------------

export const Horizon: React.FC<{ intensity?: number }> = ({
  intensity = 1,
}) => {
  const f = useFormat();
  const planetW = f.width * 1.75;
  return (
    <AbsoluteFill style={{ overflow: "hidden", pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "62%",
          transform: "translateX(-50%)",
          width: planetW,
          height: planetW,
          borderRadius: "50%",
          backgroundColor: "#050101",
          boxShadow: `0 -2px 18px rgba(246,72,56,${
            0.9 * intensity
          }), 0 -16px 70px rgba(246,72,56,${
            0.55 * intensity
          }), 0 -70px 200px rgba(246,72,56,${
            0.28 * intensity
          }), inset 0 22px 70px rgba(246,72,56,${0.35 * intensity})`,
        }}
      />
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// DotGrid — the docs `.dot-grid` CTA backdrop: 1px accent dots on a 28px
// grid, faded out radially so it never reaches the edges.
// ---------------------------------------------------------------------------

export const DotGrid: React.FC<{ opacity?: number }> = ({ opacity = 1 }) => {
  const f = useFormat();
  const spacing = Math.round(36 * f.fontScale * (f.isPortrait ? 1.2 : 1));
  const mask = "radial-gradient(60% 60% at 50% 50%, #000 0%, transparent 75%)";
  return (
    <AbsoluteFill
      style={{
        backgroundImage:
          "radial-gradient(rgba(246,72,56,0.45) 2px, transparent 2px)",
        backgroundSize: `${spacing}px ${spacing}px`,
        backgroundPosition: "center",
        WebkitMaskImage: mask,
        maskImage: mask,
        opacity,
        pointerEvents: "none",
      }}
    />
  );
};
