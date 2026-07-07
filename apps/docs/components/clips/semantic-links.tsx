"use client";

import type { CSSProperties } from "react";
import { glide, interpolate, pop, punchIn } from "./clip-anim";
import { syntax, theme, typo } from "./clip-theme";
import { tokenize } from "./clip-tokenizer";
import { useLoopFrame } from "./use-loop-frame";

// ---------------------------------------------------------------------------
// semantic-links — native port of the Remotion comp
// (marketing/video/src/videos/semantic-links). A link click is a typed
// answer: an onboarding email asks a question with two CTA buttons, a cursor
// clicks "Yes, book it", and that click IS the journey's answer — an
// `onboarding.call_answered { answer: "yes" }` event springs out of the
// button, and the journey beside it branches on it (ctx.waitForEvent
// resolves → the `=== "yes"` arm lights up → sendEmail pulses).
//
// Drives off one looping web frame clock (use-loop-frame.ts) instead of
// Remotion's useCurrentFrame()/useVideoConfig(), and collapses the 3-ratio
// useFormat system into one responsive layout (side-by-side on lg+, stacked
// on mobile). All animation beats are preserved in spirit and loop cleanly.
// ---------------------------------------------------------------------------

const FPS = 30;

// Single stage scale — the web only needs one good size.
const S = 0.92;

// ---------------------------------------------------------------------------
// Timeline (frames). One continuous scene so the cursor never breaks:
// card in → cursor travels → click → event chip out → journey branches →
// hold → reset. Total loops cleanly back to a clean card.
// ---------------------------------------------------------------------------

const CURSOR_IN = 18; // cursor starts drifting in from the right
const CLICK = 78; // button press down
const RELEASE = 84; // press up
const CHIP = 88; // the event chip springs out of the button
const WAIT_RESOLVE = 104; // ctx.waitForEvent resolves with the answer
const BRANCH = 120; // the `=== "yes"` arm lights up
const SEND_PULSE = 134; // sendEmail line pulses — the journey acted
const TOTAL = 230; // loop length (a few beats of hold, then reset)

// The journey code the run is executing — the real ctx.waitForEvent pattern.
const CODE = `const answer = await ctx.waitForEvent({
  event: "onboarding.call_answered",
  timeout: days(3),
});
if (answer.properties?.answer === ⟦"yes"⟧) {
  await sendEmail({ template: "booking-link" });
}`;

const IF_LINE = 4;
const SEND_LINE = 5;

// Multi-point ramp — the shared `interpolate` only takes 2-element ranges, so
// this delegates to it per matched segment (same trick as journey-trace.tsx),
// preserving `interpolate(p, [a,b,c,d], [0,1,1,0])` fade-in/hold/fade-out.
const rampN = (
  input: number,
  inputRange: readonly number[],
  outputRange: readonly number[],
): number => {
  const last = inputRange.length - 1;
  if (input <= (inputRange[0] ?? 0)) {
    return outputRange[0] ?? 0;
  }
  if (input >= (inputRange[last] ?? 0)) {
    return outputRange[last] ?? 0;
  }
  for (let i = 0; i < last; i++) {
    const lo = inputRange[i] ?? 0;
    const hi = inputRange[i + 1] ?? 0;
    if (input >= lo && input <= hi) {
      return interpolate(
        input,
        [lo, hi],
        [outputRange[i] ?? 0, outputRange[i + 1] ?? 0],
      );
    }
  }
  return outputRange[last] ?? 0;
};

const ROOT_STYLE: CSSProperties = {
  position: "relative",
  width: "100%",
  height: "clamp(440px, 52vw, 540px)",
  overflow: "hidden",
  borderRadius: 12,
  border: `1px solid ${theme.cardBorder}`,
  backgroundColor: theme.ink,
};

// ---------------------------------------------------------------------------
// Cursor — the arrow that lands on the primary button hotspot.
// ---------------------------------------------------------------------------

