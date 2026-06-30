import type { JSX } from "react";
import { cn } from "@/lib/cn";

/**
 * Hogsend brand lockup for the course site: an accent-red rounded tile holding a
 * minimal white "send" glyph, the "Hogsend" wordmark, and a lighter "Courses"
 * sub-label. Ported from the docs site's Logo.
 */
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
      <span className="font-display font-semibold text-lg leading-none tracking-tight">
        Hogsend <span className="font-normal text-white/40">Courses</span>
      </span>
    </span>
  );
}
