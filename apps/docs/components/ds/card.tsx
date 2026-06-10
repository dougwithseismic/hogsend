import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type Tone = "dark" | "light";

type CornerTicksProps = {
  className?: string;
  tone?: Tone;
};

/**
 * Legacy registration motif — retired in the crimzon redesign (the hairline
 * grid frame carries the aesthetic now). Kept as a no-op so existing call
 * sites keep compiling.
 */
export function CornerTicks(_props: CornerTicksProps) {
  return null;
}

type CardProps = {
  children: ReactNode;
  /** Accepted for compatibility — every tone renders the dark crimzon style. */
  tone?: Tone;
  /** Legacy prop — corner ticks are retired; accepted and ignored. */
  ticks?: boolean;
  className?: string;
};

/**
 * Generic surface card: 6px radius, white/1.5% fill, white/8 hairline border,
 * 24px padding. Border brightens to white/15 on hover.
 */
export function Card({
  children,
  tone: _tone,
  ticks: _ticks,
  className,
}: CardProps) {
  return (
    <div
      className={cn(
        "relative rounded-md border border-white/[0.08] bg-white/[0.015] p-6",
        "text-white transition-colors duration-200 hover:border-white/15",
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
  /** Accepted for compatibility — every tone renders the dark crimzon style. */
  tone?: Tone;
  /** Legacy prop — corner ticks are retired; accepted and ignored. */
  ticks?: boolean;
  className?: string;
};

/**
 * Feature card for 3-up grids: optional top imagery block (bleeds to the card
 * edges), 20px/500 title, 16px white/60 body.
 */
export function FeatureCard({
  icon,
  title,
  description,
  media,
  tone: _tone,
  ticks: _ticks,
  className,
}: FeatureCardProps) {
  return (
    <Card className={cn("flex flex-col gap-5", className)}>
      {media ? (
        <div className="relative -mx-6 -mt-6 mb-1 overflow-hidden rounded-t-md">
          {media}
        </div>
      ) : null}

      {icon ? (
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.04] text-white">
          {icon}
        </span>
      ) : null}

      <div className="flex flex-col gap-2.5">
        <h3 className="font-medium font-sans text-white text-xl leading-[1.2] tracking-[-0.02em]">
          {title}
        </h3>
        <p className="text-base text-white/60 leading-6">{description}</p>
      </div>
    </Card>
  );
}
