"use client";

import type { CSSProperties } from "react";
import { interpolate, pop } from "./clip-anim";
import { theme, typo } from "./clip-theme";
import { useLoopFrame } from "./use-loop-frame";

// ---------------------------------------------------------------------------
// Native port of the Remotion "first-party-tracking" video
// (marketing/video/src/videos/first-party-tracking/index.tsx). The Remotion
// comp is a 6-beat sequence; the story we keep on the web is the load-bearing
// middle: links in an outgoing email get rewritten on send
// ("yoursite.com/pricing" → a tracked redirect URL — "Every link, rewritten
// on send"), then opens + clicks fan back out to PostHog as first-party
// events. Drives off ONE looping web frame clock (use-loop-frame) instead of
// Remotion's useCurrentFrame()/useVideoConfig() + Beats, collapses the
// 3-ratio useFormat system into one responsive layout, and turns the
// AbsoluteFill/SceneShell primitives into inline styles + theme tokens. It
// loops cleanly.
// ---------------------------------------------------------------------------

const FPS = 30;

// The shared `interpolate` only types/handles 2-element ranges, but a clean
// fade-in / hold / fade-out crossfade needs a 4-point ramp. This delegates to
// the 2-point `interpolate` per matched segment — the same pattern the
// journey-trace clip uses (`rampN`). Always clamped at both ends.
function ramp4(
  input: number,
  inputRange: readonly [number, number, number, number],
  outputRange: readonly [number, number, number, number],
): number {
  if (input <= inputRange[0]) {
    return outputRange[0];
  }
  if (input >= inputRange[3]) {
    return outputRange[3];
  }
  for (let i = 0; i < 3; i++) {
    const lo = inputRange[i];
    const hi = inputRange[i + 1];
    if (input >= lo && input <= hi) {
      return interpolate(input, [lo, hi], [outputRange[i], outputRange[i + 1]]);
    }
  }
  return outputRange[3];
}

// ---------------------------------------------------------------------------
// Beat timeline (frames). Three story beats run in sequence inside the same
// card so there is no hard cut — the email body is constant, only the focus
// row swaps. A trailing hold lets the last fan-out breathe before the loop.
// ---------------------------------------------------------------------------

const REWRITE = { at: 0, len: 110 };
const PIXEL = { at: 110, len: 90 };
const FANOUT = { at: 200, len: 130 };
const TOTAL = FANOUT.at + FANOUT.len; // 330

// ---------------------------------------------------------------------------
// The link-rewrite morph — ported from LinkRewriteBeat: a mono href types
// itself from the source URL into the tracked redirect URL, the rewritten
// domain landing in the accent before settling to white.
// ---------------------------------------------------------------------------

const SRC_URL = "yoursite.com/pricing";
const DST_URL = "api.yoursite.com/v1/t/c/9f2a…";
const DOMAIN_LEN = "api.yoursite.com".length;

