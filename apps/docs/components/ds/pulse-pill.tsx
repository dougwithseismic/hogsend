import type { JSX, ReactNode } from "react";
import { cn } from "@/lib/cn";

type PulsePillProps = {
  /** Pill label. Defaults to Hogsend's "event → send" chip. */
  children?: ReactNode;
  className?: string;
};

/**
 * Small bordered rounded-full pill with a tiny animated indicator dot —
 * Hogsend's analog to Wispr's waveform pill. The pulsing ring is driven by
 * `animate-ping`; the global `prefers-reduced-motion` rule halts it. Default
 * content is a mono "event → send" chip.
 */
export function PulsePill({
  children,
  className,
}: PulsePillProps): JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full border-2 border-ink bg-paper px-4 py-1.5 font-mono text-[0.75rem] text-ink",
        className,
      )}
    >
      <span aria-hidden="true" className="relative flex size-2 shrink-0">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-glow opacity-75" />
        <span className="relative inline-flex size-2 rounded-full bg-glow" />
      </span>
      <span>{children ?? "event → send"}</span>
    </span>
  );
}
