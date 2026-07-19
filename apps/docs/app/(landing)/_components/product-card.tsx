import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The product-surface card kit — the flag card's exact visual language
 * (FlagPersonaSwitcher) extracted into primitives so every landing "product
 * surface" (the flags demo, the impact readout, …) shares one type and
 * spacing scale instead of re-approximating it.
 *
 * The scale, verbatim from the flag card:
 * - card:        rounded-lg, border #1c1d22, bg #101014, shadow-xl
 * - header:      px-4 py-3, mono-13 white/85 name, 12px white/40 description
 * - section:     px-4 py-3, hairline dividers at white/[0.08]
 * - footer:      section + bg-white/[0.03]
 * - tag:         rounded-[4px], mono-10 uppercase, tracking 0.08em
 * - label:       mono-10 uppercase white/40, tracking 0.08em
 * - row:         rounded-[6px] px-2.5 py-2, active = bg-white/[0.05]
 * - row label:   font-medium 13px, tracking -0.02em, white / white-55
 * - mono value:  mono 12.5px
 */

export function ProductCard({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-[#1c1d22] bg-[#101014] shadow-xl",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Header block: mono name + tag on one line, muted description under. */
export function ProductCardHeader({
  title,
  tag,
  description,
}: {
  title: ReactNode;
  tag?: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div className="border-white/[0.08] border-b px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <code className="min-w-0 truncate font-mono text-[13px] text-white/85">
          {title}
        </code>
        {tag}
      </div>
      {description ? (
        <p className="mt-1.5 text-[12px] text-white/40 leading-snug tracking-[-0.01em]">
          {description}
        </p>
      ) : null}
    </div>
  );
}

export function ProductCardSection({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn("px-4 py-3", className)}>{children}</div>;
}

/** The tinted footer strip ("evaluated for you"). */
export function ProductCardFooter({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "border-white/[0.08] border-t bg-white/[0.03] px-4 py-3",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** The `multivariate` chip. `crimzon` for live/significant states; `pulse`
 * adds the live dot. */
export function ProductTag({
  tone = "neutral",
  pulse = false,
  className,
  children,
}: {
  tone?: "neutral" | "crimzon";
  pulse?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-[4px] border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em]",
        tone === "crimzon"
          ? "border-[#f64838]/30 bg-[#f64838]/[0.08] text-[#f64838]"
          : "border-white/10 bg-white/[0.04] text-white/45",
        className,
      )}
    >
      {pulse && (
        <span className="ps-pulse size-1.5 rounded-full bg-[#f64838]" />
      )}
      {children}
    </span>
  );
}

/** Mono section label ("EVALUATED FOR YOU"). */
export function ProductLabel({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <p
      className={cn(
        "font-mono text-[10px] text-white/40 uppercase tracking-[0.08em]",
        className,
      )}
    >
      {children}
    </p>
  );
}

/** Muted body copy inside a card (the header-description scale). Exported as
 * a class too, for spans inside interactive elements (a `<p>` can't live
 * inside a `<button>`). */
export const PRODUCT_MUTED_CLASS =
  "text-[12px] text-white/40 leading-snug tracking-[-0.01em]";

export function ProductMuted({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <p className={cn(PRODUCT_MUTED_CLASS, className)}>{children}</p>;
}

/* Row idiom — exported as class builders so interactive elements (the flag
   card's switch buttons) and static rows (the impact card's versions) share
   them without forcing an element type. */

/** Container for a run of rows (the toggle list's gutter). */
export const PRODUCT_ROW_LIST_CLASS = "flex flex-col gap-0.5 px-2 py-2";

export function productRowClass(active: boolean) {
  return cn("rounded-[6px] px-2.5 py-2", active && "bg-white/[0.05]");
}

export function productRowLabelClass(active: boolean) {
  return cn(
    "font-medium text-[13px] tracking-[-0.02em]",
    active ? "text-white" : "text-white/55",
  );
}

/** Mono value text (the "evaluated for you" readout scale). */
export const PRODUCT_MONO_VALUE_CLASS = "font-mono text-[12.5px]";

/** A stat inside a card section: value on the pillar-title scale, muted
 * label, optional crimzon meter. */
export function ProductStat({
  value,
  label,
  meter,
}: {
  value: ReactNode;
  label: ReactNode;
  /** 0–1 fill fraction for the meter bar; omit for no bar. */
  meter?: number;
}) {
  return (
    <div>
      <p className="font-medium text-base text-white tracking-[-0.025em]">
        {value}
      </p>
      <p className="mt-0.5 text-[12px] text-white/40 leading-snug tracking-[-0.01em]">
        {label}
      </p>
      {meter !== undefined && (
        <div className="mt-2 h-0.5 w-[72%] overflow-hidden rounded-full bg-white/[0.08]">
          <div
            className="h-full rounded-full bg-[#f64838]"
            style={{ width: `${Math.round(meter * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}
