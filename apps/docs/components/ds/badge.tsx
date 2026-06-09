import type { JSX } from "react";
import { cn } from "@/lib/cn";

type EyebrowProps = {
  children: React.ReactNode;
  /** Accepted for compatibility — every tone renders the dark crimzon style. */
  tone?: "dark" | "light";
  className?: string;
};

/**
 * Section kicker: red 18px sentence-case Inter — sits directly above an H2.
 * (The old mono-uppercase pill is gone; pass sentence-case copy.)
 */
export function Eyebrow({
  children,
  tone: _tone,
  className,
}: EyebrowProps): JSX.Element {
  return <span className={cn("kicker block", className)}>{children}</span>;
}

type PillBadgeProps = {
  children: React.ReactNode;
  className?: string;
};

/**
 * Hero pill badge: red-tint fill, white/20 hairline border, 40px radius.
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

type TagPillProps = {
  children: React.ReactNode;
  /** Accepted for compatibility — every tone renders the dark crimzon style. */
  tone?: "dark" | "light";
  /** Red-tinted chip (e.g. "Popular" on the highlighted pricing card). */
  accent?: boolean;
  className?: string;
};

/**
 * Small 3px-radius chip — tags, stages, plan markers.
 */
export function TagPill({
  children,
  tone: _tone,
  accent = false,
  className,
}: TagPillProps): JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[3px] px-2 py-1 text-xs",
        accent
          ? "border border-accent bg-accent-tint text-white"
          : "border border-white/[0.08] bg-white/[0.06] text-white/80",
        className,
      )}
    >
      {children}
    </span>
  );
}
