import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/cn";

type HairlineProps = {
  className?: string;
};

/** A single faint white/8 rule — the divider used inside and between cards. */
export function Hairline({ className }: HairlineProps) {
  return (
    <div aria-hidden className={cn("h-px w-full bg-white/[0.08]", className)} />
  );
}

type DottedArrowProps = {
  className?: string;
};

/**
 * Small square "go" affordance: hairline border + → arrow glyph. Decorative
 * on its own; wrap it in an interactive element when used as an action.
 */
export function DottedArrow({ className }: DottedArrowProps) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-md border border-white/15 text-white",
        className,
      )}
    >
      <ArrowRight className="h-4 w-4" strokeWidth={1.5} />
    </span>
  );
}

type StatProps = {
  value: string;
  label: string;
  className?: string;
};

/** Stat block: a large Inter number over a 12px uppercase white/50 caption. */
export function Stat({ value, label, className }: StatProps) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <span className="font-sans text-[32px] text-white leading-[40px] tracking-[-0.02em]">
        {value}
      </span>
      <span className="eyebrow text-white/50">{label}</span>
    </div>
  );
}
