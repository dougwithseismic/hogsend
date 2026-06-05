import type { JSX, ReactNode } from "react";
import { cn } from "@/lib/cn";

type Tone = "dark" | "light";

type EyebrowProps = {
  children: ReactNode;
  /** `light` = on cream (ink text, amber square); `dark` = on a panel. */
  tone?: Tone;
  className?: string;
};

/**
 * Mono uppercase micro-label preceded by a small colored square — amber on
 * cream, lavender on a dark/teal panel. No pill, no border; it reads as a bare
 * editorial kicker (Wispr style).
 */
export function Eyebrow({
  children,
  tone = "dark",
  className,
}: EyebrowProps): JSX.Element {
  // `tone="light"` means the eyebrow lives on the cream canvas.
  const onCream = tone === "light";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-2",
        onCream ? "text-ink/70" : "text-lumen/70",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-[7px] shrink-0 rounded-[2px]",
          onCream ? "bg-glow" : "bg-dawn",
        )}
      />
      <span className="eyebrow">{children}</span>
    </span>
  );
}

type TagPillProps = {
  children: ReactNode;
  /** `light` = on cream; `dark` = on a panel. */
  tone?: Tone;
  /** Mint "success" fill instead of the default lavender/lumen chip. */
  success?: boolean;
  className?: string;
};

/**
 * Rounded-full tag chip. Lavender on cream, faint lumen on dark, or a mint
 * success variant. Sentence-case Figtree.
 */
export function TagPill({
  children,
  tone = "dark",
  success = false,
  className,
}: TagPillProps): JSX.Element {
  const onCream = tone === "light";

  // The mint fill never flips (pistachio in both themes), so the success text
  // must stay dark-green in both. `text-success` (olive) covers light; in dark
  // the `success` token inverts to light pistachio (designed for dark surfaces)
  // and would vanish on mint, so we pin the dark override back to the documented
  // light-mode success olive. No bare/arbitrary hex.
  const fill = success
    ? "bg-mint text-success dark:text-[#3d5a1f]"
    : onCream
      ? "bg-dawn text-ink"
      : "bg-lumen/10 text-lumen";

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-3 py-1 font-sans text-xs leading-none",
        fill,
        className,
      )}
    >
      {children}
    </span>
  );
}
