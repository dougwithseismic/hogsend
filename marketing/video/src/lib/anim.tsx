import type React from "react";
import type { ReactNode } from "react";
import { interpolate, Sequence, spring } from "remotion";

/**
 * Motion language: hard cuts and spring pops, never crossfades.
 * All springs use high damping (~200) for clean, non-wobbly motion.
 */

export const SPRING_SNAPPY = { damping: 200, mass: 0.6 } as const;
export const SPRING_POP = { damping: 200, mass: 0.4 } as const;

/** 0→1 spring progress for an element popping in. */
export const pop = (frame: number, fps: number, delay = 0): number =>
  spring({
    frame: frame - delay,
    fps,
    config: SPRING_POP,
    durationInFrames: 14,
  });

/**
 * Beat-change punch-in: scale 1.04→1.00 over the first few frames of a
 * beat. Apply to the beat's root element via `transform: scale(...)`.
 */
export const punchIn = (frame: number, fps: number): number => {
  const p = spring({
    frame,
    fps,
    config: SPRING_SNAPPY,
    durationInFrames: 8,
  });
  return interpolate(p, [0, 1], [1.04, 1]);
};

/** Spring-driven slide-up; returns { opacity, translateY } in px. */
export const slideUp = (
  frame: number,
  fps: number,
  delay = 0,
  distance = 28,
): { opacity: number; translateY: number } => {
  const p = pop(frame, fps, delay);
  return {
    opacity: p,
    translateY: interpolate(p, [0, 1], [distance, 0]),
  };
};

/**
 * Word-by-word stagger (default 3 frames apart) for KineticText-style
 * reveals. Returns spring progress 0→1 for word index `i`.
 */
export const staggerWords = (
  frame: number,
  fps: number,
  i: number,
  stagger = 3,
): number => pop(frame, fps, i * stagger);

/**
 * Micro-drift for holds: nothing sits fully static longer than ~75
 * frames. Returns a scale 1.00→1.02 across `holdFrames`.
 */
export const microDrift = (frame: number, holdFrames = 75): number =>
  interpolate(frame, [0, holdFrames], [1, 1.02], {
    extrapolateLeft: "clamp",
    extrapolateRight: "extend",
  });

// ---------------------------------------------------------------------------
// Beat system — author a video as a list of timed beats (45–75 frames each;
// end cards hold ~60). Each beat becomes a hard-cut <Sequence>.
// ---------------------------------------------------------------------------

export type Beat = {
  id: string;
  /** Beat length in frames. Keep within 45–75 for content beats. */
  frames: number;
  render: () => ReactNode;
};

export const beat = (
  id: string,
  frames: number,
  render: () => ReactNode,
): Beat => ({ id, frames, render });

export const totalFrames = (beats: Beat[]): number =>
  beats.reduce((sum, b) => sum + b.frames, 0);

/** Renders beats back-to-back as hard-cut Sequences. */
export const Beats: React.FC<{ beats: Beat[] }> = ({ beats }) => {
  let offset = 0;
  return (
    <>
      {beats.map((b) => {
        const from = offset;
        offset += b.frames;
        return (
          <Sequence
            key={b.id}
            name={b.id}
            from={from}
            durationInFrames={b.frames}
          >
            {b.render()}
          </Sequence>
        );
      })}
    </>
  );
};
