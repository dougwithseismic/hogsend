import type React from "react";
import type { CSSProperties } from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { CardChrome } from "../../components/CardChrome";
import { EndCard } from "../../components/EndCard";
import { KineticText } from "../../components/KineticText";
import { SceneShell } from "../../components/SceneShell";
import { FONT_BODY, FONT_MONO } from "../../fonts";
import { Beats, beat, pop, punchIn, slideUp } from "../../lib/anim";
import { tokenize } from "../../lib/code-tokenizer";
import { defineVideo, type VideoProps } from "../../lib/define-video";
import { useFormat } from "../../lib/format";
import { syntax, theme } from "../../lib/theme";
import { charsVisible } from "../../lib/typewriter";

// ---------------------------------------------------------------------------
// byo-provider — "The provider is just a wire." 12s / 360 frames / 6 beats.
// The engine owns render → preferences → tracking → history; the provider
// chip plugs in at the end and can be swapped without anything else moving.
// ---------------------------------------------------------------------------

const ENGINE_STAGES = ["render", "preferences", "tracking", "history"];

/** Pulse arrival frame for each of the five pipeline nodes. */
const ARRIVALS = [6, 14, 22, 30, 42];

const ENV_TEXT = "EMAIL_PROVIDER=postmark";
const ENV_HEAD = "EMAIL_PROVIDER=";

const BP1 = `defineEmailProvider({
  meta: { id: "postmark", name: "Postmark" },
  send,          // HTML in, { id } out
  sendBatch,
  verifyWebhook, // delivered, bounced, complained
  parseWebhook,
});`;

