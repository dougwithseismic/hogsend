import type React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_BODY, FONT_MONO } from "../fonts";
import { pop, slideUp } from "../lib/anim";
import { useFormat } from "../lib/format";
import { theme, typo } from "../lib/theme";
import { Wordmark } from "./Wordmark";

/**
 * Standard closing card: Wordmark, one short line, the scaffold command
 * in a mono pill, hogsend.com underneath. Hold ~60 frames.
 *
 *   <EndCard line="Lifecycle email, in your repo." />
 */
export const EndCard: React.FC<{
  line?: string;
  command?: string;
  domain?: string;
}> = ({
  line = "Lifecycle email, in your repo.",
  command = "pnpm dlx create-hogsend@latest",
  domain = "hogsend.com",
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();
  const s = f.fontScale;

  const mark = pop(frame, fps);
  const lineIn = slideUp(frame, fps, 8);
  const pillIn = slideUp(frame, fps, 16);
  const domainIn = pop(frame, fps, 26);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 36 * s,
      }}
    >
      <div
        style={{
          opacity: mark,
          transform: `scale(${interpolate(mark, [0, 1], [1.06, 1])})`,
        }}
      >
        <Wordmark size={Math.round(72 * s)} />
      </div>
      <div
        style={{
          opacity: lineIn.opacity,
          transform: `translateY(${lineIn.translateY}px)`,
          fontFamily: FONT_BODY,
          fontWeight: 400,
          fontSize: 30 * s,
          letterSpacing: typo.tracking,
          color: theme.textMuted,
          textAlign: "center",
        }}
      >
        {line}
      </div>
      <div
        style={{
          opacity: pillIn.opacity,
          transform: `translateY(${pillIn.translateY}px)`,
          fontFamily: FONT_MONO,
          fontWeight: 500,
          fontSize: 27 * s,
          color: theme.text,
          backgroundColor: theme.paperPure,
          border: `1px solid ${theme.cardBorder}`,
          borderRadius: 16 * s,
          padding: `${18 * s}px ${34 * s}px`,
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ color: theme.accent }}>❯ </span>
        {command}
      </div>
      <div
        style={{
          opacity: domainIn,
          fontFamily: FONT_BODY,
          fontWeight: 500,
          fontSize: 23 * s,
          letterSpacing: "0.02em",
          color: theme.textFaint,
        }}
      >
        {domain}
      </div>
    </div>
  );
};
