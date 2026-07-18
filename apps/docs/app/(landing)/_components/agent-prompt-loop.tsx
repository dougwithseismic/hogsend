"use client";

import { type FocusEvent, useEffect, useRef, useState } from "react";
import {
  advancePromptFrame,
  completePromptFrame,
  INITIAL_PROMPT_FRAME,
  movePromptFrame,
  type OutputLine,
  PROMPT_SCENARIOS,
} from "./agent-prompt-loop-state";

const TYPE_DELAY_MS = 10;
const LINE_DELAY_MS = 380;
const RUN_START_DELAY_MS = 420;
const DONE_DELAY_MS = 2200;
const HISTORY_LIMIT = 2;

function OutputRow({ line }: { line: OutputLine }) {
  const glyph = line.kind === "write" ? "+" : line.kind === "ok" ? "✓" : "●";
  const glyphColor = line.kind === "info" ? "text-white/30" : "text-[#23c489]";
  const textColor =
    line.kind === "write"
      ? "text-[#23c489]"
      : line.kind === "ok"
        ? "text-white/70"
        : "text-white/45";

  return (
    <p className="hs-line-in flex gap-2 pl-4">
      <span className={`shrink-0 ${glyphColor}`}>{glyph}</span>
      <span className={`min-w-0 ${textColor}`}>{line.text}</span>
    </p>
  );
}

/** One agent session in the feed: the typed prompt plus its output so far. */
function SessionBlock({
  promptIndex,
  visibleCharacters,
  visibleLines,
  showCursor,
}: {
  promptIndex: number;
  visibleCharacters: number;
  visibleLines: number;
  showCursor: boolean;
}) {
  const scenario = PROMPT_SCENARIOS[promptIndex];

  return (
    <div className="space-y-[6px]">
      <p className="flex gap-2">
        <span className="shrink-0 text-[#f64838]">❯</span>
        <span className="min-w-0 text-white/85">
          {scenario.prompt.slice(0, visibleCharacters)}
          {showCursor && (
            <span className="ml-0.5 inline-block h-[1.1em] w-[6px] translate-y-[2px] animate-pulse bg-white/70" />
          )}
        </span>
      </p>
      {scenario.output.slice(0, visibleLines).map((line) => (
        <OutputRow key={line.text} line={line} />
      ))}
    </div>
  );
}

