import type React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { CardChrome } from "../../components/CardChrome";
import { EndCard } from "../../components/EndCard";
import { KineticText } from "../../components/KineticText";
import { Eyebrow, GhostNumber, Kicker, TagPill } from "../../components/Labels";
import { SceneShell } from "../../components/SceneShell";
import { FONT_BODY, FONT_MONO } from "../../fonts";
import { Beats, beat, pop, punchIn } from "../../lib/anim";
import { tokenize } from "../../lib/code-tokenizer";
import { defineVideo, type VideoProps } from "../../lib/define-video";
import { useFormat } from "../../lib/format";
import { syntax, theme } from "../../lib/theme";

// ---------------------------------------------------------------------------
// A real journey (trimmed from apps/api activation-nudge-series): wait two
// days, check whether the user touched the feature, nudge only if not. The
// video runs it live — code on one side, the run tracing on the other.
// ---------------------------------------------------------------------------

const FILE_NAME = "src/journeys/activation.ts";

const CODE = `export const activation = defineJourney({
  meta: { trigger: { event: Events.USER_CREATED } },
  run: async (user, ctx) => {
    await sendEmail({ template: "welcome" });

    await ctx.sleep({ duration: days(2) });

    const { found } = await ctx.history.hasEvent({
      event: Events.FEATURE_USED,
      within: days(2),
    });

    if (!found) {
      await sendEmail({ template: "activation-nudge" });
    }
  },
});`;

const CODE_LINES = tokenize(CODE);

// Which code lines each run step lights up (start line, line count).
const STEP_BANDS = [
  { top: 1, lines: 1 }, // trigger — doug signs up
  { top: 3, lines: 1 }, // send welcome
  { top: 5, lines: 1 }, // sleep two days
  { top: 7, lines: 4 }, // hasEvent check
  { top: 13, lines: 1 }, // nudge send
] as const;

// When each step fires (frames into the run beat).
const T = {
  enter: 10,
  welcome: 70,
  sleep: 140,
  check: 205,
  nudge: 295,
} as const;
const STEP_TIMES = [T.enter, T.welcome, T.sleep, T.check, T.nudge] as const;

const RUN_FRAMES = 405;
const CLICKED_AT = T.nudge + 64;

// The events doug actually sent in those two days — none is feature_used.
const CHECKED_EVENTS = ["page.viewed", "docs.opened", "billing.viewed"];

// ---------------------------------------------------------------------------
// Motion helpers — the run uses a softer spring with a little overshoot so
// arrivals feel kinetic, plus small accent effects (flash, sweep, ripple).
// ---------------------------------------------------------------------------

const GLIDE = { damping: 15, mass: 0.6, stiffness: 130 } as const;
const glide = (frame: number, fps: number, delay = 0): number =>
  spring({
    frame: frame - delay,
    fps,
    config: GLIDE,
    durationInFrames: 24,
  });

/** Expanding accent ring (open-pixel style) centred on the parent. */
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

/** The landing's use-case tab pills, sitting above the code card. */
const TABS = ["Activation", "Trial conversion", "Win-back"] as const;

const TabsRow: React.FC<{ delay?: number }> = ({ delay = 2 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();
  const s = f.fontScale * (f.isPortrait ? 1.1 : 1);
  return (
    <div style={{ display: "flex", gap: 10 * s }}>
      {TABS.map((tab, i) => {
        const active = i === 0;
        const a = pop(frame, fps, delay + i * 4);
        return (
          <span
            key={tab}
            style={{
              padding: `${8 * s}px ${16 * s}px`,
              borderRadius: 7 * s,
              border: `1px solid ${
                active ? theme.hairline : theme.hairlineFaint
              }`,
              backgroundColor: active ? theme.tagFill : "transparent",
              fontFamily: FONT_BODY,
              fontWeight: 400,
              fontSize: 17 * s,
              lineHeight: 1,
              letterSpacing: "-0.02em",
              color: active ? theme.text : theme.textMuted,
              opacity: a,
              transform: `translateY(${interpolate(a, [0, 1], [8, 0])}px)`,
              whiteSpace: "nowrap",
            }}
          >
            {tab}
          </span>
        );
      })}
    </div>
  );
};

/** A soft accent scanline that sweeps the row once when it fires. */
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
  /** Side-by-side (16:9) or stacked (9:16, 1:1). */
  sideBySide: boolean;
  codeWidth: number;
  railWidth: number;
  codeFont: number;
  codeLineH: number;
  /** Rail rows visible at once before old ones scroll away. */
  maxVisible: number;
  s: number;
};

