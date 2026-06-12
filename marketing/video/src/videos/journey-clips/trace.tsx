import type React from "react";
import {
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { CardChrome } from "../../components/CardChrome";
import { Eyebrow } from "../../components/Labels";
import { SceneShell } from "../../components/SceneShell";
import { FONT_BODY, FONT_MONO } from "../../fonts";
import { pop, punchIn } from "../../lib/anim";
import { type CodeLine, tokenize } from "../../lib/code-tokenizer";
import { useFormat } from "../../lib/format";
import { syntax, theme } from "../../lib/theme";

// ---------------------------------------------------------------------------
// The journey-trace engine behind every clip: real journey code on one
// side, the run executing it on the other. Clips are bare — no hooks, no
// end cards — so they can loop in a landing-page section or doc.
// ---------------------------------------------------------------------------

export type ClipStep =
  | { kind: "event"; event: string; who?: string; band: [number, number] }
  | {
      kind: "send";
      subject: string;
      clicked?: boolean;
      accent?: boolean;
      band: [number, number];
    }
  | {
      kind: "sleep";
      label: string;
      /** Show a "day n of N" counter while the bar fills. */
      days?: number;
      band: [number, number];
    }
  | {
      kind: "check";
      question: string;
      sub?: string;
      /** Candidate events looked at (struck unless `found`). */
      candidates?: string[];
      /** Verdict pill text, e.g. `found: true` or `plan: "paid"`. */
      verdict: string;
      band: [number, number];
    }
  | {
      kind: "wait";
      event: string;
      timeout: string;
      /** What arrives, e.g. `score: 9`. */
      resolve: string;
      band: [number, number];
    }
  | { kind: "exit"; event: string; note: string; band: [number, number] }
  | {
      kind: "fanout";
      /** Kind-chip label (default "emit"). */
      label?: string;
      /** Payloads that fly out, in order. */
      events: string[];
      /** Destination name + logo (public/logos). */
      dest?: string;
      logo?: string;
      band: [number, number];
    };

export type ClipSpec = {
  id: string;
  file: string;
  code: string;
  steps: ClipStep[];
};

// Per-kind beat lengths and rail row heights (× stage scale).
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

// ---------------------------------------------------------------------------
// Motion helpers (same language as the launch videos).
// ---------------------------------------------------------------------------

const GLIDE = { damping: 15, mass: 0.6, stiffness: 130 } as const;
const glide = (frame: number, fps: number, delay = 0): number =>
  spring({ frame: frame - delay, fps, config: GLIDE, durationInFrames: 24 });

const Ripple: React.FC<{ at: number; size: number }> = ({ at, size }) => {
  const frame = useCurrentFrame();
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
};

const Sweep: React.FC<{ at: number }> = ({ at }) => {
  const frame = useCurrentFrame();
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
          opacity: interpolate(p, [2, 8, 22, 28], [0, 1, 1, 0]),
        }}
      />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

type Stage = {
  sideBySide: boolean;
  codeWidth: number;
  railWidth: number;
  codeFont: number;
  codeLineH: number;
  maxVisible: number;
  s: number;
};

const useStage = (rowCount: number): Stage => {
  const f = useFormat();
  const content = f.width - 2 * f.pad;
  if (f.ratio === "169") {
    // Slightly wider code column than the launch videos — clip journeys
    // carry longer real-API lines (getPostHog()?.identify(...)).
    return {
      sideBySide: true,
      codeWidth: 940,
      railWidth: content - 940 - 60,
      codeFont: 25,
      codeLineH: 1.6,
      maxVisible: rowCount,
      s: 1,
    };
  }
  if (f.isPortrait) {
    return {
      sideBySide: false,
      codeWidth: content,
      railWidth: content,
      codeFont: Math.round(26 * f.fontScale * 1.15),
      codeLineH: 1.6,
      maxVisible: Math.min(rowCount, 4),
      s: f.fontScale * 1.12,
    };
  }
  return {
    sideBySide: false,
    codeWidth: content,
    railWidth: content,
    codeFont: 17,
    codeLineH: 1.55,
    maxVisible: Math.min(rowCount, 3),
    s: f.fontScale,
  };
};

