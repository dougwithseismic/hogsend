import type React from "react";
import { FONT_DISPLAY } from "../fonts";
import { theme } from "../lib/theme";

/**
 * Hogsend brand lockup, replicated from the docs-site nav: an accent-red
 * rounded tile holding a white "send" glyph, then the typeset wordmark
 * in Inter Display (medium, tight tracking). Typeset — not an image.
 */
export const Wordmark: React.FC<{
  /** Tile size in px; everything else scales from this. */
  size?: number;
  /** Hide the text and show only the glyph tile. */
  glyphOnly?: boolean;
}> = ({ size = 56, glyphOnly = false }) => {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: size * 0.36,
      }}
    >
      <span
        style={{
          display: "flex",
          width: size,
          height: size,
          flexShrink: 0,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: size * 0.214,
          backgroundColor: theme.accent,
          color: theme.text,
        }}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          style={{ width: size * 0.571, height: size * 0.571 }}
          role="img"
          aria-label="Hogsend"
        >
          <path d="M3.5 12 20 4.5 14 20l-3.2-6.4L3.5 12Z" fill="currentColor" />
          <path
            d="m10.8 13.2 6.4-7.4"
            stroke={theme.accent}
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </span>
      {glyphOnly ? null : (
        <span
          style={{
            fontFamily: FONT_DISPLAY,
            fontWeight: 500,
            fontSize: size * 0.71,
            lineHeight: 1,
            letterSpacing: "-0.025em",
            color: theme.text,
          }}
        >
          Hogsend
        </span>
      )}
    </span>
  );
};
