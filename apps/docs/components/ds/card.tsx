import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type Tone = "dark" | "light";

type CornerTicksProps = {
  className?: string;
  tone?: Tone;
};

/**
 * The signature registration motif: four small L-shaped corner marks. Drawn
 * with `border-current` so they inherit the parent's text color, and faded to
 * 40% opacity. Purely decorative — `aria-hidden` + `pointer-events-none`.
 */
export function CornerTicks({ className, tone = "dark" }: CornerTicksProps) {
  const color = tone === "light" ? "text-black" : "text-white";
  const tick = "pointer-events-none absolute h-2 w-2 border-current opacity-40";

  return (
    <span aria-hidden className={cn("absolute inset-0", color, className)}>
      <span className={cn(tick, "left-0 top-0 border-l border-t")} />
      <span className={cn(tick, "right-0 top-0 border-r border-t")} />
      <span className={cn(tick, "bottom-0 left-0 border-b border-l")} />
      <span className={cn(tick, "bottom-0 right-0 border-b border-r")} />
    </span>
  );
}

type CardProps = {
  children: ReactNode;
  tone?: Tone;
  ticks?: boolean;
  className?: string;
};

/**
 * Generic surface card. 10px radius, subtle fill + border per tone, and an
 * optional set of corner registration ticks.
 */
export function Card({
  children,
  tone = "dark",
  ticks = false,
  className,
}: CardProps) {
  return (
    <div
      className={cn(
        "relative rounded-[10px] p-6",
        tone === "light"
          ? "border border-black/[0.06] bg-white text-black"
          : "border border-white/[0.08] bg-white/[0.02] text-white",
        className,
      )}
    >
      {ticks ? <CornerTicks tone={tone} /> : null}
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
 * Feature card for 3-up grids: optional top media block, a small icon square,
 * a display title, and a muted description.
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
  return (
    <Card
      tone={tone}
      ticks={ticks}
      className={cn("flex flex-col gap-5", className)}
    >
      {media ? (
        <div className="relative -mx-6 -mt-6 mb-1 overflow-hidden rounded-t-[10px]">
          {media}
        </div>
      ) : null}

      {icon ? (
        <span
          className={cn(
            "inline-flex h-10 w-10 items-center justify-center rounded-md",
            tone === "light"
              ? "border border-black/[0.08] bg-black/[0.03] text-black"
              : "border border-white/[0.08] bg-white/[0.04] text-white",
          )}
        >
          {icon}
        </span>
      ) : null}

      <div className="flex flex-col gap-2.5">
        <h3
          className={cn(
            "font-display text-xl leading-[1.2]",
            tone === "light" ? "text-black" : "text-white",
          )}
        >
          {title}
        </h3>
        <p
          className={cn(
            "text-sm leading-relaxed md:text-base",
            tone === "light" ? "text-black/60" : "text-white/60",
          )}
        >
          {description}
        </p>
      </div>
    </Card>
  );
}
