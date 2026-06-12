import type React from "react";
import type { ReactNode } from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { CardChrome } from "../../components/CardChrome";
import { EndCard } from "../../components/EndCard";
import { KineticText } from "../../components/KineticText";
import { SceneShell } from "../../components/SceneShell";
import { FONT_BODY, FONT_MONO } from "../../fonts";
import { Beats, beat, microDrift, pop, slideUp } from "../../lib/anim";
import { type TokenKind, tokenize } from "../../lib/code-tokenizer";
import { defineVideo, type VideoProps } from "../../lib/define-video";
import { useFormat } from "../../lib/format";
import { syntax, theme } from "../../lib/theme";
import { charsVisible, typingDuration } from "../../lib/typewriter";

// ---------------------------------------------------------------------------
// Script content (exact copy from the beat sheet — do not paraphrase)
// ---------------------------------------------------------------------------

const CMD_1 = "pnpm dlx create-hogsend@latest my-app";
const CMD_2 = "cd my-app";
const CMD_3 = "hogsend dev";

const SCAFFOLD_FILES = [
  "src/journeys/welcome.ts",
  "src/journeys/trial-expiring.ts",
  "src/journeys/feedback-checkin.ts",
  "src/emails/welcome.tsx",
  "src/emails/registry.ts",
  "src/webhook-sources/",
];

// SNIPPET SC-2 — trimmed from create-hogsend template (14 lines)
const WELCOME_CODE = `export const welcome = defineJourney({
  meta: {
    id: "welcome",
    trigger: { event: Events.USER_CREATED },
    entryLimit: "once",
  },
  run: async (user, ctx) => {
    await sendEmail({
      to: user.email,
      template: Templates.ACTIVATION_WELCOME,
    });
    await ctx.sleep({ duration: days(2) });
  },
});`;

const WELCOME_LINES = tokenize(WELCOME_CODE);
const SLEEP_LINE = 11; // `await ctx.sleep({ duration: days(2) });`

// ---------------------------------------------------------------------------
// Terminal session timeline (frames are local to the terminal sequence,
// which starts at global frame 0 — so they match the beat sheet exactly)
// ---------------------------------------------------------------------------

const TT = {
  cmd1TypeStart: 6,
  cmd1Speed: 1.1,
  outAt: 60, // beat 2 — scaffold output
  outStagger: 9,
  cmd2At: 138, // beat 3 — cd my-app
  cmd3At: 152, // hogsend dev
  cmdSpeed: 2.2,
  readyAt: 172, // → API on :3002 · Studio at /studio
} as const;

const EDITOR_HIGHLIGHT_AT = 75; // local to editor sequence (global 270)
const EDITOR_CAPTION_AT = 92;
const EDITOR_BEAT_FRAMES = 135;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ---------------------------------------------------------------------------
// Layout helper — a centred content layer matching SceneShell's padding so
// the terminal sits at the exact same spot across hard cuts.
// ---------------------------------------------------------------------------

