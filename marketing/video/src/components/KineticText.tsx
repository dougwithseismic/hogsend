import type React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_DISPLAY } from "../fonts";
import { staggerWords } from "../lib/anim";
import { useFormat } from "../lib/format";
import { theme, typo } from "../lib/theme";

/**
 * Display-font headline with a word-by-word spring reveal (3-frame
 * stagger, high-damping pop, slight rise). Words wrapped in *asterisks*
 * render in the accent colour — keep it to ~one accent phrase per beat.
 *
 *   <KineticText text="Journeys are *code*" />
 */
export const KineticText: React.FC<{
  text: string;
  size?: "xl" | "lg" | "md";
  align?: "left" | "center";
  /** Frames to wait before the first word. */
  delay?: number;
  /** Frames between words (default 3). */
  stagger?: number;
  muted?: boolean;
  maxWidth?: number | string;
}> = ({
  text,
  size = "lg",
  align = "center",
  delay = 0,
  stagger = 3,
  muted = false,
  maxWidth,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();

  const base = { xl: 124, lg: 88, md: 56 }[size];
  const fontSize = Math.round(base * f.fontScale);
  // Docs type metrics: hero is Inter Display 500 at -0.06em; section
  // headings are 400 at -0.02em.
  const weight = size === "xl" ? 500 : 400;
  const tracking = size === "xl" ? typo.heroTracking : "-0.025em";

  const words = text.split(" ").map((raw) => {
    const accent = /^\*[^*]+\*[.,!?]?$/.test(raw);
    return { word: accent ? raw.replaceAll("*", "") : raw, accent };
  });

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: align === "center" ? "center" : "flex-start",
        columnGap: fontSize * 0.26,
        rowGap: fontSize * 0.12,
        maxWidth: maxWidth ?? (f.isPortrait ? "100%" : "82%"),
        textAlign: align,
        fontFamily: FONT_DISPLAY,
        fontWeight: weight,
        fontSize,
        lineHeight: 1.06,
        letterSpacing: tracking,
        color: muted ? theme.textMuted : theme.text,
      }}
    >
      {words.map(({ word, accent }, i) => {
        const p = staggerWords(frame - delay, fps, i, stagger);
        return (
          <span
            key={`${word}-${
              // biome-ignore lint/suspicious/noArrayIndexKey: static list
              i
            }`}
            style={{
              display: "inline-block",
              opacity: p,
              transform: `translateY(${interpolate(
                p,
                [0, 1],
                [fontSize * 0.35, 0],
              )}px)`,
              color: accent ? theme.accent : undefined,
            }}
          >
            {word}
          </span>
        );
      })}
    </div>
  );
};
