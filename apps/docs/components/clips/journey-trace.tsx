"use client";

import {
  type CSSProperties,
  type ReactNode,
  type Ref,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/cn";
import { glide, interpolate, pop, punchIn } from "./clip-anim";
import { syntax, theme, typo } from "./clip-theme";
import { type CodeLine, tokenize } from "./clip-tokenizer";
import type { ClipSpec, ClipStep } from "./clip-types";
import { useLoopFrame, useShotFrame } from "./use-loop-frame";

// ---------------------------------------------------------------------------
// Native port of the Remotion JourneyClip engine
// (marketing/video/src/videos/journey-clips/trace.tsx): real journey code on
// one side, the run executing it on the other. Drives off a single looping
// web frame clock instead of Remotion's useCurrentFrame()/useVideoConfig(),
// and collapses useFormat's 3-ratio system into one responsive layout
// (side-by-side on lg+, stacked on mobile). All animation math is preserved.
// ---------------------------------------------------------------------------

const FPS = 30;

// Natural column widths at scale 1. The stage measures its own container and
// scales BOTH columns down to fit (fonts, chips, and row heights all derive
// from the scale), so the run rail never clips — the old viewport-breakpoint
// layout clipped hard inside the 1024px hero demo window.
const CODE_WIDTH = 560;
const RAIL_WIDTH = 480;
const COLUMN_GAP = 32;
// Below this container width the columns stack instead of shrinking further.
const STACK_BELOW = 760;
// Rail scale at stage scale 1 — the web only needs one good size.
const S = 0.82;

/** Measured content-box width of the stage's flex wrapper — drives the
 * fit-to-container scale. Null until mounted (first paint uses natural). */
function useStageWidth() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === "number" && w > 0) setWidth(w);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

// ---------------------------------------------------------------------------
// Timing — ported EXACTLY from the reference.
// ---------------------------------------------------------------------------

// Per-kind beat lengths.
const stepFrames = (s: ClipStep): number => {
  switch (s.kind) {
    case "event":
      return 55;
    case "send":
      return s.clicked ? 88 : 70;
    case "sleep":
      return 60;
    case "check":
      return s.candidates?.length ? 95 : 70;
    case "wait":
      return 100;
    case "exit":
      return 75;
    case "fanout":
      return 44 + s.events.length * 20 + 30;
  }
};

// Rail row heights (× stage scale at render time).
const rowHeight = (s: ClipStep): number => {
  switch (s.kind) {
    case "send":
      return 96;
    case "check":
      return s.candidates?.length ? 150 : 64;
    case "wait":
      return 96;
    default:
      return 64;
  }
};

const HOLD = 40;
const START = 10;

export const clipTimes = (steps: ClipStep[]): number[] => {
  const times: number[] = [];
  let t = START;
  for (const s of steps) {
    times.push(t);
    t += stepFrames(s);
  }
  return times;
};

export const clipDuration = (steps: ClipStep[]): number => {
  const times = clipTimes(steps);
  const last = steps[steps.length - 1];
  const lastAt = times[times.length - 1];
  return (lastAt ?? START) + (last ? stepFrames(last) : 0) + HOLD;
};

// Multi-point ramp — the shared `interpolate` only takes 2-element ranges,
// but the reference uses 4-point fade-in/hold/fade-out ranges in a couple of
// spots. This delegates to the 2-point `interpolate` per matched segment,
// preserving the exact `interpolate(p, [a,b,c,d], [0,1,1,0])` behaviour.
const rampN = (
  input: number,
  inputRange: readonly number[],
  outputRange: readonly number[],
): number => {
  if (input <= (inputRange[0] ?? 0)) {
    return outputRange[0] ?? 0;
  }
  const last = inputRange.length - 1;
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

// ---------------------------------------------------------------------------
// Motion accents (same language as the launch videos) — `frame` is supplied
// by the looped clock and threaded down as a prop.
// ---------------------------------------------------------------------------

function Ripple({
  frame,
  at,
  size,
}: {
  frame: number;
  at: number;
  size: number;
}) {
  const p = frame - at;
  if (p < 0 || p > 28) {
    return null;
  }
  const d = interpolate(p, [0, 28], [size, size * 3.4]);
  return (
    <span
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        width: d,
        height: d,
        transform: "translate(-50%, -50%)",
        border: `2px solid ${theme.accent}`,
        borderRadius: "50%",
        opacity: interpolate(p, [0, 28], [0.55, 0]),
        pointerEvents: "none",
      }}
    />
  );
}

