import { cn } from "@/lib/cn";

/**
 * Thin rounded progress bar (track + fill). Purely visual — pair it with a
 * text count for accessibility. Defaults to the teal "good" fill; override
 * via barClassName (e.g. "bg-accent") where a different accent is wanted.
 */
export function ProgressBar({
  value,
  max,
  className,
  barClassName,
}: {
  value: number;
  max: number;
  className?: string;
  barClassName?: string;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div
      aria-hidden
      className={cn(
        "h-1 overflow-hidden rounded-full bg-white/[0.06]",
        className,
      )}
    >
      <div
        className={cn(
          "h-full rounded-full bg-good transition-[width] duration-500",
          barClassName,
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
