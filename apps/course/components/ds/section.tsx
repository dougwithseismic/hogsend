import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Eyebrow } from "./badge";

type Tone = "dark" | "light";

type SectionProps = {
  /** Accepted for compatibility — every tone renders the dark crimzon style. */
  tone?: Tone;
  id?: string;
  /**
   * Full-viewport-width horizontal hairline above the section (crosses the
   * gutters and intersects the page frame's vertical lines). On by default;
   * pass false for the hero / sections that sit flush under the nav hairline.
   */
  divider?: boolean;
  className?: string;
  containerClassName?: string;
  children: ReactNode;
};

/**
 * Page section wrapper. Background stays transparent over the global #050101
 * page so the frame hairlines run through; a full-bleed top hairline
 * separates sections. Children sit in the shared 1200px frame rhythm.
 */
export function Section({
  tone: _tone,
  id,
  divider = true,
  className,
  containerClassName,
  children,
}: SectionProps) {
  return (
    <section
      id={id}
      className={cn(
        "relative overflow-hidden text-white",
        divider && "border-hairline-faint border-t",
        className,
      )}
    >
      <div className={cn("container-page section-py", containerClassName)}>
        {children}
      </div>
    </section>
  );
}

/**
 * The shared section-heading type scale (Inter Display 36/44, tight tracking).
 * One constant so every hand-rolled H2 — SectionHeading, ProcessSteps' intro,
 * CtaPanel — stays on the same scale. Sites add their own extras (e.g. max-w).
 */
export const H2_CLASS =
  "font-display text-[36px] leading-[1.05] tracking-[-0.035em] text-white md:text-[44px]";

type SectionHeadingProps = {
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Accepted for compatibility — every tone renders the dark crimzon style. */
  tone?: Tone;
  align?: "left" | "center";
  className?: string;
};

/**
 * Standard section header: red sentence-case kicker, a 36/44 Inter Display
 * heading (usually 2 lines max), and an optional 16px white/60 subtitle.
 */
export function SectionHeading({
  eyebrow,
  title,
  subtitle,
  tone: _tone,
  align = "left",
  className,
}: SectionHeadingProps) {
  const centered = align === "center";

  return (
    <div
      className={cn(
        "flex flex-col",
        centered ? "items-center text-center" : "items-start text-left",
        className,
      )}
    >
      {eyebrow ? <Eyebrow className="mb-4">{eyebrow}</Eyebrow> : null}

      <h2 className={cn(H2_CLASS, "max-w-3xl")}>{title}</h2>

      {subtitle ? (
        <p className="mt-5 max-w-2xl text-base text-white/60 leading-6">
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}