const useStage = (): Stage => {
  const f = useFormat();
  const content = f.width - 2 * f.pad;
  if (f.ratio === "169") {
    return {
      sideBySide: true,
      codeWidth: 860,
      railWidth: content - 860 - 60,
      codeFont: 25,
      codeLineH: 1.6,
      maxVisible: 9,
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
      maxVisible: 9,
      s: f.fontScale * 1.12,
    };
  }
  // 1:1 — everything competes for height: small code, scrolling rail.
  return {
    sideBySide: false,
    codeWidth: content,
    railWidth: content,
    codeFont: 17,
    codeLineH: 1.55,
    maxVisible: 3,
    s: f.fontScale,
  };
};

// ---------------------------------------------------------------------------
// The code panel — file cascades in once, then the accent band glides down
// it step by step (slight overshoot), in lockstep with the rail.
// ---------------------------------------------------------------------------

const CodePanel: React.FC<{ stage: Stage }> = ({ stage }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();
  const size = stage.codeFont;
  const lineH = size * stage.codeLineH;
  const padY = Math.round(size * 1.0);
  const padX = Math.round(size * 1.3);

  // Movement uses the overshoot spring; focus weighting uses the clean one.
  const move = STEP_TIMES.map((t) => glide(frame, fps, t));
  const progress = STEP_TIMES.map((t) => pop(frame, fps, t));
  let bandTop = STEP_BANDS[0].top * lineH;
  let bandH = STEP_BANDS[0].lines * lineH;
  STEP_BANDS.forEach((b, i) => {
    if (i === 0) {
      return;
    }
    bandTop = interpolate(move[i] ?? 0, [0, 1], [bandTop, b.top * lineH]);
    bandH = interpolate(move[i] ?? 0, [0, 1], [bandH, b.lines * lineH]);
  });

  // How "current" each step is (its spring minus the next step's).
  const weights = progress.map((p, i) =>
    Math.max(0, p - (progress[i + 1] ?? 0)),
  );
  const lineOpacity = (li: number): number => {
    const focus = STEP_BANDS.reduce((acc, b, i) => {
      const inBand = li >= b.top && li < b.top + b.lines;
      return acc + (inBand ? (weights[i] ?? 0) : 0);
    }, 0);
    const anyBand = progress[0] ?? 0;
    return interpolate(anyBand, [0, 1], [1, 0.5 + 0.5 * focus]);
  };

  return (
    <CardChrome title={FILE_NAME} width={stage.codeWidth} scale={f.fontScale}>
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
        {CODE_LINES.map((line, li) => {
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
// Rail rows — the run, as a trace. Every row flies in with an accent flash
// and a scanline sweep; each animates its own mechanism after landing.
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

/** Shared row shell: fly-in from the right, accent border flash, sweep. */
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

/** send rows — subject + delivery ticks landing one by one. */
const SendRow: React.FC<{
  at: number;
  height: number;
  s: number;
  subject: string;
  ticks: { delivered: number; opened: number; clicked?: number };
  accent?: boolean;
}> = ({ at, height, s, subject, ticks, accent }) => (
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
        <Tick label="delivered" at={ticks.delivered} s={s} />
        <Tick label="opened" at={ticks.opened} s={s} />
        {ticks.clicked === undefined ? null : (
          <Tick label="clicked" at={ticks.clicked} s={s} ripple />
        )}
      </span>
    </div>
  </RowShell>
);

/** enter row — the trigger event, then enrolment. */
const EnterRow: React.FC<{ at: number; height: number; s: number }> = ({
  at,
  height,
  s,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enrolled = pop(frame, fps, at + 14);
  return (
    <RowShell at={at} height={height} s={s}>
      <KindChip label="event" s={s} />
      <span
        style={{
          fontFamily: FONT_MONO,
          fontSize: 18 * s,
          color: theme.text,
          whiteSpace: "pre",
        }}
      >
        user.created
        <span style={{ color: theme.textHint }}> · doug@hogsend.com</span>
      </span>
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

/** sleep row — two days compressed into a filling bar with a shimmer. */
const SleepRow: React.FC<{ at: number; height: number; s: number }> = ({
  at,
  height,
  s,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = interpolate(frame, [at + 6, at + 48], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const day = Math.min(2, Math.floor(t * 2 + 0.0001));
  // The day counter pops each time it flips.
  const dayPop = pop(frame, fps, at + 6 + (day / 2) * 42);
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
          width: 130 * s,
          textAlign: "right",
        }}
      >
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
        of 2
      </span>
    </RowShell>
  );
};

/** check row — "do we have this event?": every candidate gets looked at. */
const CheckRow: React.FC<{ at: number; height: number; s: number }> = ({
  at,
  height,
  s,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const verdictAt = at + 68;
  const verdict = pop(frame, fps, verdictAt);
  return (
    <RowShell at={at} height={height} s={s} column>
      <div style={{ display: "flex", alignItems: "center", gap: 18 * s }}>
        <KindChip label="check" s={s} />
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: 18 * s,
            color: theme.text,
            whiteSpace: "pre",
          }}
        >
          feature_used
          <span style={{ color: theme.textHint }}> · within 2d?</span>
        </span>
        {/* Verdict lives on the header line so it can never clip. */}
        <span
          style={{
            position: "relative",
            marginLeft: "auto",
            opacity: verdict,
            transform: `scale(${interpolate(verdict, [0, 1], [1.35, 1])})`,
          }}
        >
          <Ripple at={verdictAt} size={34 * s} />
          <TagPill text="found: false" accent mono />
        </span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12 * s,
          paddingLeft: (86 + 18) * s,
        }}
      >
        {CHECKED_EVENTS.map((ev, i) => {
          const appearAt = at + 14 + i * 16;
          const strikeAt = at + 26 + i * 16;
          const appear = glide(frame, fps, appearAt);
          const struck = frame >= strikeAt;
          // Tiny decaying shake the moment a candidate is rejected.
          const sp = frame - strikeAt;
          const shake =
            sp >= 0 && sp < 8 ? Math.sin(sp * 2.4) * 2.6 * (1 - sp / 8) : 0;
          return (
            <span
              key={ev}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8 * s,
                opacity: pop(frame, fps, appearAt) * (struck ? 0.38 : 1),
                transform: `translateX(${
                  interpolate(appear, [0, 1], [26, 0]) + shake
                }px) scale(${struck ? 0.96 : 1})`,
                fontFamily: FONT_MONO,
                fontSize: 16 * s,
                color: theme.textBody,
                border: `1px solid ${theme.hairlineFaint}`,
                borderRadius: 6 * s,
                padding: `${6 * s}px ${12 * s}px`,
                whiteSpace: "pre",
              }}
            >
              {ev}
              {struck ? <span style={{ color: theme.textHint }}>✗</span> : null}
            </span>
          );
        })}
      </div>
    </RowShell>
  );
};

// ---------------------------------------------------------------------------
// The rail — rows stack as the run advances; on 1:1 old rows scroll away.
// ---------------------------------------------------------------------------

const Rail: React.FC<{ stage: Stage }> = ({ stage }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = stage.s;
  const gap = 16 * s;
  const heights: [number, number, number, number, number] = [
    64 * s,
    96 * s,
    64 * s,
    150 * s,
    96 * s,
  ];
  const offsets = heights.map((_, i) =>
    heights.slice(0, i).reduce((sum, h) => sum + h + gap, 0),
  );

  // When row k fires and k >= maxVisible, scroll up past rows
  // [0 .. k-maxVisible] so the latest row stays in view.
  let scroll = 0;
  STEP_TIMES.forEach((t, k) => {
    if (k < stage.maxVisible) {
      return;
    }
    const target = offsets[k - stage.maxVisible + 1] ?? 0;
    scroll = interpolate(pop(frame, fps, t), [0, 1], [scroll, target]);
  });

  const totalH =
    heights.reduce((sum, h) => sum + h, 0) + gap * (heights.length - 1);
  // Tallest window of maxVisible consecutive rows — the rail's fixed
  // viewport when it scrolls.
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
        <EnterRow at={T.enter} height={heights[0]} s={s} />
        <SendRow
          at={T.welcome}
          height={heights[1]}
          s={s}
          subject="Hey Doug, welcome to Hogsend!"
          ticks={{ delivered: T.welcome + 18, opened: T.welcome + 36 }}
        />
        <SleepRow at={T.sleep} height={heights[2]} s={s} />
        <CheckRow at={T.check} height={heights[3]} s={s} />
        <SendRow
          at={T.nudge}
          height={heights[4]}
          s={s}
          accent
          subject="You haven't tried the key feature yet"
          ticks={{
            delivered: T.nudge + 20,
            opened: T.nudge + 42,
            clicked: CLICKED_AT,
          }}
        />
      </div>
    </div>
  );
};

/** The use-case page's line under the journey code, landing late. */
const CodeCaption: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();
  const a = pop(frame, fps, T.nudge + 26);
  return (
    <div
      style={{
        paddingTop: 18 * f.fontScale,
        opacity: a,
        transform: `translateY(${interpolate(a, [0, 1], [10, 0])}px)`,
        fontFamily: FONT_BODY,
        fontWeight: 400,
        fontSize: 18 * f.fontScale,
        letterSpacing: "-0.02em",
        color: theme.textFaint,
      }}
    >
      Trigger, durable wait, branch — one file, one reviewable diff.
    </div>
  );
};

