import type { JSX } from "react";
import { cn } from "@/lib/cn";
import { exactTime, formatRelativeTime } from "@/src/lib/relative-time";

/**
 * A timestamp, coarse on the page and exact on hover.
 *
 * `<time dateTime>` carries the machine-readable instant for anything parsing
 * the page, and `title` carries it for a human — so nothing on this dashboard
 * shows an age without the moment it was measured from being recoverable.
 */
export function TimeAgo({
  at,
  now,
  className,
}: {
  at: Date;
  /** The clock, injectable so a render is deterministic in a test. */
  now?: Date;
  className?: string;
}): JSX.Element {
  const iso = exactTime(at);
  return (
    <time dateTime={iso} title={iso} className={cn(className)}>
      {formatRelativeTime(at, now)}
    </time>
  );
}
