"use client";

import { type FocusEvent, useEffect, useState } from "react";
import {
  advancePromptFrame,
  holdPromptFrame,
  INITIAL_PROMPT_FRAME,
  movePromptFrame,
  PROMPT_SCENARIOS,
  type PromptFrame,
  submitPromptFrame,
} from "./agent-prompt-loop-state";

const TYPE_DELAY_MS = 24;
const READY_DELAY_MS = 900;
const SENDING_DELAY_MS = 650;

export function AgentPromptLoop({ engineVersion }: { engineVersion?: string }) {
  const [frame, setFrame] = useState(INITIAL_PROMPT_FRAME);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isFocusWithin, setIsFocusWithin] = useState(false);
  const [isInteractionSend, setIsInteractionSend] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const isHolding = isHovered || isFocusWithin;

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");

    const syncMotionPreference = () => {
      setReduceMotion(media.matches);
      setFrame(
        media.matches
          ? {
              ...INITIAL_PROMPT_FRAME,
              visibleCharacters: PROMPT_SCENARIOS[0].prompt.length,
              phase: "ready",
            }
          : INITIAL_PROMPT_FRAME,
      );
    };

    syncMotionPreference();
    media.addEventListener("change", syncMotionPreference);
    return () => media.removeEventListener("change", syncMotionPreference);
  }, []);

  useEffect(() => {
    const shouldCompleteInteractionSend =
      frame.phase === "sending" && isInteractionSend;
    if (reduceMotion || (isHolding && !shouldCompleteInteractionSend)) return;

    const delay =
      frame.phase === "typing"
        ? TYPE_DELAY_MS
        : frame.phase === "ready"
          ? READY_DELAY_MS
          : SENDING_DELAY_MS;
    const timeout = window.setTimeout(() => {
      setFrame((current) => {
        const nextFrame = advancePromptFrame(current);
        return current.phase === "sending" && isHolding
          ? holdPromptFrame(nextFrame)
          : nextFrame;
      });
      if (frame.phase === "sending") setIsInteractionSend(false);
    }, delay);

    return () => window.clearTimeout(timeout);
  }, [frame, isHolding, isInteractionSend, reduceMotion]);

  const scenario = PROMPT_SCENARIOS[frame.promptIndex];
  const visiblePrompt = scenario.prompt.slice(0, frame.visibleCharacters);
  const isTyping = frame.phase === "typing" && !isHolding;
  const isSending =
    frame.phase === "sending" && (!isHolding || isInteractionSend);

  const makeStaticIfNeeded = (nextFrame: PromptFrame): PromptFrame => {
    if (!reduceMotion && !isHolding) return nextFrame;

    return holdPromptFrame(nextFrame);
  };

  const movePrompt = (direction: -1 | 1) => {
    const nextFrame = makeStaticIfNeeded(movePromptFrame(frame, direction));
    setIsInteractionSend(false);
    setFrame(nextFrame);
    setAnnouncement(
      `${direction === 1 ? "Next" : "Previous"} prompt: ${PROMPT_SCENARIOS[nextFrame.promptIndex].prompt}`,
    );
  };

  const submitPrompt = () => {
    if (reduceMotion) {
      const nextFrame = makeStaticIfNeeded(movePromptFrame(frame, 1));
      setFrame(nextFrame);
      setAnnouncement(
        `Next prompt: ${PROMPT_SCENARIOS[nextFrame.promptIndex].prompt}`,
      );
      return;
    }

    setIsInteractionSend(true);
    setFrame(submitPromptFrame(frame));
    setAnnouncement("Prompt sent. Loading the next example.");
  };

  const holdCurrentPrompt = () => {
    setFrame((current) => holdPromptFrame(current, isInteractionSend));
  };

  const holdPromptOnHover = () => {
    setIsHovered(true);
    holdCurrentPrompt();
  };

  const holdPromptOnFocus = () => {
    setIsFocusWithin(true);
    holdCurrentPrompt();
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
      className="relative min-w-0 rounded-xl border border-white/15 bg-[#0a0606] p-4 shadow-lg transition-[border-color,box-shadow] duration-300 hover:border-[#23c489]/35 hover:shadow-[0_0_32px_rgba(35,196,137,0.12)] sm:p-5"
      data-prompt-id={scenario.id}
      data-prompt-phase={frame.phase}
      data-prompt-surface
      onBlurCapture={releasePromptOnBlur}
      onFocusCapture={holdPromptOnFocus}
      onMouseEnter={holdPromptOnHover}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-2 rounded-md border border-[#23c489]/25 bg-[#23c489]/10 px-2.5 py-1 font-mono text-[11px] text-[#23c489]">
          <span aria-hidden="true" className="size-2 shrink-0 bg-[#23c489]" />
          <span className="truncate">{scenario.file}</span>
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
      <p
        aria-hidden="true"
        className="mt-3 min-h-[100px] text-white/75 text-[15px] leading-[23px] tracking-[-0.02em] sm:min-h-[78px] sm:text-[17px] sm:leading-[26px]"
        data-animated-prompt
      >
        {visiblePrompt}
        <span
          className={`ml-0.5 inline-block h-[1.05em] w-px translate-y-[2px] bg-white/70 ${
            isTyping ? "animate-pulse" : "opacity-0"
          }`}
        />
      </p>

      <div className="mt-4 flex items-center justify-between">
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
        <button
          type="button"
          aria-label="Send prompt"
          className={`relative inline-flex size-8 cursor-pointer items-center justify-center rounded-full transition-[background-color,color,box-shadow,transform] hover:scale-105 hover:shadow-[0_0_18px_rgba(35,196,137,0.25)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#23c489]/70 ${
            isSending
              ? "bg-[#23c489]/20 text-[#23c489]"
              : "bg-white/10 text-white"
          }`}
          data-send-button
          onClick={submitPrompt}
        >
          {isSending ? (
            <span
              className="absolute inset-0 rounded-full bg-[#23c489]/40 animate-ping"
              data-send-ping
            />
          ) : null}
          <span className="relative">↑</span>
        </button>
      </div>
    </fieldset>
  );
}
