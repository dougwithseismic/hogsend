import type React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_BODY, FONT_DISPLAY, FONT_MONO } from "../fonts";
import { slideUp } from "../lib/anim";
import { useFormat } from "../lib/format";
import { radius, theme, typo } from "../lib/theme";

/**
 * The docs site's label language: eyebrows, kickers, ghost numbers and
 * tag pills (components/ds/badge.tsx, process.tsx, global.css). Use an
 * Eyebrow at the top of a beat the way the site opens a section.
 */

/** Mono-feel uppercase micro label — `.eyebrow` (12px / 0.04em / white-50). */
export const Eyebrow: React.FC<{
  text: string;
  /** Pulsing accent status dot before the label (docs chat-demo header). */
  dot?: boolean;
  delay?: number;
  align?: "left" | "center";
}> = ({ text, dot = false, delay = 0, align = "left" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();
  const size = Math.round(19 * f.fontScale * (f.isPortrait ? 1.15 : 1));
  const a = slideUp(frame, fps, delay, 14);
  const pulse = 0.65 - 0.35 * Math.cos((frame / 45) * Math.PI * 2);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: align === "center" ? "center" : "flex-start",
        gap: size * 0.6,
        opacity: a.opacity,
        transform: `translateY(${a.translateY}px)`,
        fontFamily: FONT_BODY,
        fontWeight: 400,
        fontSize: size,
        lineHeight: 1,
        letterSpacing: typo.eyebrowTracking,
        textTransform: "uppercase",
        color: theme.textFaint,
      }}
    >
      {dot ? (
        <span
          style={{
            width: size * 0.45,
            height: size * 0.45,
            borderRadius: "50%",
            backgroundColor: theme.accent,
            boxShadow: `0 0 ${size * 0.55}px rgba(246,72,56,${pulse})`,
          }}
        />
      ) : null}
      {text}
    </div>
  );
};

/** Accent-red section intro line — `.kicker` (18px / -0.02em / accent). */
export const Kicker: React.FC<{ text: string; delay?: number }> = ({
  text,
  delay = 0,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();
  const a = slideUp(frame, fps, delay, 14);
  return (
    <div
      style={{
        opacity: a.opacity,
        transform: `translateY(${a.translateY}px)`,
        fontFamily: FONT_BODY,
        fontWeight: 400,
        fontSize: Math.round(26 * f.fontScale),
        letterSpacing: typo.tracking,
        color: theme.accent,
      }}
    >
      {text}
    </div>
  );
};

/** Huge faint number — the docs process-step ghost numeral (white-20). */
export const GhostNumber: React.FC<{ n: string; size?: number }> = ({
  n,
  size,
}) => {
  const f = useFormat();
  return (
    <span
      style={{
        fontFamily: FONT_DISPLAY,
        fontWeight: 400,
        fontSize: size ?? Math.round(96 * f.fontScale),
        lineHeight: 1,
        letterSpacing: typo.tracking,
        color: theme.textGhost,
      }}
    >
      {n}
    </span>
  );
};

/** Small chip — docs TagPill. Neutral by default, `accent` for the red one. */
export const TagPill: React.FC<{
  text: string;
  accent?: boolean;
  mono?: boolean;
}> = ({ text, accent = false, mono = false }) => {
  const f = useFormat();
  const size = Math.round(18 * f.fontScale * (f.isPortrait ? 1.1 : 1));
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: `${size * 0.32}px ${size * 0.65}px`,
        borderRadius: radius.card * 0.8 * f.fontScale,
        border: `1px solid ${accent ? theme.accent : theme.hairlineFaint}`,
        backgroundColor: accent ? theme.accentTint : theme.tagFill,
        fontFamily: mono ? FONT_MONO : FONT_BODY,
        fontWeight: 400,
        fontSize: size,
        lineHeight: 1,
        letterSpacing: mono ? "0" : typo.tracking,
        color: accent ? theme.text : theme.textBody,
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
};