// ---------------------------------------------------------------------------
// Beat 1 — the run. One continuous stage, no hard cuts; a slow camera
// push-in follows the band down the file, and the aurora swells when the
// nudge gets clicked.
// ---------------------------------------------------------------------------

const RunBeat: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();
  const stage = useStage();

  // Camera: slow push-in across the run + a gentle descent that follows
  // each step (the stage starts slightly low and settles slightly high).
  const push = interpolate(frame, [0, RUN_FRAMES], [1, 1.05], {
    extrapolateRight: "clamp",
  });
  const descend = STEP_TIMES.reduce((y, t) => y + pop(frame, fps, t) * 9, 0);
  const glowIn = interpolate(frame, [CLICKED_AT, CLICKED_AT + 36], [0, 0.9], {
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
          <div style={{ paddingBottom: 18 * f.fontScale }}>
            <TabsRow delay={2} />
          </div>
          <CodePanel stage={stage} />
          {f.ratio === "11" ? null : <CodeCaption />}
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            width: stage.railWidth,
          }}
        >
          <div style={{ paddingBottom: 20 * f.fontScale }}>
            <Eyebrow text="The run" dot delay={T.enter - 4} />
          </div>
          <Rail stage={stage} />
        </div>
      </div>
    </SceneShell>
  );
};

