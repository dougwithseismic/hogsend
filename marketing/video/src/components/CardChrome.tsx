import type React from "react";
import type { ReactNode } from "react";
import { FONT_MONO } from "../fonts";
import { theme } from "../lib/theme";

/**
 * Shared editor/terminal card chrome, matching the docs code-mock panel
 * (components/ds/mockup.tsx): paper-pure background, white/10 border,
 * slim header with white/15 traffic lights and the filename in Geist
 * Mono at white/40. Optional `footer` renders below the content behind a
 * hairline divider (status rows, etc).
 */
export const CardChrome: React.FC<{
  title?: string;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number | string;
  /** Scales the chrome (dots, paddings, title). Default 1. */
  scale?: number;
}> = ({ title, children, footer, width = "100%", scale = 1 }) => {
  const dot = 11 * scale;
  return (
    <div
      style={{
        width,
        backgroundColor: theme.paperPure,
        border: `1px solid ${theme.cardBorder}`,
        borderRadius: 16 * scale,
        overflow: "hidden",
        boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8 * scale,
          padding: `${12 * scale}px ${20 * scale}px`,
          borderBottom: `1px solid ${theme.hairlineFaint}`,
        }}
      >
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              width: dot,
              height: dot,
              borderRadius: "50%",
              backgroundColor: theme.hairline,
            }}
          />
        ))}
        {title ? (
          <span
            style={{
              marginLeft: 12 * scale,
              fontFamily: FONT_MONO,
              fontSize: 15 * scale,
              fontWeight: 400,
              color: theme.textHint,
              letterSpacing: "0.01em",
            }}
          >
            {title}
          </span>
        ) : null}
      </div>
      {children}
      {footer ? (
        <div style={{ borderTop: `1px solid ${theme.hairlineFaint}` }}>
          {footer}
        </div>
      ) : null}
    </div>
  );
};
