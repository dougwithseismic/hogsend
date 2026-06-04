import type { JSX } from "react";
import { cn } from "@/lib/cn";

/**
 * Hogsend brand lockup: an accent-green rounded tile holding a minimal black
 * "send/spark" glyph, followed by the "Hogsend" wordmark. Echoes AgentFlow's
 * green-tile + wordmark logo.
 */
export function Logo({ className }: { className?: string }): JSX.Element {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <span
        aria-hidden="true"
        className="flex size-7 shrink-0 items-center justify-center rounded-[6px] bg-accent text-black"
      >
        {/* Minimal "send" glyph (paper-plane / spark) in black */}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          className="size-4"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M3.5 12 20 4.5 14 20l-3.2-6.4L3.5 12Z" fill="currentColor" />
          <path
            d="m10.8 13.2 6.4-7.4"
            stroke="#9FF690"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <span className="font-display text-lg leading-none font-semibold tracking-tight">
        Hogsend
      </span>
    </span>
  );
}
