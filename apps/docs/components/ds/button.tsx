import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { JSX, ReactNode } from "react";
import { cn } from "@/lib/cn";

type ButtonProps = {
  /** Renders <Link>/<a> if set, otherwise <button>. */
  href?: string;
  variant?: "accent" | "outline" | "solid";
  /** Switches the on-cream / on-dark color treatment for solid & outline. */
  tone?: "dark" | "light";
  /**
   * Show a leading lucide icon. `true` = the default ArrowRight; pass any node
   * to use a custom icon (e.g. <Terminal />). Honored on every variant.
   */
  icon?: boolean | ReactNode;
  /** target=_blank rel=noreferrer (also forces an <a> for href). */
  external?: boolean;
  children: ReactNode;
  className?: string;
};

/**
 * Wispr-style bordered rounded-rectangle button: 12px radius, hard 2px ink
 * border, Figtree 600, sentence case. Never a pill, never sharp, never
 * mono-uppercase.
 */
const BASE =
  "inline-flex items-center justify-center gap-2 rounded-[12px] border-2 px-6 py-3.5 font-sans font-semibold text-base leading-none transition-[filter,background-color,color,transform] duration-200 select-none hover:-translate-y-px";

function variantClasses(
  variant: NonNullable<ButtonProps["variant"]>,
  tone: NonNullable<ButtonProps["tone"]>,
): string {
  // `light` tone = the button sits on a dark/teal panel (lumen text).
  const onPanel = tone === "light";

  if (variant === "accent") {
    // Primary: lavender fill, ink text + border. Identical on cream or panel.
    return "border-ink bg-dawn text-ink hover:brightness-95";
  }

  if (variant === "solid") {
    // Dark fill on cream; inverts to a lumen fill when placed on a dark panel.
    return onPanel
      ? "border-lumen bg-lumen text-ink hover:brightness-95"
      : "border-ink bg-ink text-lumen hover:brightness-110";
  }

  // outline / secondary: white card on cream; transparent + lumen on panels.
  return onPanel
    ? "border-lumen/70 bg-transparent text-lumen hover:bg-lumen/10"
    : "border-ink bg-paper text-ink hover:bg-ink/[0.04]";
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
  const iconNode: ReactNode = icon ? (
    icon === true ? (
      <ArrowRight
        className="size-[1.05em] shrink-0"
        strokeWidth={2}
        aria-hidden="true"
      />
    ) : (
      icon
    )
  ) : null;

  const content = (
    <>
      {iconNode}
      <span>{children}</span>
    </>
  );

  const classes = cn(BASE, variantClasses(variant, tone), className);

  if (href) {
    // Internal app routes use <Link>; everything else is a plain <a>.
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
