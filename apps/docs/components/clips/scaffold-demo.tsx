"use client";

import type { ReactNode } from "react";
import { interpolate, pop, punchIn } from "./clip-anim";
import { theme, typo } from "./clip-theme";
import { useLoopFrame } from "./use-loop-frame";

// ---------------------------------------------------------------------------
// Native port of the Remotion scaffold-demo comp
// (marketing/video/src/videos/scaffold-demo/index.tsx + components/Terminal.tsx).
// A zsh session types `pnpm dlx create-hogsend@latest my-app`, then reveals
// "✓ Scaffolding my-app" and the scaffolded journey/email files line by line.
// Drives off the single looping web clock (useLoopFrame) instead of Remotion's
// useCurrentFrame()/useVideoConfig(), and collapses useFormat's 3-ratio system
// into one responsive layout. The typewriter cost model + spinner→tick task
// reveal are ported exactly from the reference.
// ---------------------------------------------------------------------------

const FPS = 30;

// ---------------------------------------------------------------------------
// Script content (exact copy from the reference — do not paraphrase).
// ---------------------------------------------------------------------------

const COMMAND = "pnpm dlx create-hogsend@latest my-app";

const SCAFFOLD_FILES = [
  "src/journeys/welcome.ts",
  "src/journeys/trial-expiring.ts",
  "src/journeys/feedback-checkin.ts",
  "src/emails/welcome.tsx",
  "src/emails/registry.ts",
  "src/webhook-sources/",
] as const;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

// ---------------------------------------------------------------------------
// Typewriter timing — ported verbatim from marketing/video/src/lib/typewriter.ts.
// Each character has a tick "cost"; line/clause ends cost more, creating
// natural micro-pauses. `charsVisible` maps a frame to a char count.
// ---------------------------------------------------------------------------

const costOf = (char: string, next: string | undefined): number => {
  if (char === "\n") {
    return 7;
  }
  if (next === "\n" && (char === ";" || char === "{" || char === ")")) {
    return 2.5;
  }
  if (char === " ") {
    return 0.7;
  }
  return 1;
};

const cumulativeCosts = (text: string): number[] => {
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < text.length; i += 1) {
    acc += costOf(text[i] as string, text[i + 1]);
    out.push(acc);
  }
  return out;
};

const charsVisible = (
  text: string,
  frame: number,
  speed: number,
  startDelay: number,
): number => {
  if (frame < startDelay) {
    return 0;
  }
  const budget = (frame - startDelay) * speed;
  const costs = cumulativeCosts(text);
  let lo = 0;
  let hi = costs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((costs[mid] as number) <= budget) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
};

const typingDuration = (
  text: string,
  speed: number,
  startDelay: number,
): number => {
  const costs = cumulativeCosts(text);
  const total = costs.length > 0 ? (costs[costs.length - 1] as number) : 0;
  return Math.ceil(total / speed) + startDelay;
};

// ---------------------------------------------------------------------------
// Session timeline — frames are local to the looping clip.
// ---------------------------------------------------------------------------

const TYPE_START = 8;
const TYPE_SPEED = 1.1;
const COMMAND_DONE = typingDuration(COMMAND, TYPE_SPEED, TYPE_START);

// Output begins after the command finishes typing; each row staggers in.
const OUTPUT_START = COMMAND_DONE + 8;
const ROW_STAGGER = 9;
const SCAFFOLD_AT = OUTPUT_START;
const FILES_AT = OUTPUT_START + ROW_STAGGER;
const PINNED_AT = OUTPUT_START + (SCAFFOLD_FILES.length + 1) * ROW_STAGGER;
const READY_AT = PINNED_AT + 20;

const HOLD = 64;
const TOTAL = READY_AT + 40 + HOLD;

// ---------------------------------------------------------------------------
// Rows.
// ---------------------------------------------------------------------------

