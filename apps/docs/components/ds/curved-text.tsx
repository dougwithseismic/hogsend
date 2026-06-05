import type { JSX } from "react";
import { cn } from "@/lib/cn";

type CurvedTextProps = {
  /** The string laid out around the ring. Repeats are up to the caller. */
  text: string;
  /** Circle radius in SVG user units (viewBox is 2*(radius+pad)). Default 120. */
  radius?: number;
  className?: string;
};

/** Stable, collision-safe id from the props (no Math.random → SSR-safe). */
function ringId(text: string, radius: number): string {
  let hash = 0;
  const seed = `${radius}:${text}`;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return `curved-text-${hash.toString(36)}`;
}

/**
 * Hero ring centerpiece: text laid along a circular SVG `<textPath>`, rotating
 * slowly. The whole ring counter-rotates via CSS so the text appears to drift
 * around the circle; `prefers-reduced-motion` halts it (the global reduced-
 * motion rule clamps the iteration count, and we also gate the animation here).
 */
export function CurvedText({
  text,
  radius = 120,
  className,
}: CurvedTextProps): JSX.Element {
  const pad = 16;
  const size = (radius + pad) * 2;
  const c = radius + pad;
  const id = ringId(text, radius);
  // Full circle path starting at the top, swept clockwise.
  const pathD = `M ${c},${c - radius} a ${radius},${radius} 0 1,1 -0.01,0`;

  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none inline-block select-none text-glow",
        className,
      )}
    >
      <style>{`
        @keyframes ${id}-spin { to { transform: rotate(360deg); } }
        .${id} { animation: ${id}-spin 36s linear infinite; transform-origin: 50% 50%; }
        @media (prefers-reduced-motion: reduce) {
          .${id} { animation: none; }
        }
      `}</style>
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className={cn(id, "block h-full w-full overflow-visible")}
      >
        <title>{text}</title>
        <defs>
          <path id={id} d={pathD} fill="none" />
        </defs>
        <text
          fill="currentColor"
          className="font-mono uppercase"
          style={{ fontSize: "0.8125rem", letterSpacing: "0.22em" }}
        >
          <textPath href={`#${id}`} startOffset="0">
            {text}
          </textPath>
        </text>
      </svg>
    </span>
  );
}
