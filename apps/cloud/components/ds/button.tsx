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
  /**
   * Posted with the form when THIS button is the one that submitted it. How a
   * single form offers two verbs (approve / deny) over one shared input
   * without two forms and two copies of the field.
   */
  name?: string;
  value?: string;
  /**
   * Submit WITHOUT the browser's constraint validation. For the second verb of
   * a two-verb form, where the refusing action must not have to satisfy the
   * fields the approving one requires.
   */
  formNoValidate?: boolean;
  /** Only meaningful without an href (a disabled link is not a thing). */
  disabled?: boolean;
  /**
   * Click handler for the no-href case. Only usable from a client component —
   * passing one from a server component is a build error, which is the correct
   * outcome rather than a button that renders and does nothing.
   */
  onClick?: () => void;
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
  name,
  value,
  formNoValidate = false,
  disabled = false,
  onClick,
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
    <button
      type={type}
      {...(name === undefined ? {} : { name })}
      {...(value === undefined ? {} : { value })}
      {...(formNoValidate ? { formNoValidate: true } : {})}
      disabled={disabled}
      onClick={onClick}
      // pointer-events-none rather than a hover override: the variants each
      // define their own hover colour, and there is nothing to hover anyway.
      className={cn(
        classes,
        "disabled:pointer-events-none disabled:opacity-50",
      )}
    >
      {content}
    </button>
  );
}