function Sweep({ frame, at }: { frame: number; at: number }) {
  const p = frame - at;
  if (p < 2 || p > 28) {
    return null;
  }
  const x = interpolate(p, [2, 28], [-10, 110]);
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        borderRadius: "inherit",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: `${x}%`,
          width: "22%",
          transform: "translateX(-50%)",
          background:
            "linear-gradient(90deg, transparent, rgba(246,72,56,0.16), transparent)",
          opacity: rampN(p, [2, 8, 22, 28], [0, 1, 1, 0]),
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Code panel — band glides between the steps' line ranges.
// ---------------------------------------------------------------------------

function CodePanel({
  frame,
  file,
  lines,
  steps,
  times,
  size = 14,
  natural = false,
}: {
  frame: number;
  file: string;
  lines: CodeLine[];
  steps: ClipStep[];
  times: number[];
  size?: number;
  /** Size the window to its longest line (max-content) instead of filling its
   * parent — used when stacked on mobile so the enclosing `overflow-x-auto`
   * wrapper can scroll the code instead of the window clipping it. */
  natural?: boolean;
}) {
  const codeLineH = 1.6;
  const lineH = size * codeLineH;
  const padY = Math.round(size * 1.0);
  const padX = Math.round(size * 1.3);

  const move = times.map((t) => glide(frame, FPS, t));
  const progress = times.map((t) => pop(frame, FPS, t));
  const first = steps[0];
  let bandTop = (first?.band[0] ?? 0) * lineH;
  let bandH = (first?.band[1] ?? 1) * lineH;
  steps.forEach((step, i) => {
    if (i === 0) {
      return;
    }
    bandTop = interpolate(
      move[i] ?? 0,
      [0, 1],
      [bandTop, step.band[0] * lineH],
    );
    bandH = interpolate(move[i] ?? 0, [0, 1], [bandH, step.band[1] * lineH]);
  });

  const weights = progress.map((p, i) =>
    Math.max(0, p - (progress[i + 1] ?? 0)),
  );
  const lineOpacity = (li: number): number => {
    const focus = steps.reduce((acc, step, i) => {
      const inBand = li >= step.band[0] && li < step.band[0] + step.band[1];
      return acc + (inBand ? (weights[i] ?? 0) : 0);
    }, 0);
    return interpolate(progress[0] ?? 0, [0, 1], [1, 0.5 + 0.5 * focus]);
  };

  return (
    // Window chrome ported from the docs CodeMock (components/ds/mockup.tsx):
    // three dots + filename in mono at white/40, 10px radius, white/10 border.
    <div
      style={{
        overflow: "hidden",
        width: natural ? "max-content" : undefined,
        borderRadius: 16,
        backgroundColor: theme.paperPure,
        border: `1px solid ${theme.cardBorder}`,
        boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
      }}
    >
      <div className="flex items-center gap-3 border-white/[0.08] border-b px-4 py-2.5">
        <div aria-hidden="true" className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-white/15" />
          <span className="size-2.5 rounded-full bg-white/15" />
          <span className="size-2.5 rounded-full bg-white/15" />
        </div>
        <span className="font-mono text-[11px] text-white/40 tracking-wide">
          {file}
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
        {/* Straight left edge — a rounded corner on the 2px accent border
            curls top+bottom and reads as a stray "(" glyph beside the code. */}
        <div
          style={{
            position: "absolute",
            left: padX * 0.45,
            right: padX * 0.45,
            top: padY + bandTop,
            height: bandH,
            opacity: progress[0],
            backgroundColor: theme.accentTint,
            borderLeft: `2px solid ${theme.accent}`,
            borderRadius: "0 8px 8px 0",
            boxShadow: "0 0 26px rgba(246,72,56,0.12)",
          }}
        />
        {lines.map((line, li) => {
          const cascade = pop(frame, FPS, 4 + li * 2);
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: static code
              key={`l-${li}`}
              style={{
                position: "relative",
                minHeight: lineH,
                opacity: cascade * lineOpacity(li),
                transform: `translateY(${interpolate(
                  cascade,
                  [0, 1],
                  [8, 0],
                )}px)`,
              }}
            >
              {line.map((token, ti) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: static
                  key={`${li}-${ti}`}
                  style={{
                    color: token.emphasis
                      ? syntax.emphasis
                      : syntax[token.kind === "plain" ? "base" : token.kind],
                  }}
                >
                  {token.text}
                </span>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rail rows
// ---------------------------------------------------------------------------

function KindChip({
  label,
  accent = false,
  s,
}: {
  label: string;
  accent?: boolean;
  s: number;
}) {
  return (
    <span
      className="font-mono"
      style={{
        display: "inline-flex",
        justifyContent: "center",
        width: 86 * s,
        flexShrink: 0,
        padding: `${6 * s}px 0`,
        borderRadius: 5 * s,
        border: `1px solid ${accent ? theme.accent : theme.hairlineFaint}`,
        backgroundColor: accent ? theme.accentTint : theme.tagFill,
        fontSize: 16 * s,
        lineHeight: 1,
        color: accent ? theme.text : theme.textMuted,
      }}
    >
      {label}
    </span>
  );
}

function RowShell({
  frame,
  at,
  height,
  s,
  column = false,
  children,
}: {
  frame: number;
  at: number;
  height: number;
  s: number;
  column?: boolean;
  children?: ReactNode;
}) {
  const g = glide(frame, FPS, at);
  const a = pop(frame, FPS, at);
  const flash = Math.max(0, 1 - Math.max(0, frame - at) / 24);
  return (
    <div
      style={{
        position: "relative",
        height,
        display: "flex",
        flexDirection: column ? "column" : "row",
        alignItems: column ? "stretch" : "center",
        justifyContent: column ? "center" : "flex-start",
        gap: column ? 14 * s : 18 * s,
        padding: `0 ${22 * s}px`,
        border: `1px solid ${theme.hairlineFaint}`,
        borderRadius: 10 * s,
        backgroundColor: theme.cardFill,
        opacity: a,
        transform: `translateX(${interpolate(g, [0, 1], [46, 0])}px) scale(${
          0.985 + 0.015 * g
        })`,
        boxShadow: `0 0 ${22 * s * flash}px rgba(246,72,56,${
          0.2 * flash
        }), inset 0 0 0 1px rgba(246,72,56,${0.5 * flash})`,
      }}
    >
      <Sweep frame={frame} at={at} />
      {children}
    </div>
  );
}

function Tick({
  frame,
  label,
  at,
  s,
  ripple = false,
}: {
  frame: number;
  label: string;
  at: number;
  s: number;
  ripple?: boolean;
}) {
  const live = frame >= at;
  const p = pop(frame, FPS, at);
  return (
    <span
      className="font-mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7 * s,
        fontSize: 16 * s,
        color: theme.textMuted,
        opacity: live ? 1 : 0.3,
        whiteSpace: "pre",
      }}
    >
      {label}
      <span
        style={{
          position: "relative",
          color: theme.accent,
          display: "inline-block",
          opacity: live ? 1 : 0,
          transform: `scale(${live ? interpolate(p, [0, 1], [1.7, 1]) : 0})`,
        }}
      >
        {ripple ? <Ripple frame={frame} at={at} size={22 * s} /> : null}✓
      </span>
    </span>
  );
}

function MonoText({
  s,
  dim = false,
  truncate = false,
  children,
}: {
  s: number;
  dim?: boolean;
  /** Clip with an ellipsis instead of overflowing the row (needs a flex
   * parent that lets this shrink — pair with minWidth: 0). */
  truncate?: boolean;
  children?: ReactNode;
}) {
  return (
    <span
      className="font-mono"
      style={{
        fontSize: 18 * s,
        color: dim ? theme.textHint : theme.text,
        whiteSpace: "pre",
        ...(truncate
          ? {
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }
          : null),
      }}
    >
      {children}
    </span>
  );
}

function EventRow({
  frame,
  at,
  height,
  s,
  event,
  who = "doug@hogsend.com",
}: {
  frame: number;
  at: number;
  height: number;
  s: number;
  event: string;
  who?: string;
}) {
  const enrolled = pop(frame, FPS, at + 14);
  return (
    <RowShell frame={frame} at={at} height={height} s={s}>
      <KindChip label="event" s={s} />
      <MonoText s={s} truncate>
        {event}
        <span style={{ color: theme.textHint }}> · {who}</span>
      </MonoText>
      <span
        className="font-mono"
        style={{
          marginLeft: "auto",
          flexShrink: 0,
          opacity: enrolled,
          transform: `scale(${interpolate(enrolled, [0, 1], [1.4, 1])})`,
          fontSize: 16 * s,
          color: theme.textMuted,
          whiteSpace: "pre",
        }}
      >
        enrolled <span style={{ color: theme.accent }}>✓</span>
      </span>
    </RowShell>
  );
}

function SendRow({
  frame,
  at,
  height,
  s,
  subject,
  clicked = false,
  accent = false,
}: {
  frame: number;
  at: number;
  height: number;
  s: number;
  subject: string;
  clicked?: boolean;
  accent?: boolean;
}) {
  return (
    <RowShell frame={frame} at={at} height={height} s={s}>
      <KindChip label="send" accent={accent} s={s} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10 * s,
          minWidth: 0,
        }}
      >
        <span
          className="font-sans"
          style={{
            fontWeight: 500,
            fontSize: 21 * s,
            letterSpacing: typo.tracking,
            color: theme.text,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {subject}
        </span>
        <span style={{ display: "inline-flex", gap: 18 * s }}>
          <Tick frame={frame} label="delivered" at={at + 18} s={s} />
          <Tick frame={frame} label="opened" at={at + 36} s={s} />
          {clicked ? (
            <Tick frame={frame} label="clicked" at={at + 54} s={s} ripple />
          ) : null}
        </span>
      </div>
    </RowShell>
  );
}

function SleepRow({
  frame,
  at,
  height,
  s,
  label,
  days,
}: {
  frame: number;
  at: number;
  height: number;
  s: number;
  label: string;
  days?: number;
}) {
  const t = interpolate(frame, [at + 6, at + 46], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const day = days ? Math.min(days, Math.floor(t * days + 0.0001)) : 0;
  const dayPop = days ? pop(frame, FPS, at + 6 + (day / days) * 40) : 0;
  const shimmerX = ((frame - at) % 30) / 30;
  return (
    <RowShell frame={frame} at={at} height={height} s={s}>
      <KindChip label="sleep" s={s} />
      <div
        style={{
          position: "relative",
          flex: 1,
          height: 4 * s,
          borderRadius: 999,
          backgroundColor: theme.tagFill,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: `${t * 100}%`,
            borderRadius: 999,
            backgroundColor: theme.accent,
            overflow: "hidden",
          }}
        >
          {t > 0.02 && t < 1 ? (
            <div
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: `${shimmerX * 130 - 30}%`,
                width: "30%",
                background:
                  "linear-gradient(90deg, transparent, rgba(255,255,255,0.55), transparent)",
              }}
            />
          ) : null}
        </div>
      </div>
      <span
        className="font-mono"
        style={{
          fontSize: 16 * s,
          color: theme.textMuted,
          whiteSpace: "pre",
          width: 140 * s,
          textAlign: "right",
        }}
      >
        {days ? (
          <>
            day{" "}
            <span
              style={{
                display: "inline-block",
                color: theme.text,
                transform: `scale(${interpolate(dayPop, [0, 1], [1.5, 1])})`,
              }}
            >
              {day}
            </span>{" "}
            of {days}
          </>
        ) : (
          label
        )}
      </span>
    </RowShell>
  );
}

function CheckRow({
  frame,
  at,
  height,
  s,
  question,
  sub,
  candidates,
  verdict,
}: {
  frame: number;
  at: number;
  height: number;
  s: number;
  question: string;
  sub?: string;
  candidates?: string[];
  verdict: string;
}) {
  const verdictAt = at + (candidates?.length ? 66 : 30);
  const v = pop(frame, FPS, verdictAt);
  const header = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 18 * s,
        minWidth: 0,
      }}
    >
      <KindChip label="check" s={s} />
      <MonoText s={s} truncate>
        {question}
        {/* At demo scale the sub truncates to a couple of glyphs — noise. */}
        {sub && s >= 0.7 ? (
          <span style={{ color: theme.textHint }}> · {sub}</span>
        ) : null}
      </MonoText>
      <span
        style={{
          position: "relative",
          marginLeft: "auto",
          flexShrink: 0,
          opacity: v,
          transform: `scale(${interpolate(v, [0, 1], [1.35, 1])})`,
        }}
      >
        <Ripple frame={frame} at={verdictAt} size={34 * s} />
        <span
          className="font-mono"
          style={{
            display: "inline-flex",
            alignItems: "center",
            padding: `${6 * s}px ${12 * s}px`,
            borderRadius: 5 * s,
            border: `1px solid ${theme.accent}`,
            backgroundColor: theme.accentTint,
            fontSize: 16 * s,
            lineHeight: 1,
            color: theme.text,
            whiteSpace: "pre",
          }}
        >
          {verdict}
        </span>
      </span>
    </div>
  );
  if (!candidates?.length) {
    return (
      <RowShell frame={frame} at={at} height={height} s={s}>
        <div style={{ width: "100%" }}>{header}</div>
      </RowShell>
    );
  }
  return (
    <RowShell frame={frame} at={at} height={height} s={s} column>
      {header}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12 * s,
          paddingLeft: (86 + 18) * s,
        }}
      >
        {candidates.map((raw, i) => {
          // A trailing "*" marks the candidate that MATCHES — it lights up
          // instead of being struck.
          const isMatch = raw.endsWith("*");
          const ev = isMatch ? raw.slice(0, -1) : raw;
          const appearAt = at + 14 + i * 16;
          const strikeAt = at + 26 + i * 16;
          const appear = glide(frame, FPS, appearAt);
          const judged = frame >= strikeAt;
          const struck = judged && !isMatch;
          const sp = frame - strikeAt;
          const shake =
            sp >= 0 && sp < 8 && !isMatch
              ? Math.sin(sp * 2.4) * 2.6 * (1 - sp / 8)
              : 0;
          const lit = judged && isMatch;
          return (
            <span
              key={ev}
              className="font-mono"
              style={{
                position: "relative",
                display: "inline-flex",
                alignItems: "center",
                gap: 8 * s,
                opacity: pop(frame, FPS, appearAt) * (struck ? 0.38 : 1),
                transform: `translateX(${
                  interpolate(appear, [0, 1], [26, 0]) + shake
                }px) scale(${struck ? 0.96 : 1})`,
                fontSize: 16 * s,
                color: lit ? theme.text : theme.textBody,
                border: `1px solid ${lit ? theme.accent : theme.hairlineFaint}`,
                backgroundColor: lit ? theme.accentTint : "transparent",
                borderRadius: 6 * s,
                padding: `${6 * s}px ${12 * s}px`,
                whiteSpace: "pre",
              }}
            >
              {lit ? (
                <Ripple frame={frame} at={strikeAt} size={26 * s} />
              ) : null}
              {ev}
              {struck ? <span style={{ color: theme.textHint }}>✗</span> : null}
              {lit ? <span style={{ color: theme.accent }}>✓</span> : null}
            </span>
          );
        })}
      </div>
    </RowShell>
  );
}

