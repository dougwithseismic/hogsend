import type { JSX } from "react";
import { cn } from "@/lib/cn";

/**
 * One metered quantity against its plan cap, as a horizontal bar.
 *
 * Plain divs and a percentage width — no chart library, and none warranted: a
 * bar is a rectangle, and a dependency that draws rectangles would ship a
 * runtime, a colour system and a client boundary into a page that is otherwise
 * entirely server-rendered.
 *
 * The fill is CLAMPED to the track but the number beside it is not: a tenant
 * 3x over their cap sees a full bar and reads the real figure. Rounding the
 * number down to the cap would be the one thing a usage meter must never do.
 */

const format = new Intl.NumberFormat("en-US");

type UsageMeterProps = {
  label: string;
  used: number;
  limit: number;
  className?: string;
};

export function UsageMeter({
  label,
  used,
  limit,
  className,
}: UsageMeterProps): JSX.Element {
  const over = used > limit;
  // A zero cap would divide by zero; it is not a plan that exists, but a page
  // must not depend on that.
  const ratio = limit > 0 ? used / limit : 0;
  const width = Math.min(100, Math.max(ratio * 100, used > 0 ? 1 : 0));

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-sm text-white/80 tracking-[-0.02em]">
          {label}
        </span>
        <span className="text-sm text-white/60 tabular-nums">
          {format.format(used)} / {format.format(limit)}
        </span>
      </div>
      <div
        aria-hidden
        className="h-1.5 w-full overflow-hidden rounded-[3px] bg-white/[0.08]"
      >
        <div
          className={cn(
            "h-full rounded-[3px]",
            over ? "bg-caution" : "bg-white/70",
          )}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

/** The same number formatting, for prose beside a meter. */
export function formatCount(value: number): string {
  return format.format(value);
}
