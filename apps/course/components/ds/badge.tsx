import Link from "next/link";
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

type AnnouncePillProps = {
  /** Where the pill links (internal route or external URL). */
  href: string;
  /** The solid red chip label at the pill's left. */
  chip: string;
  children: React.ReactNode;
  className?: string;
};

/**
 * Announcement pill: a red chip + a line of copy in a rounded red-tint capsule,
 * used at the top of marketing heroes (catalog + pricing). Mirrors the product
 * homepage's announcement pill so the two sites read as one family.
 */
export function AnnouncePill({
  href,
  chip,
  children,
  className,
}: AnnouncePillProps): JSX.Element {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border border-white/10",
        "bg-accent-tint py-1 pr-4 pl-1 text-[13px] text-white/75",
        className,
      )}
    >
      <span className="rounded-full bg-accent px-2.5 py-0.5 font-medium text-[12px] text-white">
        {chip}
      </span>
      {children}
    </Link>
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