function Cursor({ size }: { size: number }) {
  return (
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
}

// ---------------------------------------------------------------------------
// The email — onboarding question + two answer buttons. The cursor clicks the
// primary one and the EmailAction payload (the event chip) springs out of it.
// ---------------------------------------------------------------------------

function AnswerEmail({ frame }: { frame: number }) {
  const s = S;

  // Card scales in.
  const enter = pop(frame, FPS, 4);

  // Cursor travel from frame-right → primary button (slows into the hotspot).
  const travel = glide(frame, FPS, CURSOR_IN);
  const dx = interpolate(travel, [0, 1], [260 * s, 0]);
  const dy = interpolate(travel, [0, 1], [-130 * s, 0]);
  const bob = Math.sin(frame * 0.4) * 1.4 * travel; // idle, post-arrival
  const cursorIn = interpolate(frame, [CURSOR_IN, CURSOR_IN + 8], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Click: button presses then releases (down minus up → 0→1→0).
  const down = pop(frame, FPS, CLICK);
  const up = pop(frame, FPS, RELEASE);
  const press = Math.max(0, down - up);
  const pressed = frame >= CLICK && frame < RELEASE + 4;

  // Click ripple ring.
  const rip = interpolate(frame, [CLICK + 2, CLICK + 24], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // The event chip springs out of the button and hovers up. The email copy
  // recedes behind it — the chip is the answer.
  const chip = pop(frame, FPS, CHIP);
  const chipRise = interpolate(frame, [CHIP + 16, TOTAL - 30], [0, -10 * s], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const recede = 1 - 0.7 * chip;

  const buttonPad = `${12 * s}px ${24 * s}px`;
  const buttonFont: CSSProperties = {
    fontWeight: 500,
    fontSize: 17 * s,
    letterSpacing: typo.tracking,
    whiteSpace: "nowrap",
  };

  return (
    <div
      className="w-full"
      style={{
        maxWidth: 460 * s,
        opacity: enter,
        transform: `translateY(${(1 - enter) * 28}px) scale(${
          0.96 + 0.04 * enter
        })`,
      }}
    >
      <div
        style={{
          backgroundColor: theme.paperPure,
          border: `1px solid ${theme.cardBorder}`,
          borderRadius: 16,
          padding: `${30 * s}px ${32 * s}px ${34 * s}px`,
          boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
        }}
      >
        <div
          className="font-mono"
          style={{
            fontSize: 12 * s,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: theme.textMuted,
            marginBottom: 16 * s,
            opacity: recede,
          }}
        >
          Onboarding
        </div>
        <div
          className="font-sans"
          style={{
            fontWeight: 500,
            fontSize: 27 * s,
            letterSpacing: typo.tracking,
            color: theme.text,
            marginBottom: 12 * s,
            opacity: recede,
          }}
        >
          Ready for your onboarding call?
        </div>
        <div
          className="font-sans"
          style={{
            fontWeight: 400,
            fontSize: 17 * s,
            lineHeight: 1.5,
            color: theme.textMuted,
            marginBottom: 26 * s,
            opacity: recede,
          }}
        >
          We&rsquo;ll set you up in 20 minutes.
        </div>
        <div style={{ display: "flex", gap: 14 * s, alignItems: "center" }}>
          <div style={{ position: "relative", display: "inline-block" }}>
            {/* The EmailAction's payload — the click IS the event. */}
            {frame >= CHIP ? (
              <div
                className="font-mono"
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
                  border: `1px solid ${theme.accent}`,
                  borderRadius: 12,
                  padding: `${13 * s}px ${18 * s}px`,
                  boxShadow:
                    "0 18px 60px rgba(0,0,0,0.65), 0 0 24px rgba(246,72,56,0.18)",
                  fontSize: 16 * s,
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
            {/* Click ripple. */}
            {frame >= CLICK + 2 && rip < 1 ? (
              <div
                style={{
                  position: "absolute",
                  left: "58%",
                  top: "52%",
                  width: 76 * s,
                  height: 76 * s,
                  marginLeft: -38 * s,
                  marginTop: -38 * s,
                  borderRadius: "50%",
                  border: `2px solid ${theme.accent}`,
                  opacity: (1 - rip) * 0.8,
                  transform: `scale(${0.35 + rip * 1.25})`,
                  pointerEvents: "none",
                }}
              />
            ) : null}
            <div
              className="font-sans"
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
            {/* Cursor — tip lands at the button hotspot. */}
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
              <Cursor size={24 * s} />
            </div>
          </div>
          <div
            className="font-sans"
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
}

// ---------------------------------------------------------------------------
// The journey reacting — the run code-panel beside the email. ctx.waitForEvent
// resolves with the answer, the `=== "yes"` arm lights up, sendEmail pulses.
// ---------------------------------------------------------------------------

function BranchPanel({ frame }: { frame: number }) {
  const s = S;
  const size = 14;
  const codeLineH = 1.7;
  const lineH = size * codeLineH;
  const padY = Math.round(size * 1.1);
  const padX = Math.round(size * 1.3);
  const lines = tokenize(CODE);

  const enter = pop(frame, FPS, 8);

  // The wait resolves with the answer — a chip slides onto the wait line.
  const resolve = glide(frame, FPS, WAIT_RESOLVE);
  const resolved = frame >= WAIT_RESOLVE;

  // The `if (... === "yes")` arm sweeps in, then fades as the branch fires.
  const sweepArm = interpolate(frame, [BRANCH, BRANCH + 6], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const sweepFade = rampN(
    frame,
    [BRANCH, BRANCH + 6, SEND_PULSE, SEND_PULSE + 18],
    [0, 1, 1, 0],
  );
  // The sendEmail line pulses once — the journey acted on the answer.
  const pulse = rampN(
    frame,
    [SEND_PULSE, SEND_PULSE + 10, SEND_PULSE + 30],
    [0, 1, 0],
  );

  const highlightBase: CSSProperties = {
    position: "absolute",
    top: size * 0.18,
    bottom: size * 0.18,
    left: -size * 0.55,
    right: -size * 0.55,
    borderRadius: 6,
    pointerEvents: "none",
  };

  return (
    <div
      // Stacked on mobile the fixed-size code overflows this column; scroll it
      // under a hidden scrollbar with a right-edge fade instead of clipping.
      className="w-full overflow-x-auto [scrollbar-width:none] [mask-image:linear-gradient(to_right,#000_88%,transparent)] [&::-webkit-scrollbar]:hidden"
      style={{
        maxWidth: 480 * s,
        opacity: enter,
        transform: `translateY(${(1 - enter) * 28}px) scale(${
          0.96 + 0.04 * enter
        })`,
      }}
    >
      {/* Window chrome — three dots + filename, mirrors the docs CodeMock. */}
      <div
        style={{
          overflow: "hidden",
          // Natural width so the scroll wrapper above scrolls the code panel.
          width: "max-content",
          borderRadius: 16,
          backgroundColor: theme.paperPure,
          border: `1px solid ${theme.cardBorder}`,
          boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
        }}
      >
        <div className="flex items-center gap-3 border-white/[0.08] border-b px-4 py-2.5">
          <div aria-hidden="true" className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
          </div>
          <span className="font-mono text-[11px] text-white/40 tracking-wide">
            src/journeys/onboarding.ts
          </span>
        </div>
        <div
          className="font-mono"
          style={{
            position: "relative",
            padding: `${padY}px ${padX}px`,
            fontSize: size,
            fontWeight: 400,
            lineHeight: codeLineH,
            whiteSpace: "pre",
            color: syntax.base,
          }}
        >
          {lines.map((line, li) => {
            const cascade = pop(frame, FPS, 12 + li * 2);
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: static code
                key={`l-${li}`}
                style={{
                  position: "relative",
                  minHeight: lineH,
                  opacity: cascade,
                  transform: `translateY(${interpolate(
                    cascade,
                    [0, 1],
                    [8, 0],
                  )}px)`,
                }}
              >
                {li === IF_LINE ? (
                  <div
                    style={{
                      ...highlightBase,
                      backgroundColor: theme.accentTint,
                      borderLeft: `3px solid ${theme.accent}`,
                      opacity: sweepFade,
                      transform: `scaleX(${sweepArm})`,
                      transformOrigin: "left center",
                    }}
                  />
                ) : null}
                {li === SEND_LINE ? (
                  <div
                    style={{
                      ...highlightBase,
                      backgroundColor: theme.accentTint,
                      opacity: pulse,
                    }}
                  />
                ) : null}
                <span style={{ position: "relative" }}>
                  {line.map((token, ti) => (
                    <span
                      // biome-ignore lint/suspicious/noArrayIndexKey: static
                      key={`${li}-${ti}`}
                      style={{
                        color: token.emphasis
                          ? syntax.emphasis
                          : syntax[
                              token.kind === "plain" ? "base" : token.kind
                            ],
                      }}
                    >
                      {token.text}
                    </span>
                  ))}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Resolution ribbon — the wait resolved WITH the answer the click carried. */}
      <div
        className="font-mono"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10 * s,
          marginTop: 14 * s,
          fontSize: 13 * s,
          color: theme.textMuted,
          opacity: pop(frame, FPS, WAIT_RESOLVE),
          transform: `translateX(${interpolate(resolve, [0, 1], [24, 0])}px)`,
          whiteSpace: "pre",
        }}
      >
        <span style={{ color: theme.textHint }}>ctx.waitForEvent</span>
        <span style={{ color: theme.textHint }}>resolved</span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            padding: `${5 * s}px ${10 * s}px`,
            borderRadius: 6,
            border: `1px solid ${theme.accent}`,
            backgroundColor: theme.accentTint,
            color: theme.text,
            opacity: resolved ? 1 : 0,
          }}
        >
          answer = &quot;yes&quot;
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Eyebrow — the docs `.eyebrow` label language.
// ---------------------------------------------------------------------------

function Eyebrow({ frame, text }: { frame: number; text: string }) {
  const pulse = 0.65 - 0.35 * Math.cos((frame / 45) * Math.PI * 2);
  return (
    <div
      className="font-sans"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        fontWeight: 400,
        fontSize: 12,
        lineHeight: 1,
        letterSpacing: typo.eyebrowTracking,
        textTransform: "uppercase",
        color: theme.textFaint,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          backgroundColor: theme.accent,
          boxShadow: `0 0 7px rgba(246,72,56,${pulse})`,
        }}
      />
      {text}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The whole clip — email on one side, the journey reacting on the other, on a
// single looping clock with the subtle bottom red bloom. Loops cleanly.
// ---------------------------------------------------------------------------

export function SemanticLinks() {
  const { ref, frame } = useLoopFrame(TOTAL, FPS);

  // The payoff bloom rises as the journey acts on the click.
  const glowIn = interpolate(frame, [CHIP, SEND_PULSE], [0, 0.9], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div ref={ref} style={ROOT_STYLE}>
      {/* Subtle bottom red bloom — the reference's SceneShell aurora. */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          background: `radial-gradient(60% 50% at 50% 110%, rgba(246,72,56,${
            0.16 * glowIn + 0.04
          }), transparent 70%)`,
        }}
      />
      {/* Two faint vertical gutter hairlines — the docs PageFrame motif. */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: 24,
          width: 1,
          backgroundColor: theme.frameLine,
          pointerEvents: "none",
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          right: 24,
          width: 1,
          backgroundColor: theme.frameLine,
          pointerEvents: "none",
        }}
      />

      <div
        className="absolute inset-0 flex flex-col items-stretch justify-center gap-7 overflow-auto p-6 md:p-10 lg:flex-row lg:items-center lg:gap-10"
        style={{
          transform: `scale(${punchIn(frame, FPS)})`,
          transformOrigin: "center",
        }}
      >
        <div className="flex w-full flex-col gap-4 lg:w-auto lg:shrink-0">
          <Eyebrow frame={frame} text="The email" />
          <AnswerEmail frame={frame} />
        </div>

        {/* Connective arrow — the click flowing into the run (lg+ only). */}
        <div
          aria-hidden="true"
          className="hidden self-center lg:block"
          style={{
            fontSize: 22,
            color: theme.accent,
            opacity: interpolate(frame, [CHIP, CHIP + 12], [0, 0.8], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          →
        </div>

        <div className="flex w-full flex-col gap-4 lg:w-auto lg:shrink-0">
          <Eyebrow frame={frame} text="The journey reacts" />
          <BranchPanel frame={frame} />
        </div>
      </div>
    </div>
  );
}