export function AgentPromptLoop({ engineVersion }: { engineVersion?: string }) {
  const [frame, setFrame] = useState(INITIAL_PROMPT_FRAME);
  const [history, setHistory] = useState<number[]>([]);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isFocusWithin, setIsFocusWithin] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const viewportRef = useRef<HTMLDivElement>(null);
  const isHolding = isHovered || isFocusWithin;

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");

    const syncMotionPreference = () => {
      setReduceMotion(media.matches);
      setHistory([]);
      setFrame(
        media.matches
          ? completePromptFrame(INITIAL_PROMPT_FRAME)
          : INITIAL_PROMPT_FRAME,
      );
    };

    syncMotionPreference();
    media.addEventListener("change", syncMotionPreference);
    return () => media.removeEventListener("change", syncMotionPreference);
  }, []);

  // The replay clock. Hovering or focusing freezes the feed in place.
  useEffect(() => {
    if (reduceMotion || isHolding) return;

    const delay =
      frame.phase === "typing"
        ? frame.visibleCharacters ===
          PROMPT_SCENARIOS[frame.promptIndex].prompt.length
          ? RUN_START_DELAY_MS
          : TYPE_DELAY_MS
        : frame.phase === "running"
          ? LINE_DELAY_MS
          : DONE_DELAY_MS;
    const timeout = window.setTimeout(() => {
      // A finished session joins the scrollback before the next one types.
      if (frame.phase === "done") {
        setHistory((log) => [...log, frame.promptIndex].slice(-HISTORY_LIMIT));
      }
      setFrame(advancePromptFrame(frame));
    }, delay);

    return () => window.clearTimeout(timeout);
  }, [frame, isHolding, reduceMotion]);

  // Follow the feed: every new character/line smooth-scrolls to the bottom.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: reduceMotion || frame.phase === "typing" ? "instant" : "smooth",
    });
  }, [frame, reduceMotion]);

  const scenario = PROMPT_SCENARIOS[frame.promptIndex];

  const movePrompt = (direction: -1 | 1) => {
    const nextFrame = movePromptFrame(frame, direction);
    setFrame(reduceMotion ? completePromptFrame(nextFrame) : nextFrame);
    setAnnouncement(
      `${direction === 1 ? "Next" : "Previous"} prompt: ${PROMPT_SCENARIOS[nextFrame.promptIndex].prompt}`,
    );
  };

  const releasePromptOnBlur = (event: FocusEvent<HTMLFieldSetElement>) => {
    const nextTarget = event.relatedTarget;
    if (
      !(nextTarget instanceof Node) ||
      !event.currentTarget.contains(nextTarget)
    ) {
      setIsFocusWithin(false);
    }
  };

  return (
    <fieldset
      aria-label="Lifecycle prompt examples"
      className="relative min-w-0 overflow-hidden rounded-xl border border-white/15 bg-[#0a0606] shadow-lg transition-[border-color,box-shadow] duration-300 hover:border-[#23c489]/35 hover:shadow-[0_0_32px_rgba(35,196,137,0.12)]"
      data-prompt-id={scenario.id}
      data-prompt-phase={frame.phase}
      data-prompt-surface
      onBlurCapture={releasePromptOnBlur}
      onFocusCapture={() => setIsFocusWithin(true)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <style>{`
        @keyframes hs-line-in {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .hs-line-in { animation: hs-line-in 220ms ease-out; }
        @media (prefers-reduced-motion: reduce) {
          .hs-line-in { animation: none; }
        }
      `}</style>

      {/* title bar — a CLI session replay, not a chat input */}
      <div className="flex items-center justify-between gap-2 border-white/10 border-b px-4 py-2.5 sm:px-5">
        <span className="inline-flex items-center gap-2 font-mono text-[11px] text-white/40 uppercase tracking-[0.08em]">
          <span
            aria-hidden="true"
            className="block h-[9px] w-[15px] bg-[#f64838]"
            style={{
              WebkitMaskImage: "url(/images/logos/hogsend-boar.svg)",
              maskImage: "url(/images/logos/hogsend-boar.svg)",
              WebkitMaskRepeat: "no-repeat",
              maskRepeat: "no-repeat",
              WebkitMaskPosition: "center",
              maskPosition: "center",
              WebkitMaskSize: "contain",
              maskSize: "contain",
            }}
          />
          CLI
        </span>
        {engineVersion ? (
          <span
            className="shrink-0 font-mono text-[11px] text-white/35"
            title="Latest @hogsend/engine on npm"
          >
            engine <span className="text-white/60">v{engineVersion}</span>
          </span>
        ) : null}
      </div>

      <span className="sr-only">{scenario.prompt}</span>
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>

      {/* terminal feed — sessions accumulate and the view follows the tail.
          The top/bottom edges fade via a mask on the scrollport itself, not a
          coloured overlay — so scrolled content dissolves into whatever sits
          behind the box (the opaque classic shell or the translucent day-field
          glass) regardless of the text colour underneath. */}
      <div className="relative">
        <div
          ref={viewportRef}
          aria-hidden="true"
          className="h-[148px] overflow-y-auto px-4 py-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:px-5"
          data-animated-prompt
          style={{
            maskImage:
              "linear-gradient(to bottom, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)",
            WebkitMaskImage:
              "linear-gradient(to bottom, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)",
          }}
        >
          <div className="flex flex-col gap-[16px] font-mono text-[12px] leading-[19px] tracking-[-0.01em] sm:text-[12.5px]">
            {history.map((sessionIndex, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: scrollback entries are positional
                key={`${sessionIndex}-${i}`}
                className="opacity-40"
              >
                <SessionBlock
                  promptIndex={sessionIndex}
                  visibleCharacters={
                    PROMPT_SCENARIOS[sessionIndex].prompt.length
                  }
                  visibleLines={PROMPT_SCENARIOS[sessionIndex].output.length}
                  showCursor={false}
                />
              </div>
            ))}
            <SessionBlock
              promptIndex={frame.promptIndex}
              visibleCharacters={frame.visibleCharacters}
              visibleLines={frame.visibleLines}
              showCursor={frame.phase === "typing"}
            />
          </div>
        </div>
      </div>

      {/* controls */}
      <div className="flex items-center justify-between border-white/10 border-t px-4 py-2.5 sm:px-5">
        <div className="flex items-center gap-2 text-white/40">
          <button
            type="button"
            aria-label="Previous prompt"
            className="inline-flex size-7 cursor-pointer items-center justify-center rounded-[6px] border border-white/10 font-mono text-[13px] transition-colors hover:border-white/25 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#23c489]/70"
            data-prompt-previous
            onClick={() => movePrompt(-1)}
          >
            ←
          </button>
          <button
            type="button"
            aria-label="Next prompt"
            className="inline-flex size-7 cursor-pointer items-center justify-center rounded-[6px] border border-white/10 font-mono text-[13px] transition-colors hover:border-white/25 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#23c489]/70"
            data-prompt-next
            onClick={() => movePrompt(1)}
          >
            →
          </button>
        </div>
        <span className="flex items-center gap-1.5" aria-hidden="true">
          {PROMPT_SCENARIOS.map((s, i) => (
            <span
              key={s.id}
              className={`size-[4px] rounded-full transition-colors duration-300 ${
                i === frame.promptIndex ? "bg-white/70" : "bg-white/15"
              }`}
            />
          ))}
        </span>
      </div>
    </fieldset>
  );
}
