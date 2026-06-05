import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type Tone = "dark" | "light";

type CornerTicksProps = {
  className?: string;
  tone?: Tone;
};

/**
 * Retired "registration" corner-tick motif. Kept as an exported no-op so any
 * remaining call sites keep compiling; the Wispr Flow system does not use it.
 */
export function CornerTicks(_props: CornerTicksProps): null {
  return null;
}

type CardProps = {
  children: ReactNode;
  /** `light` = on cream; `dark` = on a dark/teal panel. */
  tone?: Tone;
  /** Retained for back-compat; the corner-tick motif is removed. */
  ticks?: boolean;
  className?: string;
};

/**
 * Generic surface card. On cream: white paper with a hairline ink border. On a
 * dark/teal panel: a faint lumen wash with a thin lumen border.
 */
export function Card({
  children,
  tone = "dark",
  ticks: _ticks = false,
  className,
}: CardProps) {
  const onCream = tone === "light";

  return (
    <div
      className={cn(
        "relative rounded-3xl p-6",
        onCream
          ? "border-2 border-ink/10 bg-paper text-ink"
          : "border border-lumen/10 bg-lumen/[0.04] text-lumen",
        className,
      )}
    >
      {children}
    </div>
  );
}

type FeatureCardProps = {
  icon?: ReactNode;
  title: string;
  description: string;
  media?: ReactNode;
  tone?: Tone;
  ticks?: boolean;
  className?: string;
};

/**
 * Feature card for 3-up grids: optional top media block, a tinted icon chip
 * (amber on cream / lavender on a panel), a light-serif title, and a Figtree
 * description.
 */
export function FeatureCard({
  icon,
  title,
  description,
  media,
  tone = "dark",
  ticks = false,
  className,
}: FeatureCardProps) {
  const onCream = tone === "light";

  return (
    <Card
      tone={tone}
      ticks={ticks}
      className={cn("flex flex-col gap-5", className)}
    >
      {media ? (
        <div className="relative -mx-6 -mt-6 mb-1 overflow-hidden rounded-t-3xl">
          {media}
        </div>
      ) : null}

      {icon ? (
        <span
          className={cn(
            "inline-flex h-11 w-11 items-center justify-center rounded-xl",
            onCream ? "bg-glow/15 text-ink" : "bg-dawn/15 text-lumen",
          )}
        >
          {icon}
        </span>
      ) : null}

      <div className="flex flex-col gap-2.5">
        <h3
          className={cn(
            "font-display text-2xl leading-[1.15] tracking-tight md:text-[1.75rem]",
            onCream ? "text-ink" : "text-lumen",
          )}
        >
          {title}
        </h3>
        <p
          className={cn(
            "font-sans text-sm leading-relaxed md:text-base",
            onCream ? "text-ink/65" : "text-lumen/65",
          )}
        >
          {description}
        </p>
      </div>
    </Card>
  );
}