// ---------------------------------------------------------------------------
// Code panel — band glides between the steps' line ranges.
// ---------------------------------------------------------------------------

const CodePanel: React.FC<{
  stage: Stage;
  file: string;
  lines: CodeLine[];
  steps: ClipStep[];
  times: number[];
}> = ({ stage, file, lines, steps, times }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();
  const size = stage.codeFont;
  const lineH = size * stage.codeLineH;
  const padY = Math.round(size * 1.0);
  const padX = Math.round(size * 1.3);

  const move = times.map((t) => glide(frame, fps, t));
  const progress = times.map((t) => pop(frame, fps, t));
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
    <CardChrome title={file} width={stage.codeWidth} scale={f.fontScale}>
      <div
        style={{
          position: "relative",
          padding: `${padY}px ${padX}px`,
          fontFamily: FONT_MONO,
          fontSize: size,
          fontWeight: 400,
          lineHeight: stage.codeLineH,
          whiteSpace: "pre",
          color: syntax.base,
        }}
      >
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
            borderRadius: 8 * f.fontScale,
            boxShadow: `0 0 ${26 * f.fontScale}px rgba(246,72,56,0.12)`,
          }}
        />
        {lines.map((line, li) => {
          const cascade = pop(frame, fps, 4 + li * 2);
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
                    color: syntax[token.kind === "plain" ? "base" : token.kind],
                  }}
                >
                  {token.text}
                </span>
              ))}
            </div>
          );
        })}
      </div>
    </CardChrome>
  );
};

// ---------------------------------------------------------------------------
// Rail rows
// ---------------------------------------------------------------------------

const KindChip: React.FC<{ label: string; accent?: boolean; s: number }> = ({
  label,
  accent = false,
  s,
}) => (
  <span
    style={{
      display: "inline-flex",
      justifyContent: "center",
      width: 86 * s,
      flexShrink: 0,
      padding: `${6 * s}px 0`,
      borderRadius: 5 * s,
      border: `1px solid ${accent ? theme.accent : theme.hairlineFaint}`,
      backgroundColor: accent ? theme.accentTint : theme.tagFill,
      fontFamily: FONT_MONO,
      fontSize: 16 * s,
      lineHeight: 1,
      color: accent ? theme.text : theme.textMuted,
    }}
  >
    {label}
  </span>
);

const RowShell: React.FC<{
  at: number;
  height: number;
  s: number;
  column?: boolean;
  children?: React.ReactNode;
}> = ({ at, height, s, column = false, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const g = glide(frame, fps, at);
  const a = pop(frame, fps, at);
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
      <Sweep at={at} />
      {children}
    </div>
  );
};

const Tick: React.FC<{
  label: string;
  at: number;
  s: number;
  ripple?: boolean;
}> = ({ label, at, s, ripple = false }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const live = frame >= at;
  const p = pop(frame, fps, at);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7 * s,
        fontFamily: FONT_MONO,
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
        {ripple ? <Ripple at={at} size={22 * s} /> : null}✓
      </span>
    </span>
  );
};

const MonoText: React.FC<{
  s: number;
  dim?: boolean;
  children?: React.ReactNode;
}> = ({ s, dim = false, children }) => (
  <span
    style={{
      fontFamily: FONT_MONO,
      fontSize: 18 * s,
      color: dim ? theme.textHint : theme.text,
      whiteSpace: "pre",
    }}
  >
    {children}
  </span>
);

