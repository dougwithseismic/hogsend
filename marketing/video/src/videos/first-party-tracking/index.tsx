import type React from "react";
import type { ReactNode } from "react";
import {
  interpolate,
  interpolateColors,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { CardChrome } from "../../components/CardChrome";
import { EndCard } from "../../components/EndCard";
import { KineticText } from "../../components/KineticText";
import { SceneShell } from "../../components/SceneShell";
import { FONT_BODY, FONT_MONO } from "../../fonts";
import { Beats, beat, pop, punchIn, slideUp } from "../../lib/anim";
import { defineVideo, type VideoProps } from "../../lib/define-video";
import { useFormat } from "../../lib/format";
import { theme } from "../../lib/theme";

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/** Beat-change punch-in wrapper (scale 1.04→1.00). */
const Punch: React.FC<{ children: ReactNode }> = ({ children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div
      style={{
        transform: `scale(${punchIn(frame, fps)})`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        width: "100%",
      }}
    >
      {children}
    </div>
  );
};

/** Small secondary caption under the beat's main element. */
const Caption: React.FC<{ text: string; delay?: number }> = ({
  text,
  delay = 10,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();
  const a = slideUp(frame, fps, delay, 18);
  return (
    <div
      style={{
        opacity: a.opacity,
        transform: `translateY(${a.translateY}px)`,
        fontFamily: FONT_BODY,
        fontWeight: 400,
        fontSize: Math.round(26 * f.fontScale),
        color: theme.textMuted,
        textAlign: "center",
        marginTop: 34 * f.fontScale,
      }}
    >
      {text}
    </div>
  );
};

/** Grey skeleton body bar (email copy stand-in — no invented words). */
const Bar: React.FC<{ w: string; s: number; mb?: number }> = ({
  w,
  s,
  mb = 13,
}) => (
  <div
    style={{
      height: 12 * s,
      width: w,
      borderRadius: 999,
      backgroundColor: "rgba(255,255,255,0.08)",
      marginBottom: mb * s,
    }}
  />
);

// ---------------------------------------------------------------------------
// Beat 2 — link rewrite morph
// ---------------------------------------------------------------------------

const SRC_URL = "yoursite.com/pricing";
const DST_URL = "api.yoursite.com/v1/t/c/9f2a…";
const DOMAIN_LEN = "api.yoursite.com".length;
const MORPH_START = 18;
const MORPH_END = 46;

const LinkRewriteBeat: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();
  const s = f.fontScale;

  const entrance = slideUp(frame, fps, 0, 36);
  const progress = interpolate(frame, [MORPH_START, MORPH_END], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const resolved = Math.round(progress * DST_URL.length);
  const morphing = frame >= MORPH_START && resolved < DST_URL.length;

  const cut = Math.min(resolved, DOMAIN_LEN);
  const domainPart = DST_URL.slice(0, cut);
  const pathPart = DST_URL.slice(cut, resolved);
  const tail = resolved < SRC_URL.length ? SRC_URL.slice(resolved) : "";

  // Frame at which the rewritten domain finishes landing → accent flash.
  const domainLand =
    MORPH_START + (DOMAIN_LEN / DST_URL.length) * (MORPH_END - MORPH_START);
  const domainColor =
    frame < domainLand
      ? theme.text
      : interpolateColors(
          frame,
          [domainLand, domainLand + 14],
          [theme.accent, theme.text],
        );

  const chipFont = Math.round(30 * s);

  return (
    <div
      style={{
        width: f.isPortrait
          ? f.width - f.pad * 2
          : Math.min(f.width * 0.5, 950),
        opacity: entrance.opacity,
        transform: `translateY(${entrance.translateY}px)`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      <div
        style={{
          width: "100%",
          backgroundColor: theme.paperPure,
          border: `1px solid ${theme.hairlineFaint}`,
          borderRadius: 14 * s,
          padding: 34 * s,
          boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
        }}
      >
        <Bar w="88%" s={s} />
        <Bar w="64%" s={s} mb={24} />
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            fontFamily: FONT_MONO,
            fontSize: chipFont,
            backgroundColor: "rgba(255,255,255,0.04)",
            border: `1px solid ${theme.hairlineFaint}`,
            borderRadius: 10 * s,
            padding: `${13 * s}px ${20 * s}px`,
            whiteSpace: "pre",
            marginBottom: 26 * s,
          }}
        >
          <span style={{ color: domainColor }}>{domainPart}</span>
          <span style={{ color: theme.text }}>{pathPart}</span>
          <span
            style={{
              color: frame >= MORPH_START ? theme.textMuted : theme.text,
            }}
          >
            {tail}
          </span>
          {morphing ? (
            <span
              style={{
                display: "inline-block",
                width: chipFont * 0.55,
                height: chipFont * 1.05,
                backgroundColor: theme.text,
                marginLeft: 3,
              }}
            />
          ) : null}
        </div>
        <Bar w="74%" s={s} mb={0} />
      </div>
      <Caption text="Every link, rewritten on send." delay={12} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Beat 3 — the open pixel
// ---------------------------------------------------------------------------

const PING_TIMES = [14, 40] as const;

const PixelBeat: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();
  const s = f.fontScale;

  const entrance = slideUp(frame, fps, 0, 36);
  const chipIn = slideUp(frame, fps, 20, 14);
  const pixelOn = frame >= PING_TIMES[0];

  return (
    <div
      style={{
        width: f.isPortrait
          ? f.width - f.pad * 2
          : Math.min(f.width * 0.46, 880),
        opacity: entrance.opacity,
        transform: `translateY(${entrance.translateY}px)`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      <div
        style={{
          width: "100%",
          backgroundColor: theme.paperPure,
          border: `1px solid ${theme.hairlineFaint}`,
          borderRadius: 14 * s,
          padding: 34 * s,
          boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
        }}
      >
        <Bar w="82%" s={s} />
        <Bar w="56%" s={s} mb={26} />
        <div
          style={{
            borderTop: `1px solid ${theme.hairlineFaint}`,
            paddingTop: 24 * s,
            display: "flex",
            alignItems: "center",
            gap: 18 * s,
          }}
        >
          {/* The 1×1 pixel — tiny on purpose, with radar pings */}
          <div
            style={{
              position: "relative",
              width: 30 * s,
              height: 30 * s,
              flexShrink: 0,
            }}
          >
            {PING_TIMES.map((t0) => {
              const p = frame - t0;
              if (p < 0 || p > 32) {
                return null;
              }
              const size = interpolate(p, [0, 32], [10 * s, 92 * s]);
              const op = interpolate(p, [0, 32], [0.8, 0]);
              return (
                <div
                  key={t0}
                  style={{
                    position: "absolute",
                    left: "50%",
                    top: "50%",
                    width: size,
                    height: size,
                    borderRadius: "50%",
                    border: `${Math.max(1.5, 2 * s)}px solid ${theme.accent}`,
                    opacity: op,
                    transform: "translate(-50%, -50%)",
                  }}
                />
              );
            })}
            <div
              style={{
                position: "absolute",
                left: "50%",
                top: "50%",
                width: 7 * s,
                height: 7 * s,
                transform: "translate(-50%, -50%)",
                backgroundColor: pixelOn ? theme.accent : theme.textMuted,
                borderRadius: 2,
              }}
            />
          </div>
          <span
            style={{
              opacity: chipIn.opacity,
              transform: `translateY(${chipIn.translateY}px)`,
              fontFamily: FONT_MONO,
              fontSize: 27 * s,
              color: theme.text,
              backgroundColor: "rgba(255,255,255,0.04)",
              border: `1px solid ${theme.hairlineFaint}`,
              borderRadius: 9 * s,
              padding: `${10 * s}px ${18 * s}px`,
              whiteSpace: "pre",
            }}
          >
            /v1/t/o/7c1d…
          </span>
          <span
            style={{
              opacity: chipIn.opacity,
              fontFamily: FONT_MONO,
              fontSize: 17 * s,
              color: theme.textMuted,
              border: `1px solid ${theme.hairlineFaint}`,
              borderRadius: 999,
              padding: `${6 * s}px ${14 * s}px`,
              whiteSpace: "pre",
            }}
          >
            1×1 GIF
          </span>
        </div>
      </div>
      <Caption text="Opens, recorded first-party." delay={14} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Beat 4 — the sends row (Studio observes)
// ---------------------------------------------------------------------------

const Tick: React.FC<{ label: string; at: number }> = ({ label, at }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();
  const s = f.fontScale;
  const live = frame >= at;
  const p = pop(frame, fps, at);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8 * s,
        fontFamily: FONT_MONO,
        fontSize: 20 * s,
        color: theme.text,
        opacity: live ? 1 : 0.32,
        whiteSpace: "pre",
      }}
    >
      {label}
      <span
        style={{
          color: theme.accent,
          display: "inline-block",
          opacity: live ? 1 : 0,
          transform: `scale(${live ? interpolate(p, [0, 1], [1.7, 1]) : 0})`,
        }}
      >
        ✓
      </span>
    </span>
  );
};

const SendsCard: React.FC<{
  tickAt?: { delivered: number; opened: number; clicked: number };
}> = ({ tickAt = { delivered: -100, opened: -100, clicked: -100 } }) => {
  const f = useFormat();
  const s = f.fontScale;
  const cols = f.isPortrait ? "1fr 0.55fr 1.7fr" : "1.1fr 0.65fr 1.7fr";

  return (
    <CardChrome
      title="hogsend.com/studio"
      width={
        f.ratio === "169" ? Math.min(f.width * 0.62, 1180) : f.width - f.pad * 2
      }
      scale={s}
    >
      <div style={{ padding: `${24 * s}px ${34 * s}px ${28 * s}px` }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: cols,
            gap: 18 * s,
            fontFamily: FONT_BODY,
            fontWeight: 500,
            fontSize: 17 * s,
            letterSpacing: "0.05em",
            color: theme.textMuted,
            paddingBottom: 14 * s,
            borderBottom: `1px solid ${theme.hairlineFaint}`,
          }}
        >
          <span>Recipient</span>
          <span>Template</span>
          <span>Status</span>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: cols,
            gap: 18 * s,
            alignItems: "center",
            padding: `${20 * s}px 0`,
            borderBottom: `1px solid ${theme.hairlineFaint}`,
          }}
        >
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: 22 * s,
              color: theme.text,
            }}
          >
            amy@acme.com
          </span>
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: 22 * s,
              color: theme.textMuted,
            }}
          >
            welcome
          </span>
          <span
            style={{
              display: "inline-flex",
              gap: 20 * s,
              flexWrap: "wrap",
            }}
          >
            <Tick label="Delivered" at={tickAt.delivered} />
            <Tick label="Opened" at={tickAt.opened} />
            <Tick label="Clicked" at={tickAt.clicked} />
          </span>
        </div>
        {/* ghost rows — the rest of the table, no invented copy */}
        {[0.92, 0.78].map((w, i) => (
          <div
            key={w}
            style={{
              display: "grid",
              gridTemplateColumns: cols,
              gap: 18 * s,
              alignItems: "center",
              padding: `${18 * s}px 0`,
              borderBottom:
                i === 0 ? `1px solid ${theme.hairlineFaint}` : undefined,
              opacity: 0.5,
            }}
          >
            <Bar w={`${w * 78}%`} s={s} mb={0} />
            <Bar w="62%" s={s} mb={0} />
            <Bar w={`${w * 52}%`} s={s} mb={0} />
          </div>
        ))}
      </div>
    </CardChrome>
  );
};

