import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type Stat = {
  value: string;
  caption: string;
};

type StatBandProps = {
  /** Short framing copy for the left column (a sentence or two). */
  label: ReactNode;
  /** Big numerals + eyebrow captions; captions must be unique (React keys). */
  stats: Stat[];
  className?: string;
};

/**
 * Crimzon stats band: a short label on the left, a row of big display
 * numerals on the right, each cell after the first separated by a vertical
 * white/10 hairline. On mobile the row stacks and the separators drop away.
 * Server component — content only.
 */
export function StatBand({ label, stats, className }: StatBandProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-10 lg:flex-row lg:items-center lg:justify-between",
        className,
      )}
    >
      <div className="max-w-[300px] text-base text-white/80 leading-6">
        {label}
      </div>

      <div className="flex flex-col gap-8 sm:flex-row sm:gap-0">
        {stats.map((stat, index) => (
          <div
            key={stat.caption}
            className={cn(
              "flex flex-col gap-3 sm:px-10 first:sm:pl-0 last:sm:pr-0",
              index > 0 && "sm:border-white/10 sm:border-l",
            )}
          >
            <span className="font-display text-[44px] text-white leading-none tracking-[-0.02em] md:text-[56px]">
              {stat.value}
            </span>
            <span className="eyebrow text-white/50">{stat.caption}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
