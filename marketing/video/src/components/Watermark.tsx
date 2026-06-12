import type React from "react";
import { FONT_BODY } from "../fonts";
import { useFormat } from "../lib/format";
import { theme, typo } from "../lib/theme";

/**
 * Corner watermark — hogsend.com plus the tagline, bottom-right, inside
 * the page-frame gutter. Rendered by SceneShell on every beat.
 */
export const Watermark: React.FC<{
  tagline?: string;
}> = ({ tagline = "Lifecycle email, in your repo." }) => {
  const f = useFormat();
  const size = Math.round(17 * f.fontScale * (f.isPortrait ? 1.15 : 1));
  return (
    <div
      style={{
        position: "absolute",
        right: Math.round(f.pad * 0.75),
        bottom: Math.round(f.pad * 0.55) + f.safeBottom,
        display: "flex",
        alignItems: "baseline",
        gap: size * 0.45,
        fontFamily: FONT_BODY,
        fontSize: size,
        letterSpacing: typo.tracking,
        whiteSpace: "pre",
        pointerEvents: "none",
      }}
    >
      <span style={{ fontWeight: 500, color: theme.textMuted }}>
        hogsend.com
      </span>
      <span style={{ fontWeight: 400, color: "rgba(255,255,255,0.32)" }}>
        — {tagline}
      </span>
    </div>
  );
};
