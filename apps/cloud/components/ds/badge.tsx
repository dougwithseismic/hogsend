import type { JSX, ReactNode } from "react";
import { cn } from "@/lib/cn";

type EyebrowProps = {
  children: ReactNode;
  className?: string;
};

/**
 * Section kicker: red 18px sentence-case Inter — sits directly above an H2.
 */
export function Eyebrow({ children, className }: EyebrowProps): JSX.Element {
  return <span className={cn("kicker block", className)}>{children}</span>;
}

type PillBadgeProps = {
  children: ReactNode;
  className?: string;
};

/**
 * Pill badge: red-tint fill, white/20 hairline border, 40px radius.
 */
export function PillBadge({
  children,
  className,
}: PillBadgeProps): JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-[40px] border border-white/20",
        "bg-accent-tint px-3 py-1.5 text-sm text-white",
        className,
      )}
    >
      {children}
    </span>
  );
}

type TagPillTone = "neutral" | "accent" | "good" | "caution";

const TAG_TONE: Record<TagPillTone, string> = {
  neutral: "border-white/[0.08] bg-white/[0.06] text-white/80",
  accent: "border-accent bg-accent-tint text-white",
  good: "border-good/40 bg-good-tint text-good",
  caution: "border-caution/40 bg-caution-tint text-caution",
};

type TagPillProps = {
  children: ReactNode;
  /** Status colouring. Defaults to the neutral white chip. */
  tone?: TagPillTone;
  className?: string;
};

/**
 * Small 3px-radius chip — statuses, regions, plan markers.
 */
export function TagPill({
  children,
  tone = "neutral",
  className,
}: TagPillProps): JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[3px] border px-2 py-1 text-xs",
        TAG_TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
