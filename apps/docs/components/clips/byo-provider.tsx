"use client";

import type { CSSProperties } from "react";
import { interpolate, pop, punchIn, slideUp } from "./clip-anim";
import { syntax, theme, typo } from "./clip-theme";
import { useLoopFrame } from "./use-loop-frame";

// ---------------------------------------------------------------------------
// byo-provider — "The provider is just a wire." Native port of the Remotion
// comp (marketing/video/src/videos/byo-provider/index.tsx). The engine owns
// the pipeline (render · preferences · tracking · history); the provider chip
// plugs into the socket at the end and can be swapped without anything else
// moving. Two phases off one looping web frame clock:
//   - draw: the housing fills stage-by-stage with a travelling accent pulse,
//           then the Resend chip clicks into the socket.
//   - swap: `EMAIL_PROVIDER=postmark` types in, Resend unplugs, Postmark
//           clicks into the same socket — the engine never twitches.
// Drops Remotion's 3-ratio useFormat for one responsive layout (the pipeline
// runs as a row on wide screens, stacks to a column on narrow ones).
// ---------------------------------------------------------------------------

const FPS = 30;

const ENGINE_STAGES = ["render", "preferences", "tracking", "history"] as const;

// Phase windows (in frames of the looping clock).
const DRAW_FRAMES = 116;
const SWAP_FRAMES = 130;
const TOTAL_FRAMES = DRAW_FRAMES + SWAP_FRAMES;

// Draw-phase arrival beats: four engine stages then the provider chip.
const ARRIVALS = [10, 22, 34, 46, 64] as const;

const ENV_TEXT = "EMAIL_PROVIDER=postmark";
const ENV_HEAD = "EMAIL_PROVIDER=";

const ROOT_STYLE: CSSProperties = {
  position: "relative",
  width: "100%",
  height: "clamp(420px, 50vw, 500px)",
  overflow: "hidden",
  borderRadius: 12,
  border: `1px solid ${theme.cardBorder}`,
  backgroundColor: theme.ink,
};

const resendMask: CSSProperties = {
  width: 18,
  height: 18,
  flexShrink: 0,
  backgroundColor: theme.text,
  maskImage: "url(/logos/resend.svg)",
  maskSize: "contain",
  maskRepeat: "no-repeat",
  maskPosition: "center",
  WebkitMaskImage: "url(/logos/resend.svg)",
  WebkitMaskSize: "contain",
  WebkitMaskRepeat: "no-repeat",
  WebkitMaskPosition: "center",
};

// ---------------------------------------------------------------------------
// Eyebrow — the docs `.eyebrow` label language, with a pulsing accent dot.
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
// Caption — muted body line under the pipeline; rises + fades in on cue.
// ---------------------------------------------------------------------------

function Caption({
  frame,
  text,
  delay = 0,
}: {
  frame: number;
  text: string;
  delay?: number;
}) {
  const sl = slideUp(frame, FPS, delay, 16);
  return (
    <div
      className="font-sans"
      style={{
        opacity: sl.opacity,
        transform: `translateY(${sl.translateY}px)`,
        fontWeight: 400,
        fontSize: "clamp(16px, 2vw, 20px)",
        letterSpacing: typo.tracking,
        color: theme.textMuted,
        textAlign: "center",
      }}
    >
      {text}
    </div>
  );
}

// ---------------------------------------------------------------------------
// EnvLine — `EMAIL_PROVIDER=postmark` typed in, the value in accent, with a
// blinking block caret while it types (swap phase only).
// ---------------------------------------------------------------------------

