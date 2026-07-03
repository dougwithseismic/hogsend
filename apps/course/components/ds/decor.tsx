import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/cn";

type Tone = "dark" | "light";

type BarcodeStripProps = {
  className?: string;
  /** Legacy prop — the barcode motif is retired; accepted and ignored. */
  bars?: number;
};

/**
 * Legacy "comb" motif — retired in the crimzon redesign. Renders a single
 * faint hairline rule so existing call sites keep a quiet divider.
 */
export function BarcodeStrip({ className }: BarcodeStripProps) {
  return (
    <div aria-hidden className={cn("h-px w-full bg-white/[0.08]", className)} />
  );
}

type DottedArrowProps = {
  /** Accepted for compatibility — every tone renders the dark crimzon style. */
  tone?: Tone;
  className?: string;
};

/**
 * Small square "go" affordance: hairline border + → arrow glyph. Decorative
 * on its own; wrap it in an interactive element when used as an action.
 */
export function DottedArrow({ tone: _tone, className }: DottedArrowProps) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-md border border-white/15 text-white",
        className,
      )}
    >
      <ArrowRight className="h-4 w-4" strokeWidth={1.5} />
    </span>
  );
}

type WaveLinesProps = {
  className?: string;
  /** Stroke color for the contour lines (defaults to a warm crimzon rim). */
  stroke?: string;
  /** How many fanned lines to draw. */
  count?: number;
};

/**
 * Fanned contour lines with a slow dash-drift — an abstract horizon layer for
 * the hero glow canvas, drawn in code so it stays on-palette. The `.hs-dash`
 * drift (and its reduced-motion neutralise) live in app/global.css.
 */
export function WaveLines({
  className,
  stroke = "rgba(255, 150, 128, 0.45)",
  count = 8,
}: WaveLinesProps) {
  const paths = Array.from({ length: count }, (_, i) => {
    const y = 16 + i * 26;
    const lift = 24 + ((i * 13) % 26);
    return `M-20 ${y} C 180 ${y - lift}, 380 ${y + lift}, 620 ${y - lift / 2} S 980 ${y + lift}, 1240 ${y - lift}`;
  });
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 1200 200"
      fill="none"
      preserveAspectRatio="none"
      className={cn("pointer-events-none", className)}
    >
      {paths.map((d, i) => (
        <path
          // biome-ignore lint/suspicious/noArrayIndexKey: static deterministic art
          key={i}
          d={d}
          stroke={stroke}
          strokeWidth="1"
          strokeOpacity={0.3 + (i % 4) * 0.16}
          className="hs-dash"
          style={{ animationDelay: `${i * -3.5}s` }}
        />
      ))}
    </svg>
  );
}

type WordmarkProps = {
  text?: string;
  className?: string;
};

/**
 * Legacy giant outline footer watermark — retired in the crimzon redesign
 * (the footer is slim now). Kept as a no-op so call sites keep compiling.
 */
export function Wordmark(_props: WordmarkProps) {
  return null;
}

type StatProps = {
  value: string;
  label: string;
  /** Accepted for compatibility — every tone renders the dark crimzon style. */
  tone?: Tone;
  className?: string;
};

/**
 * Stat block: 40px Inter number over a 12px uppercase white/50 caption.
 */
export function Stat({ value, label, tone: _tone, className }: StatProps) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <span className="font-sans text-[40px] text-white leading-[48px] tracking-[-0.02em]">
        {value}
      </span>
      <span className="eyebrow text-white/50">{label}</span>
    </div>
  );
}
