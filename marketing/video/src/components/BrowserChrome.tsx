import type React from "react";
import { Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { FONT_MONO } from "../fonts";
import { useFormat } from "../lib/format";
import { theme } from "../lib/theme";

/**
 * Frames a screenshot in minimal browser chrome (dots + url pill,
 * hairline border) with a subtle Ken-Burns drift on the image.
 *
 *   <BrowserChrome src="screenshots/01-overview.png" url="hogsend.com/studio" />
 *
 * `src` is relative to public/ (run `pnpm assets` to populate it).
 */
export const BrowserChrome: React.FC<{
  src: string;
  url?: string;
  width?: number | string;
  /** Disable the Ken-Burns drift. */
  still?: boolean;
  /** Frames the drift spans (default 150). */
  driftFrames?: number;
}> = ({
  src,
  url = "hogsend.com",
  width,
  still = false,
  driftFrames = 150,
}) => {
  const frame = useCurrentFrame();
  const f = useFormat();
  const scale = f.fontScale;

  const drift = still
    ? 1
    : interpolate(frame, [0, driftFrames], [1.0, 1.06], {
        extrapolateLeft: "clamp",
        extrapolateRight: "extend",
      });
  const panX = still
    ? 0
    : interpolate(frame, [0, driftFrames], [0, -8], {
        extrapolateLeft: "clamp",
        extrapolateRight: "extend",
      });

  return (
    <div
      style={{
        width:
          width ?? (f.isPortrait ? "100%" : Math.min(f.width * 0.72, 1320)),
        backgroundColor: theme.paperPure,
        border: `1px solid ${theme.hairlineFaint}`,
        borderRadius: 14 * scale,
        overflow: "hidden",
        boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9 * scale,
          padding: `${12 * scale}px ${18 * scale}px`,
          borderBottom: `1px solid ${theme.hairlineFaint}`,
        }}
      >
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              width: 12 * scale,
              height: 12 * scale,
              borderRadius: "50%",
              backgroundColor: "rgba(255,255,255,0.12)",
            }}
          />
        ))}
        <span
          style={{
            marginLeft: 10 * scale,
            padding: `${5 * scale}px ${16 * scale}px`,
            borderRadius: 7 * scale,
            border: `1px solid ${theme.hairlineFaint}`,
            fontFamily: FONT_MONO,
            fontSize: 14 * scale,
            color: theme.textMuted,
          }}
        >
          {url}
        </span>
      </div>
      <div style={{ overflow: "hidden" }}>
        <Img
          src={staticFile(src)}
          style={{
            display: "block",
            width: "100%",
            transform: `scale(${drift}) translateX(${panX}px)`,
            transformOrigin: "50% 30%",
          }}
        />
      </div>
    </div>
  );
};