const SendsBeat: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const entrance = slideUp(frame, fps, 0, 32);
  return (
    <div
      style={{
        width: "100%",
        display: "flex",
        justifyContent: "center",
        opacity: entrance.opacity,
        transform: `translateY(${entrance.translateY}px)`,
      }}
    >
      <SendsCard tickAt={{ delivered: 12, opened: 30, clicked: 48 }} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Beat 5 — whichever provider does the sending
// ---------------------------------------------------------------------------

const ProviderChip: React.FC<{
  label: string;
  x: number;
  y: number;
  driftX: number;
}> = ({ label, x, y, driftX }) => {
  const f = useFormat();
  const s = f.fontScale;
  return (
    <span
      style={{
        position: "absolute",
        left: `${x}%`,
        top: y,
        transform: `translate(-50%, -50%) translateX(${driftX}px)`,
        fontFamily: FONT_MONO,
        fontSize: 22 * s,
        color: theme.text,
        border: "1px solid rgba(255,255,255,0.35)",
        borderRadius: 999,
        padding: `${10 * s}px ${24 * s}px`,
        opacity: 0.15,
        whiteSpace: "pre",
      }}
    >
      {label}
    </span>
  );
};

const ProviderBeat: React.FC = () => {
  const frame = useCurrentFrame();
  const f = useFormat();
  const s = f.fontScale;
  const tableW =
    f.ratio === "169" ? Math.min(f.width * 0.62, 1180) : f.width - f.pad * 2;
  const drift1 = interpolate(frame, [0, 60], [-44, 32]);
  const drift2 = interpolate(frame, [0, 60], [38, -34]);

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      {/* the sends table, dimmed behind the line */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: tableW,
          transform: "translate(-50%, -50%) scale(0.94)",
          opacity: 0.07,
        }}
      >
        <SendsCard />
      </div>
      <ProviderChip label="Resend" x={24} y={-200 * s} driftX={drift1} />
      <ProviderChip label="Postmark" x={74} y={230 * s} driftX={drift2} />
      <KineticText
        text="Whichever provider does the sending."
        size="lg"
        delay={3}
      />
    </div>
  );
};

