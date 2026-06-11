import type { JSX } from "react";
import { cn } from "@/lib/utils";

/** The Hogsend lockup — red tile, paper-plane glyph, wordmark. */
export function Logo({ className }: { className?: string }): JSX.Element {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <span
        aria-hidden="true"
        className="flex size-7 shrink-0 items-center justify-center rounded-[6px] bg-accent text-white"
      >
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
            stroke="#F64838"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <span className="font-display font-medium text-lg leading-none tracking-[-0.02em]">
        Hogsend
      </span>
    </span>
  );
}