// ---------------------------------------------------------------------------
// Beat 2 — the rest of the series (real steps from the same journey file),
// then the point.
// ---------------------------------------------------------------------------

const SERIES = [
  { n: "02", when: "day 3", check: "setup incomplete", send: "quickstart" },
  { n: "03", when: "day 5", check: "first value", send: "feature-highlight" },
  { n: "04", when: "day 7", check: "", send: "community" },
] as const;

const SeriesBeat: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();
  const s = f.fontScale * (f.isPortrait ? 1.12 : 1);
  const width = f.isPortrait
    ? f.width - 2 * f.pad
    : Math.min(f.width * 0.56, 1040);

  return (
    <SceneShell drift driftFrames={75}>
      <div
        style={{
          transform: `scale(${punchIn(frame, fps)})`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 44 * s,
          width,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 18 * s,
          }}
        >
          <Kicker text="Use case: activation" delay={0} />
          <KineticText
            text="The whole journey, one file."
            size="md"
            delay={4}
            stagger={3}
          />
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 14 * s,
            width: "100%",
          }}
        >
          {SERIES.map((step, i) => {
            const at = 14 + i * 9;
            const g = glide(frame, fps, at);
            const a = pop(frame, fps, at);
            return (
              <div
                key={step.n}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 22 * s,
                  padding: `${18 * s}px ${26 * s}px`,
                  border: `1px solid ${theme.hairlineFaint}`,
                  borderRadius: 10 * s,
                  backgroundColor: theme.cardFill,
                  opacity: a,
                  transform: `translateX(${interpolate(
                    g,
                    [0, 1],
                    [i % 2 === 0 ? -42 : 42, 0],
                  )}px)`,
                }}
              >
                <GhostNumber n={step.n} size={Math.round(52 * s)} />
                <span
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 17 * s,
                    color: theme.textFaint,
                    width: 92 * s,
                    whiteSpace: "pre",
                  }}
                >
                  {step.when}
                </span>
                <span
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 17 * s,
                    color: theme.textMuted,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    flex: 1,
                  }}
                >
                  {step.check ? `${step.check} → ` : ""}
                  <span style={{ color: theme.textBody }}>{step.send}</span>
                </span>
                <Tick label="" at={at + 12} s={s} />
              </div>
            );
          })}
        </div>
      </div>
    </SceneShell>
  );
};

// ---------------------------------------------------------------------------
// The video — 540 frames: the run (405) + the series (75) + end (60).
// ---------------------------------------------------------------------------

const WaitForEvent: React.FC<VideoProps> = () => (
  <Beats
    beats={[
      beat("run", RUN_FRAMES, () => <RunBeat />),
      beat("series", 75, () => <SeriesBeat />),
      beat("end", 60, () => (
        <SceneShell glow glowPosition="bottom" horizon drift>
          <EndCard line="Lifecycle email, in your repo." />
        </SceneShell>
      )),
    ]}
  />
);

export const video = defineVideo({
  id: "wait-for-event",
  durationInFrames: 540,
  fps: 30,
  component: WaitForEvent,
});