function WaitRow({
  frame,
  at,
  height,
  s,
  event,
  timeout,
  resolve,
}: {
  frame: number;
  at: number;
  height: number;
  s: number;
  event: string;
  timeout: string;
  resolve: string;
}) {
  const resolveAt = at + 56;
  const r = glide(frame, FPS, resolveAt);
  const resolved = frame >= resolveAt;
  const dots = ".".repeat((Math.floor(Math.max(0, frame - at) / 14) % 3) + 1);
  return (
    <RowShell frame={frame} at={at} height={height} s={s}>
      <KindChip label="wait" s={s} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10 * s,
          minWidth: 0,
          flex: 1,
        }}
      >
        <MonoText s={s} truncate>
          {event}
          <span style={{ color: theme.textHint }}> · timeout {timeout}</span>
        </MonoText>
        <span
          className="font-mono"
          style={{
            fontSize: 16 * s,
            color: theme.textHint,
            whiteSpace: "pre",
          }}
        >
          {resolved ? "resolved" : `waiting${dots}`}
        </span>
      </div>
      <span
        style={{
          position: "relative",
          marginLeft: "auto",
          opacity: pop(frame, FPS, resolveAt),
          transform: `translateX(${interpolate(r, [0, 1], [30, 0])}px)`,
        }}
      >
        <Ripple frame={frame} at={resolveAt} size={34 * s} />
        <span
          className="font-mono"
          style={{
            display: "inline-flex",
            alignItems: "center",
            padding: `${6 * s}px ${12 * s}px`,
            borderRadius: 5 * s,
            border: `1px solid ${theme.accent}`,
            backgroundColor: theme.accentTint,
            fontSize: 16 * s,
            lineHeight: 1,
            color: theme.text,
            whiteSpace: "pre",
          }}
        >
          {resolve}
        </span>
      </span>
    </RowShell>
  );
}

