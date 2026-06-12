import type React from "react";
import {
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { FONT_BODY } from "../fonts";
import { pop } from "../lib/anim";
import { useFormat } from "../lib/format";
import { theme } from "../lib/theme";

export type FlowNode = {
  label?: string;
  /** Filename in public/logos (single-colour SVG, tinted white). */
  logo?: string;
};

/**
 * A chain of node chips joined by hairlines, with an accent pulse dot
 * travelling the path. Nodes pop as the pulse arrives. Horizontal on
 * 16:9 / 1:1, vertical on 9:16.
 *
 *   <FlowDiagram
 *     nodes={[{ logo: "posthog.svg" }, { label: "journey" }, { logo: "resend.svg" }]}
 *   />
 */
export const FlowDiagram: React.FC<{
  nodes: FlowNode[];
  /** Frame the pulse leaves node 0. */
  pulseStart?: number;
  /** Frames the pulse takes per hop. Default 18. */
  hopFrames?: number;
  /** Multiplies chip/gap/dot sizes (default 1). */
  scale?: number;
}> = ({ nodes, pulseStart = 8, hopFrames = 18, scale: sizeScale = 1 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();
  const s = f.fontScale * sizeScale;
  const vertical = f.isPortrait;

  const chip = 132 * s;
  const gap = 96 * s;
  const dot = 14 * s;

  const arrivalFrame = (i: number): number => pulseStart + i * hopFrames;

  // Pulse position along the chain in "node units" (0 → nodes.length-1)
  const t = interpolate(
    frame,
    [pulseStart, pulseStart + (nodes.length - 1) * hopFrames],
    [0, nodes.length - 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const pulseOffset = t * (chip + gap);
  // The dot vanishes the moment it reaches the last node (which pops).
  const pulseDone = frame >= pulseStart + (nodes.length - 1) * hopFrames;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: vertical ? "column" : "row",
        alignItems: "center",
        position: "relative",
      }}
    >
      {nodes.map((node, i) => {
        const arrived = frame >= arrivalFrame(i);
        const p = pop(frame - arrivalFrame(i), fps);
        const scale = arrived ? interpolate(p, [0, 1], [1.12, 1]) : 1;
        return (
          <div
            key={`${node.label ?? node.logo}-${
              // biome-ignore lint/suspicious/noArrayIndexKey: static
              i
            }`}
            style={{
              display: "flex",
              flexDirection: vertical ? "column" : "row",
              alignItems: "center",
            }}
          >
            {i > 0 ? (
              <div
                style={{
                  width: vertical ? 1 : gap,
                  height: vertical ? gap : 1,
                  backgroundColor: theme.hairlineFaint,
                }}
              />
            ) : null}
            <div
              style={{
                width: chip,
                height: chip,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 8 * s,
                backgroundColor: theme.paperPure,
                border: `1px solid ${
                  arrived ? theme.hairline : theme.hairlineFaint
                }`,
                borderRadius: 18 * s,
                transform: `scale(${scale})`,
                opacity: arrived ? 1 : 0.55,
              }}
            >
              {node.logo ? (
                <div
                  style={{
                    width: chip * 0.42,
                    height: chip * 0.42,
                    backgroundColor: theme.text,
                    maskImage: `url(${staticFile(`logos/${node.logo}`)})`,
                    maskSize: "contain",
                    maskRepeat: "no-repeat",
                    maskPosition: "center",
                    WebkitMaskImage: `url(${staticFile(`logos/${node.logo}`)})`,
                    WebkitMaskSize: "contain",
                    WebkitMaskRepeat: "no-repeat",
                    WebkitMaskPosition: "center",
                  }}
                />
              ) : null}
              {node.label ? (
                <span
                  style={{
                    fontFamily: FONT_BODY,
                    fontWeight: 500,
                    fontSize: 19 * s,
                    color: node.logo ? theme.textMuted : theme.text,
                    textAlign: "center",
                    padding: `0 ${8 * s}px`,
                  }}
                >
                  {node.label}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
      {/* Accent pulse dot travelling the path */}
      {!pulseDone && frame >= pulseStart ? (
        <div
          style={{
            position: "absolute",
            left: vertical ? "50%" : chip / 2 + pulseOffset,
            top: vertical ? chip / 2 + pulseOffset : "50%",
            transform: "translate(-50%, -50%)",
            width: dot,
            height: dot,
            borderRadius: "50%",
            backgroundColor: theme.accent,
            boxShadow: `0 0 ${18 * s}px ${theme.accent}`,
          }}
        />
      ) : null}
    </div>
  );
};
