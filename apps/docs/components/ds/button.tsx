import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { JSX } from "react";
import { cn } from "@/lib/cn";

type ButtonProps = {
  /** Renders <Link>/<a> if set, otherwise <button>. */
  href?: string;
  variant?: "accent" | "outline" | "solid";
  /** Affects outline/solid colors. */
  tone?: "dark" | "light";
  /** Show the leading 24x24 arrow icon box (accent variant). */
  icon?: boolean;
  /** target=_blank rel=noreferrer (also forces an <a> for href). */
  external?: boolean;
  children: React.ReactNode;
  className?: string;
};

const BASE =
  "inline-flex h-10 items-center gap-2.5 rounded-none px-6 font-mono text-xs uppercase tracking-wide transition-[filter,background-color,color] duration-200 select-none";

function variantClasses(
  variant: NonNullable<ButtonProps["variant"]>,
  tone: NonNullable<ButtonProps["tone"]>,
): string {
  if (variant === "accent") {
    return "bg-accent text-black hover:brightness-95";
  }
  if (variant === "solid") {
    return tone === "light"
      ? "bg-white text-black hover:brightness-95"
      : "bg-black text-white hover:brightness-110";
  }
  // outline
  return tone === "light"
    ? "border border-black/15 text-current hover:bg-black/5"
    : "border border-white/15 text-current hover:bg-white/5";
}

export function Button({
  href,
  variant = "accent",
  tone = "dark",
  icon = false,
  external = false,
  children,
  className,
}: ButtonProps): JSX.Element {
  const showIcon = icon && variant === "accent";

  const content = (
    <>
      {showIcon ? (
        <span
          aria-hidden="true"
          className="-ml-3 flex size-6 shrink-0 items-center justify-center bg-black"
        >
          <ArrowRight className="size-3.5 text-accent" strokeWidth={1.5} />
        </span>
      ) : null}
      <span>{children}</span>
    </>
  );

  const classes = cn(BASE, variantClasses(variant, tone), className);

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
