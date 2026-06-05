import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/cn";

type Tone = "dark" | "light";

/**
 * Fixed pseudo-random bar-height pattern (percentages of the strip height).
 * Deterministic: the height for bar `i` is read from this ring of values,
 * lightly perturbed by `i` so adjacent bars differ. NEVER use Math.random —
 * the pattern must be identical on server and client to avoid hydration drift.
 */
const BARCODE_PATTERN = [
  42, 88, 30, 66, 100, 24, 54, 78, 38, 92, 48, 70, 28, 60, 84, 36, 96, 44, 72,
  52, 80, 34, 64, 90,
];

function barHeight(index: number): number {
  const base = BARCODE_PATTERN[index % BARCODE_PATTERN.length];
  // Deterministic perturbation so longer rows don't simply repeat the ring.
  const drift = ((index * 37) % 23) - 11;
  return Math.min(100, Math.max(18, base + drift));
}

type BarcodeStripProps = {
  className?: string;
  bars?: number;
};

/**
 * Row of thin vertical accent bars of varying height — the "comb" motif that
 * runs along the top/bottom edge of mockups. Heights are deterministic.
 */
export function BarcodeStrip({ className, bars = 32 }: BarcodeStripProps) {
  // Build a list of bars with stable, content-derived unique ids. A running
  // prefix sum keeps the id unique even when two bars share the same height,
  // and never references the array index directly.
  let prefix = 0;
  const items = Array.from({ length: bars }, (_, i) => {
    const height = barHeight(i);
    prefix += height;
    return { id: `bar-${prefix}-${height}`, height };
  });

  return (
    <div
      aria-hidden
      className={cn(
        "flex h-8 w-full items-end gap-[3px] overflow-hidden",
        className,
      )}
    >
      {items.map((bar) => (
        <span
          key={bar.id}
          className="w-px flex-1 rounded-[1px] bg-accent"
          style={{ height: `${bar.height}%` }}
        />
      ))}
    </div>
  );
}

type DottedArrowProps = {
  tone?: Tone;
  className?: string;
};

/**
 * Small square "go" affordance with a dashed border and a → arrow glyph.
 * Recurs on testimonial/blog/stat cards. Decorative on its own; wrap it in an
 * interactive element when used as an action.
 */
export function DottedArrow({ tone = "dark", className }: DottedArrowProps) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-md border border-dashed",
        tone === "light"
          ? "border-black/25 text-black"
          : "border-white/25 text-white",
        className,
      )}
    >
      <ArrowRight className="h-4 w-4" strokeWidth={1.5} />
    </span>
  );
}

type WordmarkProps = {
  text?: string;
  className?: string;
};

/**
 * Giant faint outline watermark (e.g. "HOGSEND") for the footer. Transparent
 * fill with a hairline text stroke so it reads as a ghosted etch. Decorative.
 */
export function Wordmark({ text = "HOGSEND", className }: WordmarkProps) {
  return (
    <span
      aria-hidden
      className={cn(
        "block select-none font-display leading-none text-transparent",
        "text-[18vw] tracking-tight [-webkit-text-stroke:1px_rgba(255,255,255,0.06)]",
        className,
      )}
    >
      {text}
    </span>
  );
}

type StatProps = {
  value: string;
  label: string;
  tone?: Tone;
  className?: string;
};

/**
 * Stat block: a large display number over a small mono caption label.
 */
export function Stat({ value, label, tone = "dark", className }: StatProps) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <span
        className={cn(
          "font-display text-4xl leading-[1.1] md:text-5xl",
          tone === "light" ? "text-black" : "text-white",
        )}
      >
        {value}
      </span>
      <span
        className={cn(
          "eyebrow",
          tone === "light" ? "text-black/50" : "text-white/50",
        )}
      >
        {label}
      </span>
    </div>
  );
}
