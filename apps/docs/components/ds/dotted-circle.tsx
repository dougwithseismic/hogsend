import type { JSX } from "react";
import { cn } from "@/lib/cn";

type DottedCircleProps = {
  className?: string;
};

/**
 * Dotted circular stroke — the loop motif behind the hero ring and the final
 * CTA. Inline SVG, `currentColor` stroke (amber by default via `text-glow`),
 * `stroke-dasharray` for the dotted look. Decorative.
 */
export function DottedCircle({ className }: DottedCircleProps): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 200 200"
      className={cn("inline-block size-40 text-glow", className)}
    >
      <circle
        cx={100}
        cy={100}
        r={92}
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeDasharray="2 12"
      />
    </svg>
  );
}