function morphedHref(local: number): {
  domain: string;
  path: string;
  tail: string;
  caretOn: boolean;
  domainLanded: boolean;
} {
  const start = 18;
  const end = 64;
  const progress = interpolate(local, [start, end], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const resolved = Math.round(progress * DST_URL.length);
  const cut = Math.min(resolved, DOMAIN_LEN);
  const tail = resolved < SRC_URL.length ? SRC_URL.slice(resolved) : "";
  const domainLand = start + (DOMAIN_LEN / DST_URL.length) * (end - start);
  return {
    domain: DST_URL.slice(0, cut),
    path: DST_URL.slice(cut, resolved),
    tail,
    caretOn: local >= start && resolved < DST_URL.length,
    domainLanded: local >= domainLand,
  };
}

// ---------------------------------------------------------------------------
// Radar ping — the open-pixel / fan-out accent (ported from PixelBeat's
// concentric ping rings and trace.tsx's Ripple).
// ---------------------------------------------------------------------------

function Pings({ local, times }: { local: number; times: number[] }) {
  return (
    <>
      {times.map((t0) => {
        const p = local - t0;
        if (p < 0 || p > 32) {
          return null;
        }
        const size = interpolate(p, [0, 32], [10, 92]);
        const op = interpolate(p, [0, 32], [0.75, 0]);
        return (
          <span
            key={t0}
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: size,
              height: size,
              borderRadius: "50%",
              border: `2px solid ${theme.accent}`,
              opacity: op,
              transform: "translate(-50%, -50%)",
              pointerEvents: "none",
            }}
          />
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// The email card — constant across beats (the "outgoing email"). Subject +
// grey skeleton body bars, one href row whose contents the active beat owns.
// ---------------------------------------------------------------------------

function Bar({ w, mb = 11 }: { w: string; mb?: number }) {
  return (
    <div
      style={{
        height: 9,
        width: w,
        borderRadius: 999,
        backgroundColor: "rgba(255,255,255,0.08)",
        marginBottom: mb,
      }}
    />
  );
}

const CHIP_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  fontSize: "clamp(12px, 1.5vw, 16px)",
  backgroundColor: theme.slotFill,
  border: `1px solid ${theme.hairlineFaint}`,
  borderRadius: 9,
  padding: "10px 16px",
  whiteSpace: "pre",
};

function HrefRow({ local, beat }: { local: number; beat: "rewrite" | "rest" }) {
  if (beat === "rest") {
    // After the rewrite beat the href is settled to its tracked form.
    return (
      <div className="font-mono" style={CHIP_STYLE}>
        <span style={{ color: theme.text }}>{DST_URL}</span>
      </div>
    );
  }
  const m = morphedHref(local);
  return (
    <div className="font-mono" style={CHIP_STYLE}>
      <span style={{ color: m.domainLanded ? theme.text : theme.accent }}>
        {m.domain}
      </span>
      <span style={{ color: theme.text }}>{m.path}</span>
      <span style={{ color: local >= 18 ? theme.textMuted : theme.text }}>
        {m.tail}
      </span>
      {m.caretOn ? (
        <span
          style={{
            display: "inline-block",
            width: 8,
            height: 17,
            backgroundColor: theme.text,
            marginLeft: 3,
          }}
        />
      ) : null}
    </div>
  );
}

function EmailCard({
  local,
  beat,
}: {
  local: number;
  beat: "rewrite" | "rest";
}) {
  return (
    <div
      style={{
        width: "min(100%, 480px)",
        backgroundColor: theme.paperPure,
        border: `1px solid ${theme.hairlineFaint}`,
        borderRadius: 14,
        padding: "22px 24px",
        boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
      }}
    >
      <div
        className="font-sans"
        style={{
          fontSize: 12,
          color: theme.textMuted,
          marginBottom: 14,
          letterSpacing: typo.tracking,
        }}
      >
        {"From  Acme <hello@acme.com>"}
      </div>
      <Bar w="86%" />
      <Bar w="62%" mb={20} />
      <HrefRow local={local} beat={beat} />
      <div style={{ height: 18 }} />
      <Bar w="72%" mb={0} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The open-pixel detail — the 1×1 GIF dot with its tracked open URL chip and
// radar pings (ported from PixelBeat).
// ---------------------------------------------------------------------------

const PIXEL_PINGS = [16, 44];

function PixelDetail({ local }: { local: number }) {
  const pixelOn = local >= PIXEL_PINGS[0];
  const chip = pop(local, FPS, 18);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        flexWrap: "wrap",
        justifyContent: "center",
      }}
    >
      <div style={{ position: "relative", width: 28, height: 28 }}>
        <Pings local={local} times={PIXEL_PINGS} />
        <span
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: 7,
            height: 7,
            transform: "translate(-50%, -50%)",
            backgroundColor: pixelOn ? theme.accent : theme.textMuted,
            borderRadius: 2,
          }}
        />
      </div>
      <span
        className="font-mono"
        style={{
          ...CHIP_STYLE,
          opacity: chip,
          transform: `translateY(${interpolate(chip, [0, 1], [10, 0])}px)`,
        }}
      >
        <span style={{ color: theme.text }}>/v1/t/o/7c1d…</span>
      </span>
      <span
        className="font-mono"
        style={{
          fontSize: "clamp(11px, 1.3vw, 14px)",
          color: theme.textMuted,
          border: `1px solid ${theme.hairlineFaint}`,
          borderRadius: 999,
          padding: "6px 14px",
          opacity: chip,
          whiteSpace: "pre",
        }}
      >
        1×1 GIF
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The fan-out — opens/clicks fly across a lane into the PostHog destination
// chip as first-party events (ported from trace.tsx's FanoutRow + the comp's
// "first-party" payoff). The chip uses the /logos/posthog.svg CSS mask, like
// the trace clip.
// ---------------------------------------------------------------------------

const FANOUT_EVENTS = ["email.opened", "email.link_clicked"];
const FLIGHT = 30;

function PostHogChip({ bump }: { bump: number }) {
  const maskStyle: CSSProperties = {
    width: 20,
    height: 20,
    backgroundColor: theme.text,
    maskImage: "url(/logos/posthog.svg)",
    maskSize: "contain",
    maskRepeat: "no-repeat",
    maskPosition: "center",
    WebkitMaskImage: "url(/logos/posthog.svg)",
    WebkitMaskSize: "contain",
    WebkitMaskRepeat: "no-repeat",
    WebkitMaskPosition: "center",
  };
  return (
    <span
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 18px",
        borderRadius: 9,
        border: `1px solid ${theme.hairline}`,
        backgroundColor: theme.slotFill,
        transform: `scale(${1 + 0.1 * bump})`,
        flexShrink: 0,
      }}
    >
      <span style={maskStyle} />
      <span
        className="font-sans"
        style={{
          fontWeight: 500,
          fontSize: "clamp(14px, 1.7vw, 18px)",
          letterSpacing: typo.tracking,
          color: theme.text,
          whiteSpace: "pre",
        }}
      >
        PostHog
      </span>
    </span>
  );
}

function Fanout({ local }: { local: number }) {
  const launches = FANOUT_EVENTS.map((_, i) => 16 + i * 30);
  const arrivals = launches.map((l) => l + FLIGHT);
  const bump = arrivals.reduce((acc, a) => {
    const p = local - a;
    return Math.max(acc, p >= 0 && p < 12 ? 1 - p / 12 : 0);
  }, 0);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        width: "min(100%, 560px)",
      }}
    >
      <span
        className="font-mono"
        style={{
          flexShrink: 0,
          fontSize: "clamp(11px, 1.4vw, 15px)",
          color: theme.textMuted,
          border: `1px solid ${theme.hairlineFaint}`,
          backgroundColor: theme.tagFill,
          borderRadius: 5,
          padding: "7px 12px",
          whiteSpace: "pre",
        }}
      >
        first-party
      </span>
      {/* Flight lane */}
      <div style={{ position: "relative", flex: 1, height: 56, minWidth: 0 }}>
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
        {FANOUT_EVENTS.map((ev, i) => {
          const launch = launches[i];
          const t = interpolate(local, [launch, launch + FLIGHT], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          if (local < launch || local > launch + FLIGHT + 4) {
            return null;
          }
          const fade = ramp4(t, [0, 0.1, 0.85, 1], [0, 1, 1, 0]);
          return (
            <span
              key={ev}
              className="font-mono"
              style={{
                position: "absolute",
                left: `${t * 100}%`,
                top: "50%",
                transform: `translate(${-t * 100}%, -50%)`,
                opacity: fade,
                fontSize: "clamp(11px, 1.4vw, 15px)",
                color: theme.text,
                border: `1px solid ${theme.hairline}`,
                borderRadius: 6,
                padding: "6px 12px",
                backgroundColor: theme.paperPure,
                whiteSpace: "pre",
              }}
            >
              {ev}
            </span>
          );
        })}
      </div>
      <div style={{ position: "relative" }}>
        <Pings local={local} times={arrivals} />
        <PostHogChip bump={bump} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Eyebrow + caption — the docs label language (mono dot eyebrow, the comp's
// per-beat captions verbatim: "Every link, rewritten on send." etc).
// ---------------------------------------------------------------------------

function Eyebrow({ frame }: { frame: number }) {
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
      First-party tracking
    </div>
  );
}

function Caption({ local, text }: { local: number; text: string }) {
  const a = pop(local, FPS, 10);
  return (
    <div
      className="font-sans"
      style={{
        fontWeight: 400,
        fontSize: "clamp(15px, 2vw, 20px)",
        letterSpacing: typo.tracking,
        color: theme.textMuted,
        textAlign: "center",
        opacity: a,
        transform: `translateY(${interpolate(a, [0, 1], [12, 0])}px)`,
      }}
    >
      {text}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Beat crossfade helper — fade/lift in over the first ~14 frames, hold, ease
// out near the end so the next beat is a clean entrance (mirrors the comp's
// punchIn between beats, here as a single looping stage).
// ---------------------------------------------------------------------------

function beatAlpha(
  local: number,
  len: number,
): { opacity: number; lift: number } {
  const opacity = ramp4(local, [0, 14, len - 12, len], [0, 1, 1, 0]);
  const lift = interpolate(local, [0, 16], [14, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return { opacity, lift };
}

// ---------------------------------------------------------------------------
// The clip.
// ---------------------------------------------------------------------------

const ROOT_STYLE: CSSProperties = {
  position: "relative",
  width: "100%",
  height: "clamp(440px, 50vw, 500px)",
  overflow: "hidden",
  borderRadius: 12,
  border: `1px solid ${theme.cardBorder}`,
  backgroundColor: theme.ink,
};

export function FirstPartyTracking() {
  const { ref, frame } = useLoopFrame(TOTAL, FPS);

  const active: "rewrite" | "pixel" | "fanout" =
    frame < PIXEL.at ? "rewrite" : frame < FANOUT.at ? "pixel" : "fanout";
  const local =
    active === "rewrite"
      ? frame - REWRITE.at
      : active === "pixel"
        ? frame - PIXEL.at
        : frame - FANOUT.at;
  const len =
    active === "rewrite"
      ? REWRITE.len
      : active === "pixel"
        ? PIXEL.len
        : FANOUT.len;
  const { opacity, lift } = beatAlpha(local, len);

  const caption =
    active === "rewrite"
      ? "Every link, rewritten on send."
      : active === "pixel"
        ? "Opens, recorded first-party."
        : "Opens and clicks fan out as your events.";

  return (
    <div ref={ref} style={ROOT_STYLE}>
      {/* Bottom red bloom — the atmospheric wash the code windows use. */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          background:
            "radial-gradient(60% 55% at 50% 82%, rgba(246,72,56,0.14), transparent 70%)",
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
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "clamp(20px, 3.5vh, 32px)",
          padding: "clamp(24px, 5%, 52px)",
        }}
      >
        <Eyebrow frame={frame} />

        {/* The outgoing email — constant; the rewrite beat owns its href. */}
        <EmailCard
          local={local}
          beat={active === "rewrite" ? "rewrite" : "rest"}
        />

        {/* The per-beat focus row, crossfading in below the email. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 16,
            width: "100%",
            minHeight: 72,
            opacity,
            transform: `translateY(${lift}px)`,
          }}
        >
          {active === "pixel" ? <PixelDetail local={local} /> : null}
          {active === "fanout" ? <Fanout local={local} /> : null}
          <Caption local={local} text={caption} />
        </div>
      </div>
    </div>
  );
}