/** Muted secondary line under the main element of a beat. */
const Caption: React.FC<{ text: string; delay?: number }> = ({
  text,
  delay = 0,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();
  const sl = slideUp(frame, fps, delay, 18);
  return (
    <div
      style={{
        opacity: sl.opacity,
        transform: `translateY(${sl.translateY}px)`,
        fontFamily: FONT_BODY,
        fontWeight: 400,
        fontSize: Math.round(30 * f.fontScale),
        color: theme.textMuted,
        textAlign: "center",
      }}
    >
      {text}
    </div>
  );
};

/** `EMAIL_PROVIDER=postmark` typed in, value in accent. */
const EnvLine: React.FC<{ startDelay: number }> = ({ startDelay }) => {
  const frame = useCurrentFrame();
  const f = useFormat();
  const u = f.fontScale;
  const n = charsVisible(ENV_TEXT, frame, 1.5, startDelay);
  const shownHead = ENV_TEXT.slice(0, Math.min(n, ENV_HEAD.length));
  const shownValue =
    n > ENV_HEAD.length ? ENV_TEXT.slice(ENV_HEAD.length, n) : "";
  const typing = frame >= startDelay && n < ENV_TEXT.length;
  const size = Math.round(26 * u);
  return (
    <div
      style={{
        fontFamily: FONT_MONO,
        fontWeight: 400,
        fontSize: size,
        letterSpacing: "0.01em",
        color: theme.textMuted,
        minHeight: Math.round(size * 1.3),
      }}
    >
      <span>{shownHead}</span>
      <span style={{ color: theme.accent }}>{shownValue}</span>
      {typing ? (
        <span
          style={{
            display: "inline-block",
            width: size * 0.55,
            height: size * 1.05,
            verticalAlign: "text-bottom",
            backgroundColor: theme.text,
            marginLeft: 2,
          }}
        />
      ) : null}
    </div>
  );
};

/**
 * The five-node pipeline: four engine stages inside one hairline housing
 * (legend: "engine"), a connector, and the provider chip plugged in at
 * the end. phase="draw" animates it in with a travelling accent pulse;
 * phase="swap" renders it settled and swaps Resend → Postmark.
 */
const ProviderPipeline: React.FC<{ phase: "draw" | "swap" }> = ({ phase }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();
  const vertical = f.ratio !== "169";
  // The pipeline is the hero of these beats — let it breathe.
  const u = f.fontScale * (vertical ? 1.12 : 1.22);
  const settled = phase === "swap";

  const chipW = (vertical ? 300 : 206) * u;
  const chipH = (vertical ? 72 : 66) * u;
  const link = 24 * u;
  const hPad = 24 * u;
  const connector = 56 * u;
  const provW = (vertical ? 300 : 224) * u;
  const provH = 84 * u;

  const chipLen = vertical ? chipH : chipW;
  const provLen = vertical ? provH : provW;
  const housingLen = hPad * 2 + 4 * chipLen + 3 * link;
  const centers = ENGINE_STAGES.map(
    (_, i) => hPad + i * (chipLen + link) + chipLen / 2,
  );
  const provCenter = housingLen + connector + provLen / 2;

  const pulsePos = interpolate(frame, ARRIVALS, [...centers, provCenter], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const lastArrival = ARRIVALS[ARRIVALS.length - 1] as number;
  const pulseVisible =
    !settled && frame >= (ARRIVALS[0] as number) && frame < lastArrival;
  const housingIn = settled ? 1 : pop(frame, fps);

  const providerFace: CSSProperties = {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.paperPure,
    border: `1px solid ${theme.hairline}`,
    borderRadius: 18 * u,
    boxShadow: "0 18px 50px rgba(0,0,0,0.45)",
    fontFamily: FONT_BODY,
    fontWeight: 500,
    fontSize: 27 * u,
    color: theme.text,
  };

  // Swap choreography (local frames of the swap beat)
  const out = pop(frame, fps, 12); // Resend unplugs
  const inn = pop(frame, fps, 26); // Postmark clicks in
  const axis = vertical ? "translateY" : "translateX";
  const innShift = interpolate(inn, [0, 0.85, 1], [64 * u, -4 * u, 0]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: vertical ? "column" : "row",
        alignItems: "center",
        position: "relative",
      }}
    >
      {/* Engine housing — the four stages the engine owns */}
      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: vertical ? "column" : "row",
          alignItems: "center",
          padding: hPad,
          backgroundColor: theme.paperPure,
          border: `1px solid ${theme.hairlineFaint}`,
          borderRadius: 22 * u,
          opacity: housingIn,
        }}
      >
        <span
          style={{
            position: "absolute",
            top: -11 * u,
            left: 22 * u,
            fontFamily: FONT_MONO,
            fontSize: 15 * u,
            letterSpacing: "0.14em",
            color: theme.textMuted,
            backgroundColor: theme.ink,
            padding: `0 ${10 * u}px`,
            lineHeight: `${22 * u}px`,
          }}
        >
          engine
        </span>
        {ENGINE_STAGES.map((label, i) => {
          const arrival = ARRIVALS[i] as number;
          const arrived = settled || frame >= arrival;
          const p = settled ? 1 : pop(frame, fps, arrival);
          const scale = arrived ? interpolate(p, [0, 1], [1.1, 1]) : 1;
          return (
            <div
              key={label}
              style={{
                display: "flex",
                flexDirection: vertical ? "column" : "row",
                alignItems: "center",
              }}
            >
              {i > 0 ? (
                <div
                  style={{
                    width: vertical ? 1 : link,
                    height: vertical ? link : 1,
                    backgroundColor: theme.hairlineFaint,
                  }}
                />
              ) : null}
              <div
                style={{
                  width: chipW,
                  height: chipH,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: "rgba(255,255,255,0.04)",
                  border: `1px solid ${
                    arrived ? theme.hairline : theme.hairlineFaint
                  }`,
                  borderRadius: 14 * u,
                  transform: `scale(${scale})`,
                  opacity: arrived ? 0.55 + 0.45 * p : 0.55,
                  fontFamily: FONT_BODY,
                  fontWeight: 500,
                  fontSize: 22 * u,
                  color: theme.text,
                }}
              >
                {label}
              </div>
            </div>
          );
        })}
      </div>

      {/* Connector — the socket the provider plugs into */}
      <div
        style={{
          display: "flex",
          flexDirection: vertical ? "column" : "row",
          alignItems: "center",
          width: vertical ? 1 : connector,
          height: vertical ? connector : 1,
          opacity: housingIn,
        }}
      >
        <div
          style={{
            width: 9 * u,
            height: 9 * u,
            flexShrink: 0,
            borderRadius: "50%",
            border: `1px solid ${theme.hairline}`,
            backgroundColor: theme.ink,
          }}
        />
        <div
          style={{
            flexGrow: 1,
            width: vertical ? 1 : undefined,
            height: vertical ? undefined : 1,
            backgroundColor: theme.hairlineFaint,
          }}
        />
      </div>

      {/* Provider chip — the swappable wire */}
      <div style={{ position: "relative", width: provW, height: provH }}>
        {phase === "draw" ? (
          (() => {
            const arrival = ARRIVALS[4] as number;
            const arrived = frame >= arrival;
            const p = pop(frame, fps, arrival);
            return (
              <div
                style={{
                  ...providerFace,
                  border: `1px solid ${
                    arrived ? theme.hairline : theme.hairlineFaint
                  }`,
                  opacity: arrived ? 0.55 + 0.45 * p : 0.55,
                  transform: `scale(${
                    arrived ? interpolate(p, [0, 1], [1.1, 1]) : 1
                  })`,
                }}
              >
                Resend
              </div>
            );
          })()
        ) : (
          <>
            <div
              style={{
                ...providerFace,
                opacity: 1 - out,
                transform: `${axis}(${out * 56 * u}px)`,
              }}
            >
              Resend
            </div>
            <div
              style={{
                ...providerFace,
                opacity: interpolate(inn, [0, 0.6], [0, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                }),
                transform: `${axis}(${innShift}px)`,
              }}
            >
              Postmark
            </div>
          </>
        )}
      </div>

      {/* Accent pulse travelling the pipeline (draw phase only) */}
      {pulseVisible ? (
        <div
          style={{
            position: "absolute",
            left: vertical ? "50%" : pulsePos,
            top: vertical ? pulsePos : "50%",
            transform: "translate(-50%, -50%)",
            width: 13 * u,
            height: 13 * u,
            borderRadius: "50%",
            backgroundColor: theme.accent,
            boxShadow: `0 0 ${20 * u}px ${theme.accent}`,
          }}
        />
      ) : null}
    </div>
  );
};

