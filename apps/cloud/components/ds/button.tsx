import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { JSX, ReactNode } from "react";
import { cn } from "@/lib/cn";

type ButtonProps = {
  /** Renders <Link>/<a> if set, otherwise <button>. */
  href?: string;
  /**
   * "solid" is the primary white button; "outline" is a hairline-bordered
   * secondary; "ghost" is a plain text action.
   */
  variant?: "solid" | "outline" | "ghost";
  /** Show the trailing → arrow (nudges right on hover). */
  icon?: boolean;
  /** target=_blank rel=noreferrer (also forces an <a> for href). */
  external?: boolean;
  /** Button element type when there's no href — "submit" to post a form. */
  type?: "button" | "submit";
  children: ReactNode;
  className?: string;
};

const BASE =
  "group inline-flex select-none items-center gap-2 font-medium text-sm tracking-[-0.02em] transition-colors duration-200";

const VARIANT: Record<NonNullable<ButtonProps["variant"]>, string> = {
  solid: "h-10 rounded-[10px] bg-white px-4 text-[#0a0a0a] hover:bg-white/90",
  outline:
    "h-10 rounded-[10px] border border-white/15 px-4 text-white hover:border-white/30 hover:bg-white/[0.04]",
  ghost: "h-10 px-1 text-white hover:text-white/70",
};

export function Button({
  href,
  variant = "solid",
  icon = false,
  external = false,
  type = "button",
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

  const classes = cn(BASE, VARIANT[variant], className);

  if (href) {
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
    <button type={type} className={classes}>
      {content}
    </button>
  );
}
