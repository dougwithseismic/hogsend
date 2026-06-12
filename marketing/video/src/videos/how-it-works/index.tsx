import type React from "react";
import type { ReactNode } from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { BrowserChrome } from "../../components/BrowserChrome";
import { CodeScene } from "../../components/CodeScene";
import { EmailCard } from "../../components/EmailCard";
import { EndCard } from "../../components/EndCard";
import { FlowDiagram } from "../../components/FlowDiagram";
import { KineticText } from "../../components/KineticText";
import { SceneShell } from "../../components/SceneShell";
import { Terminal } from "../../components/Terminal";
import { FONT_DISPLAY, FONT_MONO } from "../../fonts";
import { Beats, beat, pop, punchIn, SPRING_POP, slideUp } from "../../lib/anim";
import { defineVideo, type VideoProps } from "../../lib/define-video";
import { useFormat } from "../../lib/format";
import { theme } from "../../lib/theme";

// ---------------------------------------------------------------------------
// Copy — persona slots (beats 1, 14, 18 swap; everything else is shared)
// ---------------------------------------------------------------------------

type Slots = { a: string; b: string; c: string };

const FOUNDER_SLOTS: Slots = {
  a: "You own the stack. Except this bit.",
  b: "Your data. Your domain. One less vendor.",
  c: "Own this bit too.",
};

const PERSONA_SLOTS: Record<string, Slots> = {
  founder: FOUNDER_SLOTS,
  engineer: {
    a: "The one system you can’t code-review.",
    b: "Typed. Versioned. Reviewed like everything else.",
    c: "Ship it like a feature.",
  },
  pm: {
    a: "Which email did we send them?",
    b: "Every journey, send and click — in Studio.",
    c: "Full visibility by Friday.",
  },
  marketer: {
    a: "You’ve hit the canvas ceiling.",
    b: "Branching the canvas could never draw.",
    c: "Ask engineering for an afternoon.",
  },
  agent: {
    a: "Your agents can’t click a canvas.",
    b: "It’s all TypeScript. Agents ship journeys.",
    c: "Point your agent at the repo.",
  },
};