const EventRow: React.FC<{
  at: number;
  height: number;
  s: number;
  event: string;
  who?: string;
}> = ({ at, height, s, event, who = "doug@hogsend.com" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enrolled = pop(frame, fps, at + 14);
  return (
    <RowShell at={at} height={height} s={s}>
      <KindChip label="event" s={s} />
      <MonoText s={s}>
        {event}
        <span style={{ color: theme.textHint }}> · {who}</span>
      </MonoText>
      <span
        style={{
          marginLeft: "auto",
          opacity: enrolled,
          transform: `scale(${interpolate(enrolled, [0, 1], [1.4, 1])})`,
          fontFamily: FONT_MONO,
          fontSize: 16 * s,
          color: theme.textMuted,
          whiteSpace: "pre",
        }}
      >
        enrolled <span style={{ color: theme.accent }}>✓</span>
      </span>
    </RowShell>
  );
};

const SendRow: React.FC<{
  at: number;
  height: number;
  s: number;
  subject: string;
  clicked?: boolean;
  accent?: boolean;
}> = ({ at, height, s, subject, clicked = false, accent = false }) => (
  <RowShell at={at} height={height} s={s}>
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
        style={{
          fontFamily: FONT_BODY,
          fontWeight: 500,
          fontSize: 21 * s,
          letterSpacing: "-0.02em",
          color: theme.text,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {subject}
      </span>
      <span style={{ display: "inline-flex", gap: 18 * s }}>
        <Tick label="delivered" at={at + 18} s={s} />
        <Tick label="opened" at={at + 36} s={s} />
        {clicked ? <Tick label="clicked" at={at + 54} s={s} ripple /> : null}
      </span>
    </div>
  </RowShell>
);

const SleepRow: React.FC<{
  at: number;
  height: number;
  s: number;
  label: string;
  days?: number;
}> = ({ at, height, s, label, days }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = interpolate(frame, [at + 6, at + 46], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const day = days ? Math.min(days, Math.floor(t * days + 0.0001)) : 0;
  const dayPop = days ? pop(frame, fps, at + 6 + (day / days) * 40) : 0;
  const shimmerX = ((frame - at) % 30) / 30;
  return (
    <RowShell at={at} height={height} s={s}>
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
        style={{
          fontFamily: FONT_MONO,
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
};

const CheckRow: React.FC<{
  at: number;
  height: number;
  s: number;
  question: string;
  sub?: string;
  candidates?: string[];
  verdict: string;
}> = ({ at, height, s, question, sub, candidates, verdict }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const verdictAt = at + (candidates?.length ? 66 : 30);
  const v = pop(frame, fps, verdictAt);
  const header = (
    <div style={{ display: "flex", alignItems: "center", gap: 18 * s }}>
      <KindChip label="check" s={s} />
      <MonoText s={s}>
        {question}
        {sub ? <span style={{ color: theme.textHint }}> · {sub}</span> : null}
      </MonoText>
      <span
        style={{
          position: "relative",
          marginLeft: "auto",
          opacity: v,
          transform: `scale(${interpolate(v, [0, 1], [1.35, 1])})`,
        }}
      >
        <Ripple at={verdictAt} size={34 * s} />
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            padding: `${6 * s}px ${12 * s}px`,
            borderRadius: 5 * s,
            border: `1px solid ${theme.accent}`,
            backgroundColor: theme.accentTint,
            fontFamily: FONT_MONO,
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
      <RowShell at={at} height={height} s={s}>
        <div style={{ width: "100%" }}>{header}</div>
      </RowShell>
    );
  }
  return (
    <RowShell at={at} height={height} s={s} column>
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
          const appear = glide(frame, fps, appearAt);
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
              style={{
                position: "relative",
                display: "inline-flex",
                alignItems: "center",
                gap: 8 * s,
                opacity: pop(frame, fps, appearAt) * (struck ? 0.38 : 1),
                transform: `translateX(${
                  interpolate(appear, [0, 1], [26, 0]) + shake
                }px) scale(${struck ? 0.96 : 1})`,
                fontFamily: FONT_MONO,
                fontSize: 16 * s,
                color: lit ? theme.text : theme.textBody,
                border: `1px solid ${lit ? theme.accent : theme.hairlineFaint}`,
                backgroundColor: lit ? theme.accentTint : "transparent",
                borderRadius: 6 * s,
                padding: `${6 * s}px ${12 * s}px`,
                whiteSpace: "pre",
              }}
            >
              {lit ? <Ripple at={strikeAt} size={26 * s} /> : null}
              {ev}
              {struck ? <span style={{ color: theme.textHint }}>✗</span> : null}
              {lit ? <span style={{ color: theme.accent }}>✓</span> : null}
            </span>
          );
        })}
      </div>
    </RowShell>
  );
};

const WaitRow: React.FC<{
  at: number;
  height: number;
  s: number;
  event: string;
  timeout: string;
  resolve: string;
}> = ({ at, height, s, event, timeout, resolve }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const resolveAt = at + 56;
  const r = glide(frame, fps, resolveAt);
  const resolved = frame >= resolveAt;
  const dots = ".".repeat((Math.floor(Math.max(0, frame - at) / 14) % 3) + 1);
  return (
    <RowShell at={at} height={height} s={s}>
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
        <MonoText s={s}>
          {event}
          <span style={{ color: theme.textHint }}> · timeout {timeout}</span>
        </MonoText>
        <span
          style={{
            fontFamily: FONT_MONO,
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
          opacity: pop(frame, fps, resolveAt),
          transform: `translateX(${interpolate(r, [0, 1], [30, 0])}px)`,
        }}
      >
        <Ripple at={resolveAt} size={34 * s} />
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            padding: `${6 * s}px ${12 * s}px`,
            borderRadius: 5 * s,
            border: `1px solid ${theme.accent}`,
            backgroundColor: theme.accentTint,
            fontFamily: FONT_MONO,
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
};

const ExitRow: React.FC<{
  at: number;
  height: number;
  s: number;
  event: string;
  note: string;
}> = ({ at, height, s, event, note }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const done = pop(frame, fps, at + 16);
  return (
    <RowShell at={at} height={height} s={s}>
      <KindChip label="exit" accent s={s} />
      <MonoText s={s}>
        {event}
        <span style={{ color: theme.textHint }}> · {note}</span>
      </MonoText>
      <span
        style={{
          marginLeft: "auto",
          opacity: done,
          transform: `scale(${interpolate(done, [0, 1], [1.4, 1])})`,
          fontFamily: FONT_MONO,
          fontSize: 16 * s,
          color: theme.textMuted,
          whiteSpace: "pre",
        }}
      >
        journey exited <span style={{ color: theme.accent }}>✓</span>
      </span>
    </RowShell>
  );
};

/** fan-out row — payload pills fly across the lane into a destination chip. */
const FanoutRow: React.FC<{
  at: number;
  height: number;
  s: number;
  label?: string;
  events: string[];
  dest?: string;
  logo?: string;
}> = ({
  at,
  height,
  s,
  label = "emit",
  events,
  dest = "PostHog",
  logo = "posthog.svg",
}) => {
  const frame = useCurrentFrame();
  const FLIGHT = 26;
  const arrivals = events.map((_, i) => at + 14 + i * 20 + FLIGHT);
  // The chip bumps on every arrival.
  const bump = arrivals.reduce((acc, a) => {
    const p = frame - a;
    return Math.max(acc, p >= 0 && p < 12 ? 1 - p / 12 : 0);
  }, 0);
  return (
    <RowShell at={at} height={height} s={s}>
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
              style={{
                position: "absolute",
                left: `${t * 100}%`,
                top: "50%",
                transform: `translate(${-t * 100}%, -50%)`,
                opacity: interpolate(t, [0, 0.08, 0.85, 1], [0, 1, 1, 0]),
                fontFamily: FONT_MONO,
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
          <Ripple key={a} at={a} size={30 * s} />
        ))}
        <span
          style={{
            width: 20 * s,
            height: 20 * s,
            backgroundColor: theme.text,
            maskImage: `url(${staticFile(`logos/${logo}`)})`,
            maskSize: "contain",
            maskRepeat: "no-repeat",
            maskPosition: "center",
            WebkitMaskImage: `url(${staticFile(`logos/${logo}`)})`,
            WebkitMaskSize: "contain",
            WebkitMaskRepeat: "no-repeat",
            WebkitMaskPosition: "center",
          }}
        />
        <span
          style={{
            fontFamily: FONT_BODY,
            fontWeight: 500,
            fontSize: 17 * s,
            letterSpacing: "-0.02em",
            color: theme.text,
            whiteSpace: "pre",
          }}
        >
          {dest}
        </span>
      </span>
    </RowShell>
  );
};

// ---------------------------------------------------------------------------
// Rail + stage
// ---------------------------------------------------------------------------

const Rail: React.FC<{
  stage: Stage;
  steps: ClipStep[];
  times: number[];
}> = ({ stage, steps, times }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = stage.s;
  const gap = 16 * s;
  const heights = steps.map((step) => rowHeight(step) * s);
  const offsets = heights.map((_, i) =>
    heights.slice(0, i).reduce((sum, h) => sum + h + gap, 0),
  );

  let scroll = 0;
  times.forEach((t, k) => {
    if (k < stage.maxVisible) {
      return;
    }
    const target = offsets[k - stage.maxVisible + 1] ?? 0;
    scroll = interpolate(pop(frame, fps, t), [0, 1], [scroll, target]);
  });

  const totalH =
    heights.reduce((sum, h) => sum + h, 0) + gap * (heights.length - 1);
  let visibleH = totalH;
  if (stage.maxVisible < heights.length) {
    visibleH = 0;
    for (let i = 0; i + stage.maxVisible <= heights.length; i++) {
      const windowH =
        heights.slice(i, i + stage.maxVisible).reduce((sum, h) => sum + h, 0) +
        gap * (stage.maxVisible - 1);
      visibleH = Math.max(visibleH, windowH);
    }
  }

  return (
    <div
      style={{
        width: stage.railWidth,
        height: visibleH,
        overflow: "hidden",
        position: "relative",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap,
          transform: `translateY(${-scroll}px)`,
        }}
      >
        {steps.map((step, i) => {
          const at = times[i] ?? START;
          const h = heights[i] ?? 64 * s;
          const key = `${step.kind}-${i}`;
          switch (step.kind) {
            case "event":
              return (
                <EventRow
                  key={key}
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
};

/** The whole clip: bare trace stage, camera push, glow on the payoff. */
export const JourneyClip: React.FC<{ spec: ClipSpec }> = ({ spec }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();
  const stage = useStage(spec.steps.length);
  const times = clipTimes(spec.steps);
  const total = clipDuration(spec.steps);
  const lines = tokenize(spec.code);

  // The payoff moment: the last clicked send's tick, else the last step.
  let payoffAt = (times[times.length - 1] ?? START) + 20;
  spec.steps.forEach((step, i) => {
    if (step.kind === "send" && step.clicked) {
      payoffAt = (times[i] ?? START) + 54;
    }
  });

  const push = interpolate(frame, [0, total], [1, 1.05], {
    extrapolateRight: "clamp",
  });
  const descend = times.reduce((y, t) => y + pop(frame, fps, t) * 9, 0);
  const glowIn = interpolate(frame, [payoffAt, payoffAt + 36], [0, 0.9], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <SceneShell glow glowPosition="bottom" glowIntensity={glowIn}>
      <div
        style={{
          transform: `translateY(${22 - descend}px) scale(${
            punchIn(frame, fps) * push
          })`,
          display: "flex",
          flexDirection: stage.sideBySide ? "row" : "column",
          alignItems: stage.sideBySide ? "center" : "stretch",
          gap: stage.sideBySide ? 60 : 34 * stage.s,
          width: f.width - 2 * f.pad,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            width: stage.codeWidth,
          }}
        >
          <CodePanel
            stage={stage}
            file={spec.file}
            lines={lines}
            steps={spec.steps}
            times={times}
          />
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            width: stage.railWidth,
          }}
        >
          <div style={{ paddingBottom: 20 * f.fontScale }}>
            <Eyebrow text="The run" dot delay={6} />
          </div>
          <Rail stage={stage} steps={spec.steps} times={times} />
        </div>
      </div>
    </SceneShell>
  );
};
