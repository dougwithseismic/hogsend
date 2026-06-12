import type React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_BODY, FONT_DISPLAY, FONT_MONO } from "../../fonts";
import { pop, SPRING_SNAPPY } from "../../lib/anim";
import { useFormat } from "../../lib/format";
import { theme } from "../../lib/theme";

/**
 * The 120-frame email scene (beats 2+3 of the script, frames 60–179):
 * an onboarding email with two answer buttons. A cursor drifts in from
 * frame right (first 60 frames), clicks "Yes, book it" (frame ~64), the
 * button presses, and the EmailAction's event chip springs out of it —
 * the click IS the event.
 */

const CURSOR_IN = 12; // cursor starts drifting
const CLICK = 64; // press down
const RELEASE = 70; // press up
const CHIP = 72; // event chip springs out

const Cursor: React.FC<{ size: number }> = ({ size }) => (
  <svg
    width={size}
    height={size * 1.5}
    viewBox="0 0 14 21"
    style={{ display: "block" }}
    role="img"
    aria-label="Cursor"
  >
    <path
      d="M1.5 1.5 L1.5 16.2 L5.2 12.9 L7.8 19 L10.5 17.8 L7.9 11.9 L13 11.6 Z"
      fill="#ffffff"
      stroke={theme.ink}
      strokeWidth={1.2}
      strokeLinejoin="round"
    />
  </svg>
);

export const AnswerEmail: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();
  const s = f.fontScale * (f.isPortrait ? 1.35 : 1.08);

  const cardWidth = f.isPortrait
    ? f.width - f.pad * 2
    : f.ratio === "11"
      ? 720
      : 820;

  // Card scales in.
  const enter = spring({
    frame,
    fps,
    config: SPRING_SNAPPY,
    durationInFrames: 14,
  });

  // Cursor travel from frame right → primary button.
  const travel = spring({
    frame: frame - CURSOR_IN,
    fps,
    config: SPRING_SNAPPY,
    durationInFrames: 44,
  });
  const dx = interpolate(travel, [0, 1], [f.width * 0.34, 0]);
  const dy = interpolate(travel, [0, 1], [-150 * s, 0]);
  const bob = Math.sin(frame * 0.4) * 1.4 * travel; // idle, post-arrival
  const cursorIn = interpolate(frame, [CURSOR_IN, CURSOR_IN + 8], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Click: cursor dips, button presses then releases.
  const down = pop(frame, fps, CLICK);
  const up = pop(frame, fps, RELEASE);
  const press = down - up; // 0 → 1 → 0
  const pressed = frame >= CLICK && frame < RELEASE + 4;

  // Click ripple ring.
  const ripple = spring({
    frame: frame - CLICK - 2,
    fps,
    config: SPRING_SNAPPY,
    durationInFrames: 22,
  });

  // Event chip springs out of the button, then hovers upward. The email
  // copy recedes behind it — the chip is the answer.
  const chip = pop(frame, fps, CHIP);
  const chipRise = interpolate(frame, [CHIP + 16, 119], [0, -10 * s], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const recede = 1 - 0.75 * chip;

  const buttonPad = `${13 * s}px ${26 * s}px`;
  const buttonFont = {
    fontFamily: FONT_BODY,
    fontWeight: 500,
    fontSize: 19 * s,
    whiteSpace: "nowrap",
  } as const;

  return (
    <div
      style={{
        width: cardWidth,
        opacity: enter,
        transform: `translateY(${(1 - enter) * 36}px) scale(${
          0.96 + 0.04 * enter
        })`,
      }}
    >
      <div
        style={{
          backgroundColor: theme.paperPure,
          border: `1px solid ${theme.hairlineFaint}`,
          borderRadius: 16 * s,
          padding: `${34 * s}px ${38 * s}px ${38 * s}px`,
          boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
        }}
      >
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 14 * s,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: theme.textMuted,
            marginBottom: 18 * s,
            opacity: recede,
          }}
        >
          Onboarding
        </div>
        <div
          style={{
            fontFamily: FONT_DISPLAY,
            fontWeight: 500,
            fontSize: 34 * s,
            letterSpacing: "-0.02em",
            color: theme.text,
            marginBottom: 14 * s,
            opacity: recede,
          }}
        >
          Ready for your onboarding call?
        </div>
        <div
          style={{
            fontFamily: FONT_BODY,
            fontWeight: 400,
            fontSize: 20 * s,
            lineHeight: 1.5,
            color: theme.textMuted,
            marginBottom: 30 * s,
            opacity: recede,
          }}
        >
          We&rsquo;ll set you up in 20 minutes.
        </div>
        <div style={{ display: "flex", gap: 16 * s, alignItems: "center" }}>
          <div style={{ position: "relative", display: "inline-block" }}>
            {/* The EmailAction's payload — click IS event */}
            {frame >= CHIP ? (
              <div
                style={{
                  position: "absolute",
                  left: -6 * s,
                  bottom: `calc(100% + ${14 * s}px)`,
                  zIndex: 2,
                  opacity: chip,
                  transform: `translateY(${chipRise}px) scale(${interpolate(
                    chip,
                    [0, 1],
                    [0.5, 1],
                  )})`,
                  transformOrigin: "14% 100%",
                  backgroundColor: theme.ink,
                  border: `1px solid ${theme.hairline}`,
                  borderRadius: 12 * s,
                  padding: `${15 * s}px ${22 * s}px`,
                  boxShadow: "0 18px 60px rgba(0,0,0,0.65)",
                  fontFamily: FONT_MONO,
                  fontSize: 20 * s,
                  lineHeight: 1.6,
                  whiteSpace: "nowrap",
                }}
              >
                <div style={{ color: theme.text }}>
                  onboarding.call_answered
                </div>
                <div style={{ color: theme.textMuted }}>
                  {"{ answer: "}
                  <span style={{ color: theme.accent }}>&quot;yes&quot;</span>
                  {" }"}
                </div>
              </div>
            ) : null}
            {/* Click ripple */}
            {frame >= CLICK + 2 ? (
              <div
                style={{
                  position: "absolute",
                  left: "58%",
                  top: "52%",
                  width: 80 * s,
                  height: 80 * s,
                  marginLeft: -40 * s,
                  marginTop: -40 * s,
                  borderRadius: "50%",
                  border: `2px solid ${theme.accent}`,
                  opacity: (1 - ripple) * 0.8,
                  transform: `scale(${0.35 + ripple * 1.25})`,
                  pointerEvents: "none",
                }}
              />
            ) : null}
            <div
              style={{
                ...buttonFont,
                color: "#ffffff",
                backgroundColor: pressed ? theme.accentDeep : theme.accent,
                borderRadius: 999,
                padding: buttonPad,
                transform: `scale(${1 - 0.06 * press})`,
              }}
            >
              Yes, book it
            </div>
            {/* Cursor — tip lands at the button hotspot */}
            <div
              style={{
                position: "absolute",
                left: "58%",
                top: "52%",
                zIndex: 3,
                opacity: cursorIn,
                transform: `translate(${dx}px, ${dy + bob}px) scale(${
                  1 - 0.14 * press
                })`,
                filter: "drop-shadow(0 4px 10px rgba(0,0,0,0.6))",
              }}
            >
              <Cursor size={26 * s} />
            </div>
          </div>
          <div
            style={{
              ...buttonFont,
              color: theme.textMuted,
              border: `1px solid ${theme.hairline}`,
              borderRadius: 999,
              padding: buttonPad,
              opacity: recede,
            }}
          >
            Not yet
          </div>
        </div>
      </div>
    </div>
  );
};
