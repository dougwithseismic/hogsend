"use client";

import { useAnimationFrame, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

/**
 * Looping web frame clock — the native replacement for Remotion's
 * useCurrentFrame() / useVideoConfig(). Drives a 0…total-1 frame counter at
 * `fps`, looping forever, and is gated to only advance while the clip is
 * on-screen (perf: off-screen clips burn no frames). Attach the returned
 * `ref` to the clip's root element.
 */
export function useLoopFrame(total: number, fps = 30) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.3 });
  const [frame, setFrame] = useState(0);
  const startRef = useRef<number | null>(null);
  useAnimationFrame((t) => {
    if (!inView) {
      startRef.current = null;
      return;
    }
    if (startRef.current === null) startRef.current = t;
    const next = Math.floor(((t - startRef.current) / 1000) * fps) % total;
    setFrame((prev) => (prev === next ? prev : next));
  });
  return { ref, frame };
}

/**
 * One-shot web frame clock — the on-demand sibling of `useLoopFrame`. Instead
 * of looping, it sits SETTLED on the final frame (so an idle clip reads as a
 * finished run inviting a replay) and plays the run from the top exactly once
 * each time `playToken` changes — i.e. each time the visitor fires an event in
 * the live home demo. When it reaches the end it clamps on the last frame and
 * stops burning rAF ticks. Honours `prefers-reduced-motion` by jumping straight
 * to the settled frame.
 */
export function useShotFrame(total: number, fps = 30, playToken = 0) {
  const ref = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState(total - 1);
  const startRef = useRef<number | null>(null);
  const prevToken = useRef(playToken);
  const playing = useRef(false);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (playToken === prevToken.current) return;
    prevToken.current = playToken;
    if (reduce) {
      setFrame(total - 1);
      return;
    }
    startRef.current = null;
    playing.current = true;
    setFrame(0);
  }, [playToken, total, reduce]);

  useAnimationFrame((t) => {
    if (!playing.current) return;
    if (startRef.current === null) startRef.current = t;
    const next = Math.floor(((t - startRef.current) / 1000) * fps);
    if (next >= total - 1) {
      playing.current = false;
      setFrame(total - 1);
      return;
    }
    setFrame((prev) => (prev === next ? prev : next));
  });

  return { ref, frame };
}
