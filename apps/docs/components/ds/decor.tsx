import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/cn";

type Tone = "dark" | "light";

type BarcodeStripProps = {
  className?: string;
  bars?: number;
};

/**
 * Retired "comb"/barcode motif. Kept as an exported no-op so existing call
 * sites (e.g. mockup.tsx) keep compiling; the Wispr Flow system drops it.
 */
export function BarcodeStrip(_props: BarcodeStripProps): null {
  return null;
}

type DottedArrowProps = {
  tone?: Tone;
  className?: string;
};

/**
 * Small "go" affordance: a soft rounded square with a → glyph. Used top-right
 * on testimonial/feature cards. Decorative on its own — wrap it in an
 * interactive element when used as an action.
 */
export function DottedArrow({ tone = "dark", className }: DottedArrowProps) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-full border",
        tone === "light"
          ? "border-ink/15 text-ink"
          : "border-lumen/25 text-lumen",
        className,
      )}
    >
      <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
    </span>
  );
}

type WordmarkProps = {
  text?: string;
  className?: string;
};

/**
 * Giant footer wordmark — Hogsend's analog to Wispr's huge "Flow". A small bar
 * mark sits ahead of an oversized light-serif "Hogsend". Decorative.
 */
export function Wordmark({ text = "Hogsend", className }: WordmarkProps) {
  // Show the wordmark in normal case regardless of the legacy "HOGSEND" prop.
  const label =
    text.length > 1
      ? text.charAt(0).toUpperCase() + text.slice(1).toLowerCase()
      : text;

  return (
    <span
      aria-hidden
      className={cn(
        "flex select-none items-center justify-center gap-[0.18em] leading-none text-ink",
        className,
      )}
    >
      <span className="flex shrink-0 items-end gap-[0.12em]">
        <span className="block h-[0.62em] w-[0.16em] rounded-full bg-glow" />
        <span className="block h-[0.92em] w-[0.16em] rounded-full bg-ink" />
        <span className="block h-[0.44em] w-[0.16em] rounded-full bg-fathom" />
      </span>
      <span className="font-display text-[clamp(4rem,18vw,14rem)] tracking-tight">
        {label}
      </span>
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
 * Stat block: a large light-serif number over a small mono caption label.
 */
export function Stat({ value, label, tone = "dark", className }: StatProps) {
  const onCream = tone === "light";
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <span
        className={cn(
          "font-display text-4xl leading-[1.1] tracking-tight md:text-5xl",
          onCream ? "text-ink" : "text-lumen",
        )}
      >
        {value}
      </span>
      <span
        className={cn("eyebrow", onCream ? "text-ink/50" : "text-lumen/50")}
      >
        {label}
      </span>
    </div>
  );
}