const Layer: React.FC<{
  children?: ReactNode;
  justify?: "center" | "end";
}> = ({ children, justify = "center" }) => {
  const f = useFormat();
  return (
    <AbsoluteFill
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: justify === "end" ? "flex-end" : "center",
        alignItems: "center",
        paddingLeft: f.pad,
        paddingRight: f.pad,
        paddingTop: f.pad + f.safeTop,
        paddingBottom: f.pad + f.safeBottom,
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// Terminal rows — one continuous zsh session across beats 1–3
// ---------------------------------------------------------------------------

const Cursor: React.FC<{ size: number; solid: boolean }> = ({
  size,
  solid,
}) => (
  <span
    style={{
      display: "inline-block",
      width: size * 0.55,
      height: size * 1.15,
      verticalAlign: "text-bottom",
      backgroundColor: solid ? theme.text : theme.textMuted,
      marginLeft: 2,
    }}
  />
);

const CmdRow: React.FC<{
  tf: number;
  text: string;
  at: number;
  typeStart: number;
  speed: number;
  cursorUntil: number;
  size: number;
}> = ({ tf, text, at, typeStart, speed, cursorUntil, size }) => {
  if (tf < at) return null;
  const typed = charsVisible(text, tf, speed, typeStart);
  const done = typingDuration(text, speed, typeStart);
  const blinkOn = Math.floor((tf - done) / 9) % 2 === 0;
  const showCursor = tf < cursorUntil && (tf < done || blinkOn);
  return (
    <div>
      <span style={{ color: theme.accent }}>❯ </span>
      <span>{text.slice(0, typed)}</span>
      {showCursor ? <Cursor size={size} solid={tf < done} /> : null}
    </div>
  );
};

const TaskRow: React.FC<{
  tf: number;
  text: string;
  at: number;
  spin: number;
}> = ({ tf, text, at, spin }) => {
  const { fps } = useVideoConfig();
  if (tf < at) return null;
  const local = tf - at;
  const rise = pop(local, fps);
  const ticked = local >= spin;
  const glyph = ticked ? "✓" : SPINNER[Math.floor(local / 3) % SPINNER.length];
  return (
    <div style={{ opacity: rise }}>
      <span style={{ color: ticked ? theme.accent : theme.textMuted }}>
        {glyph}{" "}
      </span>
      {text}
    </div>
  );
};

const FileRow: React.FC<{ tf: number; text: string; at: number }> = ({
  tf,
  text,
  at,
}) => {
  const { fps } = useVideoConfig();
  if (tf < at) return null;
  const rise = pop(tf - at, fps);
  return (
    <div style={{ opacity: rise, color: theme.textMuted }}>{`  ${text}`}</div>
  );
};

const ReadyRow: React.FC<{ tf: number; at: number }> = ({ tf, at }) => {
  const { fps } = useVideoConfig();
  if (tf < at) return null;
  const rise = pop(tf - at, fps);
  return (
    <div style={{ opacity: rise }}>
      <span style={{ color: theme.accent }}>→ </span>
      API on :3002 <span style={{ color: theme.textMuted }}>·</span> Studio at
      /studio
    </div>
  );
};

const TerminalRows: React.FC<{ tf: number; size: number }> = ({ tf, size }) => (
  <>
    <CmdRow
      tf={tf}
      text={CMD_1}
      at={0}
      typeStart={TT.cmd1TypeStart}
      speed={TT.cmd1Speed}
      cursorUntil={TT.outAt}
      size={size}
    />
    <TaskRow tf={tf} text="Scaffolding my-app" at={TT.outAt} spin={10} />
    {SCAFFOLD_FILES.map((file, i) => (
      <FileRow
        key={file}
        tf={tf}
        text={file}
        at={TT.outAt + (i + 1) * TT.outStagger}
      />
    ))}
    <TaskRow
      tf={tf}
      text="@hogsend/engine pinned"
      at={TT.outAt + 7 * TT.outStagger}
      spin={8}
    />
    <CmdRow
      tf={tf}
      text={CMD_2}
      at={TT.cmd2At}
      typeStart={TT.cmd2At + 3}
      speed={TT.cmdSpeed}
      cursorUntil={TT.cmd3At}
      size={size}
    />
    <CmdRow
      tf={tf}
      text={CMD_3}
      at={TT.cmd3At}
      typeStart={TT.cmd3At + 3}
      speed={TT.cmdSpeed}
      cursorUntil={TT.readyAt}
      size={size}
    />
    <ReadyRow tf={tf} at={TT.readyAt} />
  </>
);

/**
 * The terminal card. Its size is fixed from frame 0 (a hidden fully-played
 * copy reserves the final height) so the window never jumps as lines print —
 * content simply fills the pane, like a real terminal.
 */
const ScaffoldTerminal: React.FC<{ tf: number }> = ({ tf }) => {
  const f = useFormat();
  const size = Math.round(26 * f.fontScale * (f.isPortrait ? 1.15 : 1));
  const width =
    f.ratio === "169" ? Math.min(f.width * 0.52, 1000) : ("100%" as const);
  const pad = `${Math.round(size * 1.05)}px ${Math.round(size * 1.3)}px`;
  return (
    <CardChrome title="zsh — my-app" width={width} scale={f.fontScale}>
      <div
        style={{
          position: "relative",
          fontFamily: FONT_MONO,
          fontSize: size,
          lineHeight: 1.72,
          whiteSpace: "pre",
          color: theme.text,
        }}
      >
        <div style={{ visibility: "hidden", padding: pad }}>
          <TerminalRows tf={100000} size={size} />
        </div>
        <div style={{ position: "absolute", inset: 0, padding: pad }}>
          <TerminalRows tf={tf} size={size} />
        </div>
      </div>
    </CardChrome>
  );
};

// ---------------------------------------------------------------------------
// Editor — SC-2 cascades in (it already exists, it is not being typed)
// ---------------------------------------------------------------------------

const tokenColor = (kind: TokenKind, emphasis: boolean): string => {
  if (emphasis) return syntax.emphasis;
  return syntax[kind === "plain" ? "base" : kind];
};

const CascadeCode: React.FC<{
  ef: number;
  width: number | string;
}> = ({ ef, width }) => {
  const f = useFormat();
  const { fps } = useVideoConfig();
  const size = Math.round(26 * f.fontScale * (f.isPortrait ? 1.15 : 1));
  const hl = pop(ef, fps, EDITOR_HIGHLIGHT_AT);
  return (
    <CardChrome
      title="src/journeys/welcome.ts"
      width={width}
      scale={f.fontScale}
    >
      <div
        style={{
          padding: `${Math.round(size * 1.05)}px ${Math.round(size * 1.3)}px`,
          fontFamily: FONT_MONO,
          fontSize: size,
          fontWeight: 400,
          lineHeight: 1.7,
          whiteSpace: "pre",
          color: syntax.base,
        }}
      >
        {WELCOME_LINES.map((line, li) => {
          const p = pop(ef, fps, 8 + li * 3);
          const lineKey = line.map((t) => t.text).join("") || `blank-${li}`;
          return (
            <div
              key={lineKey}
              style={{
                position: "relative",
                minHeight: size * 1.7,
                opacity: p,
                transform: `translateY(${interpolate(p, [0, 1], [10, 0])}px)`,
              }}
            >
              {li === SLEEP_LINE && hl > 0 ? (
                <div
                  style={{
                    position: "absolute",
                    left: -size * 0.65,
                    right: -size * 0.65,
                    top: -size * 0.08,
                    bottom: -size * 0.08,
                    backgroundColor: theme.accentTint,
                    borderLeft: `3px solid ${theme.accent}`,
                    transform: `scaleX(${hl})`,
                    transformOrigin: "left",
                  }}
                />
              ) : null}
              <span style={{ position: "relative" }}>
                {line.map((token, ti) => (
                  <span
                    key={`${lineKey}-${
                      // biome-ignore lint/suspicious/noArrayIndexKey: static code
                      ti
                    }`}
                    style={{ color: tokenColor(token.kind, token.emphasis) }}
                  >
                    {token.text}
                  </span>
                ))}
              </span>
            </div>
          );
        })}
      </div>
    </CardChrome>
  );
};

/**
 * Editor composite: the finished terminal retreats (slides aside, shrinks,
 * dims) while the editor card opens over it. `ef` is local to the editor
 * sequence; the tagline beat re-renders this in its settled state.
 */
const EditorScene: React.FC<{ ef: number }> = ({ ef }) => {
  const f = useFormat();
  const { fps } = useVideoConfig();
  const retreat = pop(ef, fps);
  const cardIn = pop(ef, fps, 5);
  const drift = microDrift(ef, EDITOR_BEAT_FRAMES);

  const dx = f.isPortrait
    ? 0
    : interpolate(
        retreat,
        [0, 1],
        [0, -(f.width * (f.ratio === "11" ? 0.16 : 0.2))],
      );
  const dy = f.isPortrait
    ? interpolate(retreat, [0, 1], [0, -(f.height * 0.17)])
    : 0;
  const tScale = interpolate(retreat, [0, 1], [1, 0.8]);
  const tOpacity = interpolate(retreat, [0, 1], [1, 0.22]);
  const editorWidth =
    f.ratio === "169" ? Math.min(f.width * 0.48, 920) : ("100%" as const);

  return (
    <>
      <Layer>
        <div
          style={{
            width: "100%",
            display: "flex",
            justifyContent: "center",
            transform: `translate(${dx}px, ${dy}px) scale(${tScale})`,
            opacity: tOpacity,
          }}
        >
          <ScaffoldTerminal tf={100000} />
        </div>
      </Layer>
      <Layer>
        <div
          style={{
            width: "100%",
            display: "flex",
            justifyContent: "center",
            opacity: cardIn,
            transform: `translateY(${interpolate(
              cardIn,
              [0, 1],
              [26, 0],
            )}px) scale(${interpolate(cardIn, [0, 1], [1.04, 1]) * drift})`,
          }}
        >
          <CascadeCode ef={ef} width={editorWidth} />
        </div>
      </Layer>
    </>
  );
};

// ---------------------------------------------------------------------------
// Beats
// ---------------------------------------------------------------------------

const TerminalBeat: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const intro = pop(frame, fps);
  return (
    <>
      <SceneShell />
      <Layer>
        <div
          style={{
            width: "100%",
            display: "flex",
            justifyContent: "center",
            opacity: intro,
            transform: `scale(${interpolate(intro, [0, 1], [1.04, 1])})`,
          }}
        >
          <ScaffoldTerminal tf={frame} />
        </div>
      </Layer>
    </>
  );
};

const EditorBeat: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();
  const cap = slideUp(frame, fps, EDITOR_CAPTION_AT);
  return (
    <>
      <SceneShell />
      <EditorScene ef={frame} />
      <Layer justify="end">
        <div
          style={{
            opacity: cap.opacity,
            transform: `translateY(${cap.translateY}px)`,
            fontFamily: FONT_BODY,
            fontWeight: 400,
            fontSize: Math.round(28 * f.fontScale),
            color: theme.textMuted,
          }}
        >
          Edit it like any other file.
        </div>
      </Layer>
    </>
  );
};