function ExitRow({
  frame,
  at,
  height,
  s,
  event,
  note,
}: {
  frame: number;
  at: number;
  height: number;
  s: number;
  event: string;
  note: string;
}) {
  const done = pop(frame, FPS, at + 16);
  return (
    <RowShell frame={frame} at={at} height={height} s={s}>
      <KindChip label="exit" accent s={s} />
      <MonoText s={s}>
        {event}
        <span style={{ color: theme.textHint }}> · {note}</span>
      </MonoText>
      <span
        className="font-mono"
        style={{
          marginLeft: "auto",
          opacity: done,
          transform: `scale(${interpolate(done, [0, 1], [1.4, 1])})`,
          fontSize: 16 * s,
          color: theme.textMuted,
          whiteSpace: "pre",
        }}
      >
        journey exited <span style={{ color: theme.accent }}>✓</span>
      </span>
    </RowShell>
  );
}

/** fan-out row — payload pills fly across the lane into a destination chip. */
function FanoutRow({
  frame,
  at,
  height,
  s,
  label = "emit",
  events,
  dest = "PostHog",
  logo = "posthog.svg",
}: {
  frame: number;
  at: number;
  height: number;
  s: number;
  label?: string;
  events: string[];
  dest?: string;
  logo?: string;
}) {
  const FLIGHT = 26;
  const arrivals = events.map((_, i) => at + 14 + i * 20 + FLIGHT);
  // The chip bumps on every arrival.
  const bump = arrivals.reduce((acc, a) => {
    const p = frame - a;
    return Math.max(acc, p >= 0 && p < 12 ? 1 - p / 12 : 0);
  }, 0);
  const maskStyle: CSSProperties = {
    width: 20 * s,
    height: 20 * s,
    backgroundColor: theme.text,
    maskImage: `url(/logos/${logo})`,
    maskSize: "contain",
    maskRepeat: "no-repeat",
    maskPosition: "center",
    WebkitMaskImage: `url(/logos/${logo})`,
    WebkitMaskSize: "contain",
    WebkitMaskRepeat: "no-repeat",
    WebkitMaskPosition: "center",
  };
  return (
    <RowShell frame={frame} at={at} height={height} s={s}>
      <KindChip label={label} s={s} />
      {/* Flight lane */}
      <div style={{ position: "relative", flex: 1, height: "100%" }}>
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: "50%",
            height: 1,
            backgroundColor: theme.hairlineFaint,
          }}
        />
        {events.map((ev, i) => {
          const launch = at + 14 + i * 20;
          const t = interpolate(frame, [launch, launch + FLIGHT], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          const visible =
            frame >= launch && frame <= launch + FLIGHT + 4 ? 1 : 0;
          if (!visible) {
            return null;
          }
          return (
            <span
              key={ev}
              className="font-mono"
              style={{
                position: "absolute",
                left: `${t * 100}%`,
                top: "50%",
                transform: `translate(${-t * 100}%, -50%)`,
                opacity: rampN(t, [0, 0.08, 0.85, 1], [0, 1, 1, 0]),
                fontSize: 16 * s,
                color: theme.text,
                border: `1px solid ${theme.hairline}`,
                borderRadius: 6 * s,
                padding: `${6 * s}px ${12 * s}px`,
                backgroundColor: theme.paperPure,
                whiteSpace: "pre",
              }}
            >
              {ev}
            </span>
          );
        })}
        {/* Parked after arrival — the settled frame otherwise leaves a bare
            hairline, which reads as broken. The delivered payload rests at
            the destination end with a tick. */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 10 * s,
            paddingRight: 4 * s,
            pointerEvents: "none",
            // Two parked pills can outgrow a narrow lane — clip at the lane
            // edge rather than overlapping the kind chip to the left.
            overflow: "hidden",
          }}
        >
          {events.map((ev, i) => {
            const arriveAt = at + 14 + i * 20 + FLIGHT;
            if (frame < arriveAt + 2) {
              return null;
            }
            const settle = pop(frame, FPS, arriveAt + 2);
            return (
              <span
                key={ev}
                className="font-mono"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7 * s,
                  fontSize: 16 * s,
                  color: theme.textMuted,
                  border: `1px solid ${theme.hairlineFaint}`,
                  borderRadius: 6 * s,
                  padding: `${6 * s}px ${12 * s}px`,
                  backgroundColor: theme.tagFill,
                  whiteSpace: "pre",
                  opacity: 0.9 * settle,
                  transform: `scale(${interpolate(settle, [0, 1], [0.92, 1])})`,
                }}
              >
                {ev}
                <span style={{ color: theme.accent }}>✓</span>
              </span>
            );
          })}
        </div>
      </div>
      {/* Destination chip */}
      <span
        style={{
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          gap: 10 * s,
          padding: `${9 * s}px ${16 * s}px`,
          borderRadius: 7 * s,
          border: `1px solid ${theme.hairline}`,
          backgroundColor: theme.slotFill,
          transform: `scale(${1 + 0.09 * bump})`,
          flexShrink: 0,
        }}
      >
        {arrivals.map((a) => (
          <Ripple key={a} frame={frame} at={a} size={30 * s} />
        ))}
        <span style={maskStyle} />
        <span
          className="font-sans"
          style={{
            fontWeight: 500,
            fontSize: 17 * s,
            letterSpacing: typo.tracking,
            color: theme.text,
            whiteSpace: "pre",
          }}
        >
          {dest}
        </span>
      </span>
    </RowShell>
  );
}