// ---------------------------------------------------------------------------
// The video
// ---------------------------------------------------------------------------

const FirstPartyTracking: React.FC<VideoProps> = () => {
  return (
    <Beats
      beats={[
        beat("hook", 60, () => (
          <SceneShell glow drift>
            <KineticText
              text="Opens and clicks are *yours.*"
              size="xl"
              delay={4}
            />
          </SceneShell>
        )),
        beat("rewrite", 60, () => (
          <SceneShell drift driftFrames={60}>
            <Punch>
              <LinkRewriteBeat />
            </Punch>
          </SceneShell>
        )),
        beat("pixel", 60, () => (
          <SceneShell drift driftFrames={60}>
            <Punch>
              <PixelBeat />
            </Punch>
          </SceneShell>
        )),
        beat("sends", 60, () => (
          <SceneShell drift driftFrames={60}>
            <Punch>
              <SendsBeat />
            </Punch>
          </SceneShell>
        )),
        beat("provider", 60, () => (
          <SceneShell glow drift driftFrames={60}>
            <Punch>
              <ProviderBeat />
            </Punch>
          </SceneShell>
        )),
        beat("end", 60, () => (
          <SceneShell glow>
            <EndCard line="Lifecycle email, shipped like a feature." />
          </SceneShell>
        )),
      ]}
    />
  );
};

export const video = defineVideo({
  id: "first-party-tracking",
  durationInFrames: 360,
  fps: 30,
  component: FirstPartyTracking,
});
