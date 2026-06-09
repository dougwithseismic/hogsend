import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Eyebrow } from "./badge";

type Step = {
  n: string;
  title: string;
  description: string;
  media?: ReactNode;
};

type ProcessStepsProps = {
  steps: Step[];
  /** Accepted for compatibility — every tone renders the dark crimzon style. */
  tone?: "dark" | "light";
  /** Optional sticky left column (crimzon how-it-works). */
  eyebrow?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  className?: string;
};

/**
 * Crimzon how-it-works: an optional sticky left column (kicker, H2, sub) and
 * a right stack of ghost-numbered step cards (32px pad, white/1% fill,
 * white/8 hairline, 6px radius, 28px gap). Without the intro props it renders
 * just the card stack. Server component — no interaction needed.
 */
export function ProcessSteps({
  steps,
  tone: _tone,
  eyebrow,
  title,
  subtitle,
  className,
}: ProcessStepsProps) {
  const hasIntro = Boolean(eyebrow || title || subtitle);

  const cards = (
    <ol className="flex flex-col gap-7">
      {steps.map((step) => (
        <li
          key={step.n}
          className="rounded-md border border-white/[0.08] bg-white/[0.01] p-8 transition-colors duration-200 hover:border-white/15"
        >
          <span
            aria-hidden="true"
            className="block font-display text-[56px] text-white/20 leading-none md:text-[64px]"
          >
            {step.n}
          </span>
          <h3 className="mt-6 font-medium font-sans text-white text-xl leading-[1.2] tracking-[-0.02em]">
            {step.title}
          </h3>
          <p className="mt-3 text-base text-white/70 leading-6">
            {step.description}
          </p>
          {step.media ? <div className="mt-6 min-w-0">{step.media}</div> : null}
        </li>
      ))}
    </ol>
  );

  if (!hasIntro) {
    return <div className={className}>{cards}</div>;
  }

  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-12 lg:grid-cols-2 lg:gap-16",
        className,
      )}
    >
      <div className="lg:sticky lg:top-28 lg:self-start">
        {eyebrow ? <Eyebrow className="mb-4">{eyebrow}</Eyebrow> : null}
        {title ? (
          <h2 className="max-w-xl font-display text-[32px] text-white leading-[1.2] tracking-[-0.02em] md:text-[40px] md:leading-[48px]">
            {title}
          </h2>
        ) : null}
        {subtitle ? (
          <p className="mt-5 max-w-md text-base text-white/60 leading-6">
            {subtitle}
          </p>
        ) : null}
      </div>
      {cards}
    </div>
  );
}