const TaglineBeat: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <>
      <SceneShell glow />
      <AbsoluteFill style={{ opacity: 0.12 }}>
        <EditorScene ef={frame + EDITOR_BEAT_FRAMES} />
      </AbsoluteFill>
      <Layer>
        <KineticText
          text="Your lifecycle, in your *repo.*"
          size="xl"
          delay={2}
        />
      </Layer>
    </>
  );
};

// ---------------------------------------------------------------------------
// The video — 450 frames: 195 (terminal, beats 1–3) + 135 (editor, beats
// 4–5) + 60 (tagline) + 60 (end card)
// ---------------------------------------------------------------------------

const ScaffoldDemo: React.FC<VideoProps> = () => (
  <AbsoluteFill style={{ backgroundColor: theme.ink }}>
    <Beats
      beats={[
        beat("terminal", 195, () => <TerminalBeat />),
        beat("editor", EDITOR_BEAT_FRAMES, () => <EditorBeat />),
        beat("tagline", 60, () => <TaglineBeat />),
        beat("end", 60, () => (
          <SceneShell glow drift>
            <EndCard line="Lifecycle email, shipped like a feature." />
          </SceneShell>
        )),
      ]}
    />
  </AbsoluteFill>
);

export const video = defineVideo({
  id: "scaffold-demo",
  durationInFrames: 450,
  fps: 30,
  component: ScaffoldDemo,
});