function Cursor({ size, solid }: { size: number; solid: boolean }) {
  return (
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
}

/** The command line — types out after the prompt, blinking cursor at the end. */
function CommandRow({ frame, size }: { frame: number; size: number }) {
  const typed = charsVisible(COMMAND, frame, TYPE_SPEED, TYPE_START);
  const blinkOn = Math.floor((frame - COMMAND_DONE) / 9) % 2 === 0;
  const showCursor = frame < READY_AT && (frame < COMMAND_DONE || blinkOn);
  return (
    <div>
      <span style={{ color: theme.accent }}>❯ </span>
      <span>{COMMAND.slice(0, typed)}</span>
      {showCursor ? <Cursor size={size} solid={frame < COMMAND_DONE} /> : null}
    </div>
  );
}

/** A task line — spinner for `spin` frames, then an accent ✓ tick. */
function TaskRow({
  frame,
  at,
  text,
  spin,
}: {
  frame: number;
  at: number;
  text: string;
  spin: number;
}) {
  if (frame < at) {
    return null;
  }
  const local = frame - at;
  const rise = pop(frame, FPS, at);
  const ticked = local >= spin;
  const glyph = ticked ? "✓" : SPINNER[Math.floor(local / 3) % SPINNER.length];
  return (
    <div
      style={{
        opacity: rise,
        transform: `translateY(${interpolate(rise, [0, 1], [6, 0])}px)`,
      }}
    >
      <span style={{ color: ticked ? theme.accent : theme.textMuted }}>
        {glyph}{" "}
      </span>
      {text}
    </div>
  );
}

/** A scaffolded-file tree row. */
function FileRow({
  frame,
  at,
  text,
}: {
  frame: number;
  at: number;
  text: string;
}) {
  if (frame < at) {
    return null;
  }
  const rise = pop(frame, FPS, at);
  return (
    <div
      style={{
        opacity: rise,
        transform: `translateY(${interpolate(rise, [0, 1], [6, 0])}px)`,
        color: theme.textMuted,
      }}
    >
      <span style={{ color: theme.textHint }}>{"  └ "}</span>
      {text}
    </div>
  );
}

/** The ready line — the dev server is up. */
function ReadyRow({ frame, at }: { frame: number; at: number }) {
  if (frame < at) {
    return null;
  }
  const rise = pop(frame, FPS, at);
  return (
    <div
      style={{
        opacity: rise,
        transform: `translateY(${interpolate(rise, [0, 1], [6, 0])}px)`,
      }}
    >
      <span style={{ color: theme.accent }}>{"→ "}</span>
      API on :3002 <span style={{ color: theme.textMuted }}>·</span> Studio at
      /studio
    </div>
  );
}

function TerminalRows({ frame, size }: { frame: number; size: number }) {
  return (
    <>
      <CommandRow frame={frame} size={size} />
      <TaskRow
        frame={frame}
        at={SCAFFOLD_AT}
        text="Scaffolding my-app"
        spin={10}
      />
      {SCAFFOLD_FILES.map((file, i) => (
        <FileRow
          key={file}
          frame={frame}
          at={FILES_AT + i * ROW_STAGGER}
          text={file}
        />
      ))}
      <TaskRow
        frame={frame}
        at={PINNED_AT}
        text="@hogsend/engine pinned"
        spin={8}
      />
      <ReadyRow frame={frame} at={READY_AT} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Terminal card. A hidden, fully-played copy reserves the final height so the
// window never jumps as lines print — content simply fills the pane, exactly
// like the reference's two-layer ScaffoldTerminal.
// ---------------------------------------------------------------------------

function TerminalCard({ frame }: { frame: number }) {
  // One good responsive mono size; smaller on mobile.
  const size = 14;
  const pad = `${Math.round(size * 1.15)}px ${Math.round(size * 1.45)}px`;
  const body: ReactNode = (
    <div
      className="font-mono"
      style={{
        fontSize: size,
        lineHeight: 1.78,
        whiteSpace: "pre",
        color: theme.text,
      }}
    >
      {/* Hidden full-height reservation. */}
      <div style={{ visibility: "hidden", padding: pad }} aria-hidden="true">
        <TerminalRows frame={100000} size={size} />
      </div>
      {/* Live, overlaid. */}
      <div style={{ position: "absolute", inset: 0, padding: pad }}>
        <TerminalRows frame={frame} size={size} />
      </div>
    </div>
  );

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        overflow: "hidden",
        borderRadius: 16,
        backgroundColor: theme.paperPure,
        border: `1px solid ${theme.cardBorder}`,
        boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
      }}
    >
      {/* Window chrome — three dots + title in mono (ported from CodePanel). */}
      <div className="flex items-center gap-3 border-white/[0.08] border-b px-4 py-2.5">
        <div aria-hidden="true" className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-white/15" />
          <span className="size-2.5 rounded-full bg-white/15" />
          <span className="size-2.5 rounded-full bg-white/15" />
        </div>
        <span className="font-mono text-[11px] text-white/40 tracking-wide">
          zsh — my-app
        </span>
      </div>
      <div style={{ position: "relative" }}>{body}</div>
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
// The whole clip: a single scaffold terminal on the bare stage, with a subtle
// bottom red glow that lifts as the dev server comes up, looping.
// ---------------------------------------------------------------------------

export function ScaffoldDemo() {
  const { ref, frame } = useLoopFrame(TOTAL, FPS);

  const push = interpolate(frame, [0, TOTAL], [1, 1.02], {
    extrapolateRight: "clamp",
  });
  const glowIn = interpolate(frame, [READY_AT, READY_AT + 30], [0, 0.95], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      ref={ref}
      className="relative overflow-hidden rounded-xl"
      style={{
        position: "relative",
        width: "100%",
        height: "clamp(380px, 52vw, 520px)",
        borderRadius: 12,
        border: `1px solid ${theme.cardBorder}`,
        backgroundColor: theme.ink,
        overflow: "hidden",
      }}
    >
      {/* Subtle bottom red glow — the reference's SceneShell aurora. */}
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
        className="absolute inset-0 flex flex-col items-center justify-center gap-5 p-6 md:p-10"
        style={{
          transform: `scale(${punchIn(frame, FPS) * push})`,
          transformOrigin: "center",
        }}
      >
        <div className="w-full" style={{ maxWidth: 620 }}>
          <div style={{ paddingBottom: 16 }}>
            <Eyebrow frame={frame} text="One command" />
          </div>
          <TerminalCard frame={frame} />
        </div>
      </div>
    </div>
  );
}
