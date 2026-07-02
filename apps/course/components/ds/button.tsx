import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { JSX } from "react";
import { cn } from "@/lib/cn";

type ButtonProps = {
  /** Renders <Link>/<a> if set, otherwise <button>. */
  href?: string;
  /**
   * "accent" and "solid" render the primary white button; "outline" renders
   * the secondary hairline-bordered button (same geometry, ghost fill).
   */
  variant?: "accent" | "outline" | "solid";
  /** Accepted for compatibility — every tone renders the dark crimzon style. */
  tone?: "dark" | "light";
  /** Show the trailing → arrow (nudges right on hover). */
  icon?: boolean;
  /** target=_blank rel=noreferrer (also forces an <a> for href). */
  external?: boolean;
  children: React.ReactNode;
  className?: string;
};

const BASE =
  "group inline-flex items-center gap-2 text-base font-medium tracking-[-0.02em] transition-colors duration-200 select-none";

function variantClasses(variant: NonNullable<ButtonProps["variant"]>): string {
  if (variant === "outline") {
    // Secondary: white/15 hairline, ghost fill on hover, primary geometry.
    return "h-12 rounded-[10px] border border-white/15 px-5 text-white hover:border-white/30 hover:bg-white/[0.04]";
  }
  // Primary ("accent" and "solid"): white fill, near-black text, 10px radius.
  return "h-12 rounded-[10px] bg-white px-5 text-[#0a0a0a] hover:bg-white/90";
}

export function Button({
  href,
  variant = "accent",
  tone: _tone,
  icon = false,
  external = false,
  children,
  className,
}: ButtonProps): JSX.Element {
  const content = (
    <>
      <span>{children}</span>
      {icon ? (
        <ArrowRight
          aria-hidden="true"
          className="size-4 shrink-0 transition-transform duration-200 group-hover:translate-x-0.5"
          strokeWidth={2}
        />
      ) : null}
    </>
  );

  const classes = cn(BASE, variantClasses(variant), className);

  if (href) {
    // External link (or explicitly flagged external) → <a>.
    const isInternal = href.startsWith("/") && !external;
    if (isInternal) {
      return (
        <Link href={href} className={classes}>
          {content}
        </Link>
      );
    }
    return (
      <a
        href={href}
        className={classes}
        {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      >
        {content}
      </a>
    );
  }

  return (
    <button type="button" className={classes}>
      {content}
    </button>
  );
}