function EnvLine({ frame, startDelay }: { frame: number; startDelay: number }) {
  // ~1.5 chars/frame, matching the Remotion typewriter cadence.
  const n = Math.max(
    0,
    Math.min(ENV_TEXT.length, Math.floor((frame - startDelay) * 1.5)),
  );
  const shownHead = ENV_TEXT.slice(0, Math.min(n, ENV_HEAD.length));
  const shownValue =
    n > ENV_HEAD.length ? ENV_TEXT.slice(ENV_HEAD.length, n) : "";
  const typing = frame >= startDelay && n < ENV_TEXT.length;
  const caretOn = Math.floor(frame / 8) % 2 === 0;
  return (
    <div
      className="font-mono"
      style={{
        fontWeight: 400,
        fontSize: "clamp(13px, 1.6vw, 16px)",
        letterSpacing: "0.01em",
        color: theme.textMuted,
        minHeight: 22,
        whiteSpace: "pre",
      }}
    >
      <span>{shownHead}</span>
      <span style={{ color: theme.accent }}>{shownValue}</span>
      {typing && caretOn ? (
        <span
          style={{
            display: "inline-block",
            width: "0.5em",
            height: "1.05em",
            verticalAlign: "text-bottom",
            backgroundColor: theme.text,
            marginLeft: 2,
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// EngineStage — one of the four chips the engine owns. Lights up on arrival
// with a brief overshoot, then settles.
// ---------------------------------------------------------------------------

function EngineStage({
  frame,
  label,
  arrival,
  settled,
}: {
  frame: number;
  label: string;
  arrival: number;
  settled: boolean;
}) {
  const arrived = settled || frame >= arrival;
  const p = settled ? 1 : pop(frame, FPS, arrival);
  const scale = arrived ? interpolate(p, [0, 1], [1.12, 1]) : 1;
  return (
    <div
      className="font-sans"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flex: "1 1 0",
        minWidth: 0,
        height: "clamp(46px, 6vw, 58px)",
        padding: "0 clamp(6px, 1vw, 12px)",
        backgroundColor: theme.slotFill,
        border: `1px solid ${arrived ? theme.hairline : theme.hairlineFaint}`,
        borderRadius: 12,
        transform: `scale(${scale})`,
        opacity: arrived ? 0.6 + 0.4 * p : 0.55,
        fontWeight: 500,
        fontSize: "clamp(12px, 1.4vw, 16px)",
        letterSpacing: typo.tracking,
        color: theme.text,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProviderChip — the swappable wire. `kind="resend"` carries the resend.svg
// mask; `kind="postmark"` is a clean text chip (no postmark logo shipped).
// ---------------------------------------------------------------------------

function ProviderChip({
  kind,
  faded = false,
}: {
  kind: "resend" | "postmark";
  faded?: boolean;
}) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 9,
        backgroundColor: theme.paperPure,
        border: `1px solid ${faded ? theme.hairlineFaint : theme.accent}`,
        borderRadius: 14,
        boxShadow: faded
          ? "none"
          : "0 0 26px rgba(246,72,56,0.16), 0 18px 50px rgba(0,0,0,0.45)",
      }}
    >
      {kind === "resend" ? <span style={resendMask} /> : null}
      <span
        className="font-sans"
        style={{
          fontWeight: 500,
          fontSize: "clamp(15px, 1.9vw, 20px)",
          letterSpacing: typo.tracking,
          color: theme.text,
        }}
      >
        {kind === "resend" ? "Resend" : "Postmark"}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pipeline — the engine housing + socket + provider chip. The housing holds
// perfectly still across the phase boundary; only the chip in the socket and
// the travelling pulse change.
// ---------------------------------------------------------------------------

function Pipeline({ frame, phase }: { frame: number; phase: "draw" | "swap" }) {
  const settled = phase === "swap";
  const housingIn = settled ? 1 : pop(frame, FPS);

  // Swap choreography: Resend unplugs, Postmark clicks into the same socket.
  const out = settled ? pop(frame, FPS, 30) : 0; // Resend slides out
  const inn = settled ? pop(frame, FPS, 46) : 0; // Postmark clicks in
  const innShift = interpolate(inn, [0, 1], [54, 0]);
  const drawArrived = !settled && frame >= ARRIVALS[4];
  const drawP = settled ? 1 : pop(frame, FPS, ARRIVALS[4]);

  return (
    <div
      className="flex w-full flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:gap-4"
      style={{ maxWidth: 760 }}
    >
      {/* Engine housing — the four stages the engine owns. */}
      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: "clamp(8px, 1.4vw, 16px)",
          flex: "1 1 auto",
          minWidth: 0,
          padding: "clamp(16px, 2vw, 22px) clamp(14px, 1.8vw, 20px)",
          backgroundColor: theme.paperPure,
          border: `1px solid ${theme.hairlineFaint}`,
          borderRadius: 18,
          opacity: housingIn,
        }}
      >
        <span
          className="font-mono"
          style={{
            position: "absolute",
            top: -9,
            left: 18,
            fontSize: 11,
            letterSpacing: "0.14em",
            color: theme.textMuted,
            backgroundColor: theme.ink,
            padding: "0 8px",
            lineHeight: "18px",
          }}
        >
          engine
        </span>
        {ENGINE_STAGES.map((label, i) => (
          <EngineStage
            key={label}
            frame={frame}
            label={label}
            arrival={ARRIVALS[i] ?? 0}
            settled={settled}
          />
        ))}
        {/* Travelling accent pulse (draw phase) — a sweep across the housing. */}
        {!settled ? <HousingPulse frame={frame} /> : null}
      </div>

      {/* Socket connector — the seam the provider plugs into. */}
      <div
        className="flex items-center justify-center"
        style={{
          flexShrink: 0,
          flexDirection: "row",
          width: "clamp(28px, 4vw, 48px)",
          opacity: housingIn,
        }}
      >
        <span
          style={{
            width: 9,
            height: 9,
            flexShrink: 0,
            borderRadius: "50%",
            border: `1px solid ${theme.hairline}`,
            backgroundColor: theme.ink,
          }}
        />
        <span
          style={{
            flexGrow: 1,
            height: 1,
            backgroundColor: theme.hairlineFaint,
          }}
        />
      </div>

      {/* Provider chip — the swappable wire. */}
      <div
        style={{
          position: "relative",
          flexShrink: 0,
          width: "clamp(150px, 22vw, 200px)",
          height: "clamp(64px, 8vw, 84px)",
        }}
      >
        {phase === "draw" ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              opacity: drawArrived ? 0.6 + 0.4 * drawP : 0,
              transform: `scale(${
                drawArrived ? interpolate(drawP, [0, 1], [1.12, 1]) : 1
              })`,
            }}
          >
            <ProviderChip kind="resend" faded={!drawArrived} />
          </div>
        ) : (
          <>
            <div
              style={{
                position: "absolute",
                inset: 0,
                opacity: 1 - out,
                transform: `translateX(${out * 48}px)`,
              }}
            >
              <ProviderChip kind="resend" />
            </div>
            <div
              style={{
                position: "absolute",
                inset: 0,
                opacity: interpolate(inn, [0, 0.6], [0, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                }),
                transform: `translateX(${innShift}px)`,
              }}
            >
              <ProviderChip kind="postmark" />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HousingPulse — the accent dot sweeping across the four engine stages as
// each one arrives (draw phase only).
// ---------------------------------------------------------------------------

function HousingPulse({ frame }: { frame: number }) {
  const first = ARRIVALS[0];
  const last = ARRIVALS[3];
  if (frame < first || frame > last + 6) {
    return null;
  }
  // Sweep the dot across the housing from the first stage's centre to the
  // last's as the arrival window plays out.
  const pos = interpolate(frame, [first, last], [12, 87], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <span
      aria-hidden="true"
      style={{
        position: "absolute",
        left: `${pos}%`,
        top: "50%",
        transform: "translate(-50%, -50%)",
        width: 11,
        height: 11,
        borderRadius: "50%",
        backgroundColor: theme.accent,
        boxShadow: `0 0 18px ${theme.accent}`,
        pointerEvents: "none",
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// ContractCode — the swap config as a tiny static code chip under the
// pipeline (swap phase): `defineEmailProvider({ id: "postmark" })`.
// ---------------------------------------------------------------------------

function ContractCode({ frame, delay }: { frame: number; delay: number }) {
  const sl = slideUp(frame, FPS, delay, 14);
  return (
    <div
      className="font-mono"
      style={{
        opacity: sl.opacity,
        transform: `translateY(${sl.translateY}px)`,
        display: "inline-flex",
        alignItems: "center",
        padding: "8px 14px",
        borderRadius: 8,
        border: `1px solid ${theme.hairlineFaint}`,
        backgroundColor: theme.paperPure,
        fontSize: "clamp(12px, 1.4vw, 14px)",
        whiteSpace: "pre",
        color: syntax.base,
      }}
    >
      <span style={{ color: syntax.func }}>defineEmailProvider</span>
      <span style={{ color: syntax.punctuation }}>{"({ id: "}</span>
      <span style={{ color: syntax.string }}>"postmark"</span>
      <span style={{ color: syntax.punctuation }}>{" })"}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The clip — phases off one looping web frame clock, holding the pipeline
// still across the phase boundary so the swap reads as config, not rebuild.
// ---------------------------------------------------------------------------

export function ByoProvider() {
  const { ref, frame } = useLoopFrame(TOTAL_FRAMES, FPS);
  const inDraw = frame < DRAW_FRAMES;
  const phase: "draw" | "swap" = inDraw ? "draw" : "swap";
  const localFrame = inDraw ? frame : frame - DRAW_FRAMES;

  // Bottom red bloom blooms as the active provider locks into the socket.
  const glowCue = inDraw ? ARRIVALS[4] + 8 : 70;
  const glowIn = interpolate(localFrame, [glowCue, glowCue + 30], [0.4, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div ref={ref} style={ROOT_STYLE}>
      {/* Bottom red bloom — the atmospheric wash the code windows use. */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          background: `radial-gradient(60% 55% at 50% 86%, rgba(246,72,56,${
            0.14 * glowIn
          }), transparent 70%)`,
          filter: "blur(40px)",
        }}
      />
      {/* Two faint vertical gutter hairlines — the docs PageFrame motif. */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: 22,
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
          right: 22,
          width: 1,
          backgroundColor: theme.frameLine,
          pointerEvents: "none",
        }}
      />

      <div
        className="absolute inset-0 flex flex-col items-center justify-center"
        style={{
          gap: "clamp(22px, 4vh, 40px)",
          padding: "clamp(24px, 5%, 56px)",
          transform: `scale(${punchIn(localFrame, FPS)})`,
          transformOrigin: "center",
        }}
      >
        <Eyebrow
          frame={frame}
          text={inDraw ? "Bring your own provider" : "Swap the wire"}
        />

        <Pipeline frame={localFrame} phase={phase} />

        {/* Slot beneath the pipeline — the only thing that changes per phase. */}
        <div
          className="flex flex-col items-center justify-start"
          style={{ gap: 14, minHeight: "clamp(72px, 12vh, 96px)" }}
        >
          {inDraw ? (
            <Caption
              frame={localFrame}
              text="The engine owns the pipeline."
              delay={ARRIVALS[4] + 14}
            />
          ) : (
            <>
              <EnvLine frame={localFrame} startDelay={20} />
              <ContractCode frame={localFrame} delay={40} />
              <Caption
                frame={localFrame}
                text="Swap the wire. Nothing else moves."
                delay={56}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
