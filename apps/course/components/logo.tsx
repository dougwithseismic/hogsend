import type { JSX } from "react";
import { cn } from "@/lib/cn";

/**
 * Hogsend brand lockup for the course site: an accent-red rounded tile holding
 * the boar mark, the "Hogsend" wordmark, and a lighter "Courses" sub-label.
 * Ported from the docs site's Logo. The boar ships as a single-color SVG in
 * `public/images/logos/hogsend-boar.svg` and is painted via CSS mask so it
 * inherits `currentColor` (white on the accent tile).
 */
export function Logo({ className }: { className?: string }): JSX.Element {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <span
        aria-hidden="true"
        className="flex size-7 shrink-0 items-center justify-center rounded-[6px] bg-accent text-white"
      >
        <span
          className="block h-[13px] w-[22px] bg-current"
          style={{
            WebkitMaskImage: "url(/images/logos/hogsend-boar.svg)",
            maskImage: "url(/images/logos/hogsend-boar.svg)",
            WebkitMaskRepeat: "no-repeat",
            maskRepeat: "no-repeat",
            WebkitMaskPosition: "center",
            maskPosition: "center",
            WebkitMaskSize: "contain",
            maskSize: "contain",
          }}
        />
      </span>
      <span className="font-display font-semibold text-lg leading-none tracking-tight">
        Hogsend <span className="font-normal text-white/40">Courses</span>
      </span>
    </span>
  );
}