/**
 * Beats 2 + 3 share this wrapper so the pipeline holds perfectly still
 * across the hard cut — only the slot beneath it changes.
 */
const PipelineBeat: React.FC<{ phase: "draw" | "swap" }> = ({ phase }) => {
  const f = useFormat();
  const u = f.fontScale;
  return (
    <SceneShell>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        }}
      >
        <ProviderPipeline phase={phase} />
        <div
          style={{
            height: 136 * u,
            marginTop: 52 * u,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "flex-start",
            gap: 16 * u,
          }}
        >
          {phase === "draw" ? (
            <Caption text="The engine owns the pipeline." delay={40} />
          ) : (
            <>
              <EnvLine startDelay={24} />
              <Caption text="Swap the wire. Nothing else moves." delay={42} />
            </>
          )}
        </div>
      </div>
    </SceneShell>
  );
};

/** Code card revealing BP-1 top to bottom with a brief line highlight. */
const RevealCode: React.FC<{
  code: string;
  filename?: string;
  highlightLine?: number;
}> = ({ code, filename, highlightLine }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();
  const lines = tokenize(code);
  const size = Math.round(28 * f.fontScale * (f.isPortrait ? 1.15 : 1));
  const padX = Math.round(size * 1.3);
  const width = f.isPortrait
    ? "100%"
    : f.ratio === "11"
      ? Math.round(f.width * 0.8)
      : Math.min(f.width * 0.62, 1080);
  const hl = interpolate(frame, [36, 42, 52, 59], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <CardChrome title={filename} width={width} scale={f.fontScale}>
      <div
        style={{
          padding: `${Math.round(size * 1.1)}px ${padX}px`,
          fontFamily: FONT_MONO,
          fontSize: size,
          fontWeight: 400,
          lineHeight: 1.7,
          whiteSpace: "pre",
          color: syntax.base,
        }}
      >
        {lines.map((line, li) => {
          const sl = slideUp(frame, fps, 6 + li * 4, 14);
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: static code
              key={`l-${li}`}
              style={{
                position: "relative",
                minHeight: size * 1.7,
                opacity: sl.opacity,
                transform: `translateY(${sl.translateY}px)`,
              }}
            >
              {li === highlightLine ? (
                <div
                  style={{
                    position: "absolute",
                    top: 0,
                    bottom: 0,
                    left: -padX * 0.5,
                    right: -padX * 0.5,
                    backgroundColor: theme.accentTint,
                    borderLeft: `3px solid ${theme.accent}`,
                    borderRadius: 4,
                    opacity: hl,
                  }}
                />
              ) : null}
              {line.map((token, ti) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: static code
                  key={`t-${li}-${ti}`}
                  style={{
                    position: "relative",
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
    </CardChrome>
  );
};

const ContractBeat: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();
  const u = f.fontScale;
  return (
    <SceneShell drift driftFrames={60}>
      <div
        style={{
          transform: `scale(${punchIn(frame, fps)})`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 40 * u,
          width: "100%",
        }}
      >
        <RevealCode code={BP1} filename="provider.ts" highlightLine={4} />
        <Caption text="One contract. Any provider." delay={38} />
      </div>
    </SceneShell>
  );
};

const TagBeat: React.FC = () => {
  const f = useFormat();
  return (
    <SceneShell glow drift driftFrames={60}>
      <KineticText
        text="Render, preferences, tracking, history"
        size="lg"
        stagger={5}
        maxWidth="100%"
      />
      <div style={{ height: 22 * f.fontScale }} />
      <KineticText text="— the *engine's.*" size="lg" delay={32} />
    </SceneShell>
  );
};

const ByoProvider: React.FC<VideoProps> = () => (
  <Beats
    beats={[
      beat("hook", 60, () => (
        <SceneShell glow drift driftFrames={60}>
          <KineticText text="The provider is just a *wire.*" size="xl" />
        </SceneShell>
      )),
      beat("pipeline", 60, () => <PipelineBeat phase="draw" />),
      beat("swap", 60, () => <PipelineBeat phase="swap" />),
      beat("contract", 60, () => <ContractBeat />),
      beat("tag", 60, () => <TagBeat />),
      beat("end", 60, () => (
        <SceneShell glow drift driftFrames={60}>
          <EndCard line="Lifecycle email, shipped like a feature." />
        </SceneShell>
      )),
    ]}
  />
);

export const video = defineVideo({
  id: "byo-provider",
  durationInFrames: 360,
  fps: 30,
  component: ByoProvider,
});
