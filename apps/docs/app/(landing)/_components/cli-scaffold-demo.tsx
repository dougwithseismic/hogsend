"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  activeEventLines,
  autopilotKey,
  buildEvents,
  completeDemo,
  type DemoState,
  finalEventLines,
  INITIAL_DEMO_STATE,
  keyDemo,
  type Line,
  type Tone,
  tickDemo,
} from "./cli-scaffold-demo-state";

/* Clock — one timeout per micro-step, delay picked by what's animating. */
const SHELL_TYPE_MS = 45;
const LINE_FAST_MS = 55;
const LINE_STEP_MS = 150;
const SPIN_MS = 90;
const AUTOPILOT_TYPE_MS = 65;
const AUTOPILOT_MOVE_MS = 340;
const AUTOPILOT_SUBMIT_MS = 480;

/* The ANSI palette, tuned to sit on the crimzon #0a0606 panel. */
const TONE_CLASS: Record<Tone, string> = {
  plain: "text-white/85",
  dim: "text-white/40",
  gray: "text-white/25",
  cyan: "text-[#5fc3d8]",
  green: "text-[#23c489]",
  yellow: "text-[#e0b458]",
  magenta: "text-[#d073dd]",
  blue: "text-[#6f9ff2]",
  badge: "bg-[#d073dd] text-black",
  cursor: "hs-cli-cursor bg-white/70 text-black",
};

function TerminalLine({ line }: { line: Line }) {
  if (line.length === 0) return <p aria-hidden="true">&nbsp;</p>;
  return (
    <p className="whitespace-pre-wrap break-words">
      {line.map((span, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: spans are positional within a line
          key={i}
          className={`${TONE_CLASS[span.tone ?? "plain"]}${span.b ? " font-semibold" : ""}`}
        >
          {span.text}
        </span>
      ))}
    </p>
  );
}

/**
 * The create-hogsend scaffolder, replayed at full fidelity: the clack prompts
 * answered with the defaults, the spinners, the streamed bootstrap and its
 * numbered steps, through to the outro — every string is the real CLI's.
 */
export function CliScaffoldDemo({ version = "0.52.1" }: { version?: string }) {
  const [state, setState] = useState<DemoState>(INITIAL_DEMO_STATE);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [inView, setInView] = useState(false);
  const followRef = useRef(true);
  const viewportRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);

  const events = useMemo(
    () => buildEvents(state.answers, version),
    [state.answers, version],
  );

  // Run only on-screen — the replay clock re-renders up to ~20×/s.
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { rootMargin: "80px" },
    );
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      setReduceMotion(media.matches);
      if (media.matches) setState(completeDemo(version).state);
    };
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [version]);

  // The replay clock: time-driven events tick; prompts advance via autopilot.
  useEffect(() => {
    if (reduceMotion || !inView || state.done) return;
    const event = events[state.eventIndex];

    const step =
      event.kind === "prompt"
        ? () => {
            const key = autopilotKey(state, events);
            return key === null
              ? null
              : {
                  delay:
                    key.type === "char"
                      ? AUTOPILOT_TYPE_MS
                      : key.type === "enter"
                        ? AUTOPILOT_SUBMIT_MS
                        : AUTOPILOT_MOVE_MS,
                  apply: (s: DemoState) =>
                    keyDemo(s, buildEvents(s.answers, version), key, version),
                };
          }
        : () => ({
            delay:
              event.kind === "shell"
                ? SHELL_TYPE_MS
                : event.kind === "spinner"
                  ? SPIN_MS
                  : event.speed === "fast"
                    ? LINE_FAST_MS
                    : LINE_STEP_MS,
            apply: (s: DemoState) =>
              tickDemo(s, buildEvents(s.answers, version)),
          });

    const next = step();
    if (!next) return;
    const timeout = window.setTimeout(() => setState(next.apply), next.delay);
    return () => window.clearTimeout(timeout);
  }, [state, events, inView, reduceMotion, version]);

  // Follow the tail unless the visitor scrolled back up to read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-runs on every machine tick — new output should keep the tail in view
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !followRef.current) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "instant" });
  }, [state]);

  const replay = () => {
    followRef.current = true;
    setState(INITIAL_DEMO_STATE);
  };

  const transcript: Line[] = [
    ...events
      .slice(0, state.eventIndex)
      .flatMap((event) => finalEventLines(event, state.answers)),
    ...activeEventLines(state, events),
  ];

  return (
    <div
      ref={shellRef}
      aria-label="create-hogsend setup replay"
      className="relative min-w-0 overflow-hidden rounded-xl border border-white/15 bg-[#0a0606] shadow-lg"
      data-cli-demo
      role="img"
    >
      <style>{`
        @keyframes hs-cli-blink { 0%, 55% { opacity: 1; } 56%, 100% { opacity: 0.15; } }
        .hs-cli-cursor { animation: hs-cli-blink 1.1s steps(1) infinite; }
        @media (prefers-reduced-motion: reduce) { .hs-cli-cursor { animation: none; } }
      `}</style>

      {/* title bar */}
      <div className="flex items-center justify-between gap-2 border-white/10 border-b px-4 py-2.5 sm:px-5">
        <span className="inline-flex items-center gap-2 font-mono text-[11px] text-white/40 uppercase tracking-[0.08em]">
          <span aria-hidden="true" className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
          </span>
          create-hogsend
        </span>
        {reduceMotion ? null : (
          <button
            type="button"
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-[6px] border border-white/10 px-2.5 py-1 font-mono text-[11px] text-white/40 transition-colors hover:border-white/25 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d073dd]/70"
            onClick={replay}
          >
            ↺ replay
          </button>
        )}
      </div>

      {/* transcript */}
      <div
        ref={viewportRef}
        aria-hidden="true"
        className="h-[380px] overflow-y-auto px-4 py-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:h-[440px] sm:px-5"
        onScroll={() => {
          const viewport = viewportRef.current;
          if (!viewport) return;
          followRef.current =
            viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <
            48;
        }}
        style={{
          maskImage:
            "linear-gradient(to bottom, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)",
        }}
      >
        <div className="font-mono text-[11px] leading-[18px] tracking-[-0.01em] sm:text-[12.5px] sm:leading-[19px]">
          {transcript.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: transcript lines are positional
            <TerminalLine key={i} line={line} />
          ))}
        </div>
      </div>
    </div>
  );
}
