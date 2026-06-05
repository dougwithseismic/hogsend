import type { JSX } from "react";
import { cn } from "@/lib/cn";

/**
 * Hand-drawn amber doodle accents used to punctuate the light-serif headings —
 * Hogsend's homage to the Wispr Flow marker scribbles. Each is a small inline
 * SVG that strokes in `currentColor` and defaults to amber via `text-glow`, so
 * callers can recolor with any `text-*` utility. All are decorative.
 */

type DoodleProps = {
  className?: string;
};

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/**
 * Radiating ticks — the burst Wispr places over an "I"/"AI". Sits above or
 * beside a word as a little spark.
 */
export function Sunburst({ className }: DoodleProps): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 48 48"
      className={cn("inline-block size-6 text-glow", className)}
    >
      <g {...STROKE} strokeWidth={2.6}>
        <path d="M24 6v8" />
        <path d="M24 34v8" />
        <path d="M6 24h8" />
        <path d="M34 24h8" />
        <path d="M11 11l5 5" />
        <path d="M32 32l5 5" />
        <path d="M37 11l-5 5" />
        <path d="M16 32l-5 5" />
      </g>
    </svg>
  );
}

/**
 * Wavy underline scribble — drop under a word to "hand-highlight" it.
 */
export function Squiggle({ className }: DoodleProps): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 120 16"
      className={cn("inline-block h-4 w-[7.5rem] text-glow", className)}
      preserveAspectRatio="none"
    >
      <path
        {...STROKE}
        strokeWidth={3}
        d="M2 10C12 2 22 2 32 10S52 18 62 10 82 2 92 10s20 8 26 0"
      />
    </svg>
  );
}

/**
 * Looping arrow — a curved sweep ending in an arrowhead, for pointing from one
 * idea to the next.
 */
export function LoopArrow({ className }: DoodleProps): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 64 48"
      className={cn("inline-block size-12 text-glow", className)}
    >
      <g {...STROKE} strokeWidth={2.6}>
        <path d="M6 14c10-12 30-12 40 0 6 7 4 18-6 20-7 1-11-5-7-10 3-4 9-2 9 3" />
        <path d="M44 27l-2 9 9-3" />
      </g>
    </svg>
  );
}

/**
 * Four-point sparkle star — a tiny accent beside an eyebrow or feature title.
 */
export function Star({ className }: DoodleProps): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 32 32"
      className={cn("inline-block size-5 text-glow", className)}
    >
      <path
        {...STROKE}
        strokeWidth={2.4}
        d="M16 3c1 7 5 11 12 13-7 2-11 6-12 13-1-7-5-11-12-13 7-2 11-6 12-13Z"
      />
    </svg>
  );
}
