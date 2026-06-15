"use client";

import { useAnimationFrame, useInView } from "motion/react";
import { useRef, useState } from "react";

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
