import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type CardProps = {
  children: ReactNode;
  className?: string;
};

/**
 * Strips a `Card` back to a plain container: no border, no fill, no padding.
 *
 * For a card rendered INSIDE something that already provides the surface — a
 * drawer, most of all. Nesting a bordered card inside a bordered panel reads as
 * two boxes saying the same thing, which is the noise this page was rebuilt to
 * remove. Exported as a class rather than a `bare` prop on `Card` so the
 * decision stays with the caller that knows its own context.
 */
export const CARD_BARE =
  "rounded-none border-0 bg-transparent p-0 hover:border-transparent";

/**
 * Generic surface card: 6px radius, white/1.5% fill, white/8 hairline border,
 * 24px padding. Border brightens to white/15 on hover.
 */
export function Card({ children, className }: CardProps) {
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
  className?: string;
};

/**
 * Card with an optional hairline icon tile, a 20px/500 title and a 16px
 * white/60 body — the standard 3-up grid unit.
 */
export function FeatureCard({
  icon,
  title,
  description,
  className,
}: FeatureCardProps) {
  return (
    <Card className={cn("flex flex-col gap-5", className)}>
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