// ---------------------------------------------------------------------------
// Rail — renders all rows. The web layout fits every row, so there's no
// window-scrolling (the reference's maxVisible scroll is dropped: on the web
// we always show the whole run).
// ---------------------------------------------------------------------------

function Rail({
  frame,
  steps,
  times,
  s = S,
}: {
  frame: number;
  steps: ClipStep[];
  times: number[];
  s?: number;
}) {
  const gap = 16 * s;
  return (
    <div style={{ position: "relative", width: "100%" }}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap,
        }}
      >
        {steps.map((step, i) => {
          const at = times[i] ?? START;
          const h = rowHeight(step) * s;
          const key = `${step.kind}-${i}`;
          switch (step.kind) {
            case "event":
              return (
                <EventRow
                  key={key}
                  frame={frame}
                  at={at}
                  height={h}
                  s={s}
                  event={step.event}
                  who={step.who}
                />
              );
            case "send":
              return (
                <SendRow
                  key={key}
                  frame={frame}
                  at={at}
                  height={h}
                  s={s}
                  subject={step.subject}
                  clicked={step.clicked}
                  accent={step.accent}
                />
              );
            case "sleep":
              return (
                <SleepRow
                  key={key}
                  frame={frame}
                  at={at}
                  height={h}
                  s={s}
                  label={step.label}
                  days={step.days}
                />
              );
            case "check":
              return (
                <CheckRow
                  key={key}
                  frame={frame}
                  at={at}
                  height={h}
                  s={s}
                  question={step.question}
                  sub={step.sub}
                  candidates={step.candidates}
                  verdict={step.verdict}
                />
              );
            case "wait":
              return (
                <WaitRow
                  key={key}
                  frame={frame}
                  at={at}
                  height={h}
                  s={s}
                  event={step.event}
                  timeout={step.timeout}
                  resolve={step.resolve}
                />
              );
            case "exit":
              return (
                <ExitRow
                  key={key}
                  frame={frame}
                  at={at}
                  height={h}
                  s={s}
                  event={step.event}
                  note={step.note}
                />
              );
            case "fanout":
              return (
                <FanoutRow
                  key={key}
                  frame={frame}
                  at={at}
                  height={h}
                  s={s}
                  label={step.label}
                  events={step.events}
                  dest={step.dest}
                  logo={step.logo}
                />
              );
            default:
              return null;
          }
        })}
      </div>
    </div>
  );
}