const SNIPPET_HW1 = `export const welcome = defineJourney({
  meta: {
    id: "activation-welcome",
    trigger: { event: ⟦Events.USER_CREATED⟧ },
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

const SNIPPET_HW2 = `const { timedOut } = await ⟦ctx.waitForEvent⟧({
  event: Events.FEATURE_USED,
  timeout: days(3),
});`;

const SCAFFOLD_CMD = "pnpm dlx create-hogsend@latest";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** 1.04→1.00 punch-in on the first frames of a beat. */
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

/** Small secondary line under a card/diagram. */
const Caption: React.FC<{ text: string; delay?: number; mono?: boolean }> = ({
  text,
  delay = 0,
  mono = false,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();
  const s = f.fontScale;
  const inAnim = slideUp(frame, fps, delay, 20);
  return (
    <div
      style={{
        opacity: inAnim.opacity,
        transform: `translateY(${inAnim.translateY}px)`,
        fontFamily: mono ? FONT_MONO : FONT_DISPLAY,
        fontWeight: 400,
        fontSize: Math.round((mono ? 19 : 31) * s),
        letterSpacing: mono ? "0.02em" : "-0.01em",
        color: theme.textMuted,
        textAlign: "center",
      }}
    >
      {text}
    </div>
  );
};

/**
 * Generic flowchart-canvas wireframe — the dashboard builder ghost.
 * Dot grid + trigger node + condition diamond + two branch nodes.
 */
const CanvasGhost: React.FC<{ opacity: number }> = ({ opacity }) => {
  const f = useFormat();
  const w = f.isPortrait ? f.width * 0.86 : Math.min(f.width * 0.52, 980);
  const h = (w / 640) * 430;
  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        transform: "translate(-50%, -50%)",
        width: w,
        height: h,
        opacity,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "radial-gradient(rgba(255,255,255,0.55) 1.2px, transparent 1.2px)",
          backgroundSize: "34px 34px",
          opacity: 0.5,
        }}
      />
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 640 430"
        fill="none"
        role="img"
        aria-label="flowchart canvas wireframe"
      >
        <rect
          x="240"
          y="18"
          width="160"
          height="52"
          rx="10"
          stroke="#ffffff"
          strokeWidth="1.5"
        />
        <line
          x1="320"
          y1="70"
          x2="320"
          y2="128"
          stroke="#ffffff"
          strokeWidth="1.5"
        />
        <rect
          x="284"
          y="130"
          width="72"
          height="72"
          rx="9"
          transform="rotate(45 320 166)"
          stroke="#ffffff"
          strokeWidth="1.5"
        />
        <line
          x1="320"
          y1="204"
          x2="320"
          y2="246"
          stroke="#ffffff"
          strokeWidth="1.5"
        />
        <line
          x1="160"
          y1="246"
          x2="480"
          y2="246"
          stroke="#ffffff"
          strokeWidth="1.5"
        />
        <line
          x1="160"
          y1="246"
          x2="160"
          y2="290"
          stroke="#ffffff"
          strokeWidth="1.5"
        />
        <line
          x1="480"
          y1="246"
          x2="480"
          y2="290"
          stroke="#ffffff"
          strokeWidth="1.5"
        />
        <rect
          x="80"
          y="290"
          width="160"
          height="52"
          rx="10"
          stroke="#ffffff"
          strokeWidth="1.5"
        />
        <rect
          x="400"
          y="290"
          width="160"
          height="52"
          rx="10"
          stroke="#ffffff"
          strokeWidth="1.5"
        />
        <circle cx="320" cy="70" r="4.5" fill="#ffffff" />
        <circle cx="160" cy="246" r="4.5" fill="#ffffff" />
        <circle cx="480" cy="246" r="4.5" fill="#ffffff" />
        <rect
          x="262"
          y="36"
          width="116"
          height="9"
          rx="4.5"
          fill="#ffffff"
          opacity="0.45"
        />
        <rect
          x="102"
          y="308"
          width="116"
          height="9"
          rx="4.5"
          fill="#ffffff"
          opacity="0.45"
        />
        <rect
          x="422"
          y="308"
          width="116"
          height="9"
          rx="4.5"
          fill="#ffffff"
          opacity="0.45"
        />
      </svg>
    </div>
  );
};

/** Relative stack: a centred absolute layer behind in-flow content. */
const LayerStack: React.FC<{ behind: ReactNode; children: ReactNode }> = ({
  behind,
  children,
}) => (
  <div
    style={{
      position: "relative",
      width: "100%",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
    }}
  >
    {behind}
    {children}
  </div>
);

/** Three words stamping in one at a time, left to right. */
const StampWords: React.FC<{ words: string[]; at: number[] }> = ({
  words,
  at,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();
  const fontSize = Math.round(88 * f.fontScale);
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        columnGap: fontSize * 0.42,
        rowGap: fontSize * 0.14,
        fontFamily: FONT_DISPLAY,
        fontWeight: 500,
        fontSize,
        lineHeight: 1.08,
        letterSpacing: "-0.03em",
        color: theme.text,
        textAlign: "center",
      }}
    >
      {words.map((word, i) => {
        const local = frame - (at[i] ?? 0);
        const p = spring({
          frame: local,
          fps,
          config: SPRING_POP,
          durationInFrames: 10,
        });
        const o = interpolate(local, [0, 3], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        return (
          <span
            key={word}
            style={{
              display: "inline-block",
              opacity: o,
              transform: `scale(${interpolate(p, [0, 1], [1.28, 1])})`,
            }}
          >
            {word}
          </span>
        );
      })}
    </div>
  );
};

/** Thin timeline strip with deploy tick markers sliding past. */
const DeployTimeline: React.FC = () => {
  const frame = useCurrentFrame();
  const f = useFormat();
  const s = f.fontScale;
  const width = f.isPortrait ? "100%" : Math.min(f.width * 0.52, 980);
  const marks = [
    { from: 104, to: 16 },
    { from: 150, to: 62 },
  ];
  return (
    <div
      style={{
        position: "relative",
        width,
        height: 64 * s,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 18 * s,
          height: 1,
          backgroundColor: theme.hairlineFaint,
        }}
      />
      {marks.map(({ from, to }) => {
        const x = interpolate(frame, [0, 60], [from, to], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        return (
          <div
            key={from}
            style={{
              position: "absolute",
              left: `${x}%`,
              top: 8 * s,
              transform: "translateX(-50%)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8 * s,
            }}
          >
            <div
              style={{
                width: 2,
                height: 20 * s,
                backgroundColor: theme.accent,
              }}
            />
            <span
              style={{
                fontFamily: FONT_MONO,
                fontSize: 15 * s,
                color: theme.textMuted,
                letterSpacing: "0.04em",
              }}
            >
              deploy
            </span>
          </div>
        );
      })}
    </div>
  );
};

/** Faint sends-table row motif (beat 13, behind the type). */
const RowMotif: React.FC<{ delay?: number }> = ({ delay = 14 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();
  const s = f.fontScale;
  const p = pop(frame, fps, delay);
  return (
    <div
      style={{
        opacity: p * 0.55,
        transform: `scale(${interpolate(p, [0, 1], [1.1, 1])})`,
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        justifyContent: "center",
        gap: 30 * s,
        backgroundColor: theme.paperPure,
        border: `1px solid ${theme.hairlineFaint}`,
        borderRadius: 12 * s,
        padding: `${16 * s}px ${34 * s}px`,
        fontFamily: FONT_MONO,
        fontSize: 17 * s,
        color: theme.textMuted,
        whiteSpace: "nowrap",
      }}
    >
      <span>amy@acme.com</span>
      <span>welcome</span>
      {["delivered", "opened", "clicked"].map((label) => (
        <span key={label}>
          <span style={{ color: theme.accent }}>✓ </span>
          {label}
        </span>
      ))}
    </div>
  );
};

/** Studio screenshot with a lower-third scrim + display line. */
const StudioShot: React.FC<{ src: string; line: string }> = ({ src, line }) => {
  const f = useFormat();
  const s = f.fontScale;
  return (
    <Punch>
      <div
        style={{
          position: "relative",
          width: f.isPortrait ? "100%" : Math.min(f.width * 0.78, 1440),
        }}
      >
        <BrowserChrome src={src} url="hogsend.com/studio" width="100%" />
        <div
          style={{
            position: "absolute",
            left: 1,
            right: 1,
            bottom: 1,
            height: "52%",
            borderRadius: `0 0 ${14 * s}px ${14 * s}px`,
            background:
              "linear-gradient(180deg, rgba(5,1,1,0) 0%, rgba(5,1,1,0.94) 82%)",
            display: "flex",
            alignItems: "flex-end",
            padding: 44 * s,
          }}
        >
          <KineticText text={line} size="md" align="left" delay={8} />
        </div>
      </div>
    </Punch>
  );
};

/** Sweeping accent highlight band across one code line (beat 9). */
const LineSweep: React.FC<{ lineIndex: number; codeFs: number }> = ({
  lineIndex,
  codeFs,
}) => {
  const frame = useCurrentFrame();
  const f = useFormat();
  const s = f.fontScale;
  // CardChrome header: 14*s padding ×2 + title row (~18*s) + 1px border.
  const headerH = 28 * s + 18 * s + 1;
  const top = headerH + Math.round(codeFs * 1.1) + lineIndex * codeFs * 1.7;
  const x = interpolate(frame, [12, 46], [-45, 145], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const o = interpolate(frame, [10, 16, 42, 50], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        left: 1,
        right: 1,
        top,
        height: codeFs * 1.78,
        overflow: "hidden",
        opacity: o,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: `${x}%`,
          top: 0,
          bottom: 0,
          width: "45%",
          background: `linear-gradient(90deg, transparent, ${theme.accentTint}, transparent)`,
        }}
      />
    </div>
  );
};

/** Small mono command chip (beat 18 → carries into the end card). */
const CommandChip: React.FC<{ delay?: number }> = ({ delay = 18 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();
  const s = f.fontScale;
  const inAnim = slideUp(frame, fps, delay, 22);
  return (
    <div
      style={{
        opacity: inAnim.opacity,
        transform: `translateY(${inAnim.translateY}px)`,
        fontFamily: FONT_MONO,
        fontWeight: 500,
        fontSize: 21 * s,
        color: theme.textMuted,
        backgroundColor: theme.paperPure,
        border: `1px solid ${theme.hairlineFaint}`,
        borderRadius: 10 * s,
        padding: `${13 * s}px ${26 * s}px`,
        whiteSpace: "nowrap",
        marginTop: 44 * s,
      }}
    >
      <span style={{ color: theme.accent }}>❯ </span>
      {SCAFFOLD_CMD}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Composite beats
// ---------------------------------------------------------------------------

/** Beat 2 — dashboard line over the ghosting canvas. */
const DashboardBeat: React.FC = () => {
  const frame = useCurrentFrame();
  const ghost = interpolate(frame, [4, 20], [0, 0.1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <SceneShell>
      <LayerStack behind={<CanvasGhost opacity={ghost} />}>
        <KineticText
          text="Your lifecycle runs in a dashboard builder."
          size="lg"
        />
      </LayerStack>
    </SceneShell>
  );
};

/** Beat 3 — three stamped words; canvas ghost flickers on each stamp. */
const StampBeat: React.FC = () => {
  const frame = useCurrentFrame();
  const stamps = [6, 22, 38];
  const flicker = stamps.reduce(
    (acc, t) =>
      acc +
      interpolate(frame, [t, t + 1, t + 6], [0, 0.08, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      }),
    0.1,
  );
  return (
    <SceneShell>
      <LayerStack behind={<CanvasGhost opacity={flicker} />}>
        <StampWords
          words={["Unreviewed.", "Unversioned.", "Untyped."]}
          at={stamps}
        />
      </LayerStack>
    </SceneShell>
  );
};

/** Beat 4 — the canvas dissolves; the line lands. */
const BelongsBeat: React.FC = () => {
  const frame = useCurrentFrame();
  const ghost = interpolate(frame, [0, 14], [0.1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <SceneShell drift>
      <LayerStack behind={<CanvasGhost opacity={ghost} />}>
        <KineticText text="It belongs in your *repo*." size="xl" />
      </LayerStack>
    </SceneShell>
  );
};

/** Beats 5–6 — HW-1 types continuously across 150 frames. */
const CodeTypeBeat: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = useFormat();
  const p = pop(frame, fps);
  return (
    <SceneShell>
      <div
        style={{
          opacity: p,
          transform: `scale(${interpolate(p, [0, 1], [0.97, 1])})`,
          width: f.isPortrait ? "100%" : undefined,
        }}
      >
        <CodeScene
          filename="src/journeys/welcome.ts"
          code={SNIPPET_HW1}
          typeSpeed={3.2}
          startDelay={10}
        />
      </div>
    </SceneShell>
  );
};

/** Beats 7–8 — event → journey → email flow; caption swaps mid-way. */
const FlowBeat: React.FC = () => {
  const frame = useCurrentFrame();
  const f = useFormat();
  const s = f.fontScale;
  const phase = frame < 60 ? 0 : 1;
  const caption =
    phase === 0 ? "An event fires." : "The right email, decided in code.";
  // The journey node holds a steady glow once the pulse arrives (~f44).
  const glow = interpolate(frame, [44, 58], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <SceneShell drift driftFrames={120}>
      <Punch>
        <div style={{ position: "relative" }}>
          <div
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              transform: "translate(-50%, -50%)",
              width: 460 * s,
              height: 460 * s,
              borderRadius: "50%",
              background: `radial-gradient(circle, ${theme.accentTint}, transparent 62%)`,
              opacity: glow,
            }}
          />
          <FlowDiagram
            nodes={[
              { label: "user.created" },
              { label: "activation-welcome" },
              { label: "email" },
            ]}
            pulseStart={12}
            hopFrames={32}
            scale={1.35}
          />
        </div>
        <div style={{ marginTop: 64 * s }}>
          <Caption key={phase} text={caption} delay={phase === 0 ? 14 : 60} />
        </div>
      </Punch>
    </SceneShell>
  );
};

/** Beat 9 — HW-2 sits alone; a highlight sweep crosses the wait call. */
const WaitsBeat: React.FC = () => {
  const f = useFormat();
  const codeFs = Math.round(26 * f.fontScale * (f.isPortrait ? 1.15 : 1));
  return (
    <SceneShell>
      <Punch>
        <div
          style={{
            position: "relative",
            width: f.isPortrait ? "100%" : Math.min(f.width * 0.62, 1080),
          }}
        >
          <CodeScene
            filename="src/journeys/welcome.ts"
            code={SNIPPET_HW2}
            instant
            width="100%"
          />
          <LineSweep lineIndex={0} codeFs={codeFs} />
        </div>
        <div style={{ marginTop: 52 * f.fontScale }}>
          <Caption text="Then it waits." delay={10} />
        </div>
      </Punch>
    </SceneShell>
  );
};

/** Beat 10 — code dims; the durability line over a deploy timeline. */
const DurableBeat: React.FC = () => {
  const f = useFormat();
  const s = f.fontScale;
  return (
    <SceneShell>
      <LayerStack
        behind={
          <div
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              transform: "translate(-50%, -50%)",
              width: f.isPortrait ? "100%" : Math.min(f.width * 0.62, 1080),
              opacity: 0.2,
            }}
          >
            <CodeScene
              filename="src/journeys/welcome.ts"
              code={SNIPPET_HW2}
              instant
              width="100%"
            />
          </div>
        }
      >
        <KineticText text="Three days. Two deploys. Still waiting." size="lg" />
        <div
          style={{
            marginTop: 56 * s,
            width: "100%",
            display: "flex",
            justifyContent: "center",
          }}
        >
          <DeployTimeline />
        </div>
        <div style={{ marginTop: 18 * s }}>
          <Caption text="Durable execution via Hatchet." delay={20} mono />
        </div>
      </LayerStack>
    </SceneShell>
  );
};

/** Beats 11–12 — the email lands, then the status row ticks. */
const EmailBeat: React.FC = () => (
  <SceneShell drift driftFrames={120}>
    <EmailCard
      subject="Welcome — let’s get you set up"
      from="you@yourdomain.com"
      statusAt={{ delivered: 64, opened: 82, clicked: 100 }}
    />
  </SceneShell>
);

/** Beat 13 — first-party line over a faint sends-table row. */
const DomainBeat: React.FC = () => {
  const f = useFormat();
  return (
    <SceneShell drift>
      <KineticText text="On your domain. In your Postgres." size="lg" />
      <div style={{ marginTop: 60 * f.fontScale }}>
        <RowMotif />
      </div>
    </SceneShell>
  );
};

// ---------------------------------------------------------------------------
// The video
// ---------------------------------------------------------------------------

const HowItWorks: React.FC<VideoProps> = ({ persona }) => {
  const slots = PERSONA_SLOTS[persona ?? "founder"] ?? FOUNDER_SLOTS;

  return (
    <Beats
      beats={[
        // 0–74 · SLOT A — persona hook
        beat("hook", 75, () => (
          <SceneShell glow drift>
            <KineticText text={slots.a} size="xl" />
          </SceneShell>
        )),
        // 75–134 · dashboard builder line + canvas ghost
        beat("dashboard", 60, () => <DashboardBeat />),
        // 135–194 · Unreviewed. Unversioned. Untyped.
        beat("stamps", 60, () => <StampBeat />),
        // 195–254 · It belongs in your repo.
        beat("belongs", 60, () => <BelongsBeat />),
        // 255–404 · HW-1 types in (script beats 5+6, continuous)
        beat("code-hw1", 150, () => <CodeTypeBeat />),
        // 405–524 · event → journey → email (script beats 7+8)
        beat("flow", 120, () => <FlowBeat />),
        // 525–584 · Then it waits.
        beat("waits", 60, () => <WaitsBeat />),
        // 585–644 · Three days. Two deploys. Still waiting.
        beat("durable", 60, () => <DurableBeat />),
        // 645–764 · the email + status ticks (script beats 11+12)
        beat("email", 120, () => <EmailBeat />),
        // 765–824 · On your domain. In your Postgres.
        beat("domain", 60, () => <DomainBeat />),
        // 825–884 · SLOT B — persona emphasis
        beat("slot-b", 60, () => (
          <SceneShell glow drift>
            <KineticText text={slots.b} size="lg" />
          </SceneShell>
        )),
        // 885–944 · Studio observes.
        beat("studio-observes", 60, () => (
          <SceneShell>
            <StudioShot
              src="screenshots/01-overview.png"
              line="Studio observes."
            />
          </SceneShell>
        )),
        // 945–1004 · Code decides.
        beat("code-decides", 60, () => (
          <SceneShell>
            <StudioShot src="screenshots/02-sends.png" line="Code decides." />
          </SceneShell>
        )),
        // 1005–1064 · the scaffold command
        beat("terminal", 60, () => (
          <SceneShell drift>
            <Punch>
              <Terminal command={SCAFFOLD_CMD} />
            </Punch>
          </SceneShell>
        )),
        // 1065–1139 · SLOT C — persona CTA + command chip
        beat("cta", 75, () => (
          <SceneShell glow drift>
            <KineticText text={slots.c} size="xl" />
            <CommandChip />
          </SceneShell>
        )),
        // 1140–1199 · standard end card
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
  id: "how-it-works",
  durationInFrames: 1200,
  fps: 30,
  personas: ["founder", "engineer", "pm", "marketer", "agent"],
  component: HowItWorks,
});
