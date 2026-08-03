import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type EmptyStateProps = {
  /** Hairline icon tile above the title. */
  icon?: ReactNode;
  title: string;
  description: string;
  /** Buttons or links — rendered in a row under the description. */
  actions?: ReactNode;
  /** Extra detail (a list, a code line) below the actions. */
  children?: ReactNode;
  className?: string;
};

/**
 * The dashboard's zero-data surface: a hairline-bordered panel over a faint
 * red dot-grid, with a centred icon tile, title, one-line explanation and the
 * action that resolves it.
 */
export function EmptyState({
  icon,
  title,
  description,
  actions,
  children,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md border border-white/[0.08] bg-white/[0.015]",
        className,
      )}
    >
      <div
        aria-hidden
        className="dot-grid pointer-events-none absolute inset-0 opacity-30 [mask-image:radial-gradient(60%_60%_at_50%_0%,black,transparent)]"
      />
      <div className="relative flex flex-col items-center gap-4 px-6 py-14 text-center">
        {icon ? (
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.04] text-white/70">
            {icon}
          </span>
        ) : null}
        <h2 className="font-display text-[22px] text-white leading-[1.2] tracking-[-0.02em]">
          {title}
        </h2>
        <p className="max-w-prose text-sm text-white/60 leading-6">
          {description}
        </p>
        {actions ? (
          <div className="mt-1 flex flex-wrap items-center justify-center gap-3">
            {actions}
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}