/** Small mono-feel uppercase eyebrow — the docs `.eyebrow` label language. */
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
// The whole clip: bare trace stage with a subtle bottom red glow, looping.
// ---------------------------------------------------------------------------

function JourneyTraceView({
  frame,
  spec,
  innerRef,
}: {
  frame: number;
  spec: ClipSpec;
  innerRef: Ref<HTMLDivElement>;
}) {
  const total = clipDuration(spec.steps);
  const times = clipTimes(spec.steps);
  const lines = tokenize(spec.code);

  // Fit-to-container: scale both fixed-metric columns down together so the
  // side-by-side layout survives any host (hero demo window, use-case pages);
  // stack below STACK_BELOW instead of shrinking into illegibility.
  const { ref: stageRef, width } = useStageWidth();
  const available = width ?? CODE_WIDTH + COLUMN_GAP + RAIL_WIDTH;
  const sideBySide = available >= STACK_BELOW;
  const k = sideBySide
    ? Math.min(1, (available - COLUMN_GAP) / (CODE_WIDTH + RAIL_WIDTH))
    : 1;
  const codeSize = sideBySide ? 14 * k : 12.5;
  const railScale = sideBySide ? S * k : 0.72;

  // The payoff moment: the last clicked send's tick, else the last step.
  let payoffAt = (times[times.length - 1] ?? START) + 20;
  spec.steps.forEach((step, i) => {
    if (step.kind === "send" && step.clicked) {
      payoffAt = (times[i] ?? START) + 54;
    }
  });

  const push = interpolate(frame, [0, total], [1, 1.03], {
    extrapolateRight: "clamp",
  });
  const glowIn = interpolate(frame, [payoffAt, payoffAt + 36], [0, 0.9], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      ref={innerRef}
      className="relative overflow-hidden rounded-xl"
      style={{ backgroundColor: theme.ink }}
    >
      {/* Subtle bottom red glow (the reference's SceneShell aurora). */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          background: `radial-gradient(60% 50% at 50% 108%, rgba(246,72,56,${
            0.16 * glowIn
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
        ref={stageRef}
        className={cn(
          "flex p-5 md:p-8",
          sideBySide
            ? "flex-row items-center justify-center"
            : "flex-col items-stretch gap-7",
        )}
        style={{
          gap: sideBySide ? COLUMN_GAP : undefined,
          transform: `scale(${punchIn(frame, FPS) * push})`,
          transformOrigin: "center",
        }}
      >
        <div
          className={cn(
            "shrink-0",
            // Stacked (mobile): scroll the code horizontally under a hidden
            // scrollbar with a right-edge fade cueing "swipe for more", rather
            // than hard-clipping the long lines (the window is max-content wide).
            !sideBySide &&
              "w-full overflow-x-auto [scrollbar-width:none] [mask-image:linear-gradient(to_right,#000_88%,transparent)] [&::-webkit-scrollbar]:hidden",
          )}
          style={{ width: sideBySide ? CODE_WIDTH * k : undefined }}
        >
          <CodePanel
            frame={frame}
            file={spec.file}
            lines={lines}
            steps={spec.steps}
            times={times}
            size={codeSize}
            natural={!sideBySide}
          />
        </div>
        <div
          className="flex shrink-0 flex-col"
          style={{ width: sideBySide ? RAIL_WIDTH * k : "100%" }}
        >
          <div style={{ paddingBottom: 18 }}>
            <Eyebrow frame={frame} text="The run" />
          </div>
          <Rail frame={frame} steps={spec.steps} times={times} s={railScale} />
        </div>
      </div>
    </div>
  );
}

/**
 * Looping clip — the default driver used across the docs (use-cases,
 * /components, how-it-works, …). Plays forever while on-screen.
 */
export function JourneyTrace({ spec }: { spec: ClipSpec }) {
  const { ref, frame } = useLoopFrame(clipDuration(spec.steps), FPS);
  return <JourneyTraceView frame={frame} spec={spec} innerRef={ref} />;
}

/**
 * One-shot driver for the live home demo — replays the run from the top each
 * time `playToken` changes (i.e. each time the visitor fires an event), then
 * holds on the settled final frame. Same visual engine as `JourneyTrace`, just
 * a different clock.
 */
export function JourneyShot({
  spec,
  playToken,
}: {
  spec: ClipSpec;
  playToken: number;
}) {
  const { ref, frame } = useShotFrame(clipDuration(spec.steps), FPS, playToken);
  return <JourneyTraceView frame={frame} spec={spec} innerRef={ref} />;
}
