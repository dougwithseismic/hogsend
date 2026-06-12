import type React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_BODY, FONT_DISPLAY, FONT_MONO } from "../fonts";
import { pop, slideUp } from "../lib/anim";
import { useFormat } from "../lib/format";
import { theme } from "../lib/theme";

type Status = { label: string; at: number; time: string };

/**
 * Stylised email: real subject heading, from-line, grey skeleton body
 * bars. Slides in with a spring; a status row ticks
 * delivered → opened → clicked (accent ticks, mono timestamps).
 *
 *   <EmailCard
 *     subject="Welcome to Hogsend"
 *     from="Hogsend <hello@hogsend.com>"
 *     statusAt={{ delivered: 20, opened: 45, clicked: 70 }}
 *   />
 */
export const EmailCard: React.FC<{
  subject: string;
  from?: string;
  /** Frame (relative to mount) each status ticks on; omit to hide row. */
  statusAt?: { delivered: number; opened: number; clicked: number };
  /** Mono timestamps shown next to each tick. */
  times?: { delivered: string; opened: string; clicked: string };
  width?: number | string;
  /** Widths (0–1) of the grey body skeleton bars. */
  bodyBars?: number[];
}> = ({
  subject,
  from = "Hogsend <hello@hogsend.com>",
  statusAt,
  times = { delivered: "09:41:02", opened: "09:43:17", clicked: "09:44:05" },
  width,
  bodyBars = [0.92, 0.84, 0.62],
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();
  const s = f.fontScale;

  const entrance = slideUp(frame, fps, 0, 40);
  const statuses: Status[] = statusAt
    ? [
        { label: "delivered", at: statusAt.delivered, time: times.delivered },
        { label: "opened", at: statusAt.opened, time: times.opened },
        { label: "clicked", at: statusAt.clicked, time: times.clicked },
      ]
    : [];

  return (
    <div
      style={{
        width: width ?? (f.isPortrait ? "100%" : Math.min(f.width * 0.46, 820)),
        opacity: entrance.opacity,
        transform: `translateY(${entrance.translateY}px)`,
      }}
    >
      <div
        style={{
          backgroundColor: theme.paperPure,
          border: `1px solid ${theme.hairlineFaint}`,
          borderRadius: 14 * s,
          padding: 32 * s,
          boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
        }}
      >
        <div
          style={{
            fontFamily: FONT_BODY,
            fontSize: 17 * s,
            color: theme.textMuted,
            marginBottom: 14 * s,
          }}
        >
          From&nbsp;&nbsp;{from}
        </div>
        <div
          style={{
            fontFamily: FONT_DISPLAY,
            fontWeight: 500,
            fontSize: 34 * s,
            letterSpacing: "-0.02em",
            color: theme.text,
            marginBottom: 24 * s,
          }}
        >
          {subject}
        </div>
        {bodyBars.map((w, i) => (
          <div
            key={`bar-${
              // biome-ignore lint/suspicious/noArrayIndexKey: static
              i
            }`}
            style={{
              height: 13 * s,
              width: `${w * 100}%`,
              borderRadius: 999,
              backgroundColor: "rgba(255,255,255,0.08)",
              marginBottom: 13 * s,
            }}
          />
        ))}
      </div>
      {statuses.length > 0 ? (
        <div
          style={{
            display: "flex",
            gap: 26 * s,
            marginTop: 18 * s,
            paddingLeft: 6 * s,
          }}
        >
          {statuses.map(({ label, at, time }) => {
            const p = pop(frame - at, fps);
            const live = frame >= at;
            return (
              <div
                key={label}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8 * s,
                  opacity: live ? 1 : 0.3,
                  transform: `scale(${live ? interpolate(p, [0, 1], [1.2, 1]) : 1})`,
                  fontFamily: FONT_MONO,
                  fontSize: 16 * s,
                }}
              >
                <span style={{ color: live ? theme.accent : theme.textMuted }}>
                  {live ? "✓" : "·"}
                </span>
                <span style={{ color: theme.text }}>{label}</span>
                <span style={{ color: theme.textMuted }}>
                  {live ? time : "—"}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};
