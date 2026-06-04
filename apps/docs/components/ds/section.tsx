import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Eyebrow } from "./badge";

type Tone = "dark" | "light";

type SectionProps = {
  tone?: Tone;
  id?: string;
  className?: string;
  containerClassName?: string;
  children: ReactNode;
};

/**
 * Page section wrapper. Sets the background + default text color from `tone`
 * and frames children in the shared `container-page section-py` rhythm.
 * Pass `containerClassName` to override the inner frame entirely.
 */
export function Section({
  tone = "dark",
  id,
  className,
  containerClassName,
  children,
}: SectionProps) {
  return (
    <section
      id={id}
      className={cn(
        "relative overflow-hidden",
        tone === "light" ? "bg-paper text-black" : "bg-ink text-white",
        className,
      )}
    >
      <div className={cn("container-page section-py", containerClassName)}>
        {children}
      </div>
    </section>
  );
}

type SectionHeadingProps = {
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  tone?: Tone;
  align?: "left" | "center";
  className?: string;
};

/**
 * Standard section header: optional eyebrow pill, a large display heading, and
 * an optional muted subtitle. Colors follow `tone`; layout follows `align`.
 */
export function SectionHeading({
  eyebrow,
  title,
  subtitle,
  tone = "dark",
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
      {eyebrow ? (
        <Eyebrow tone={tone} className="mb-5">
          {eyebrow}
        </Eyebrow>
      ) : null}

      <h2
        className={cn(
          "font-display text-3xl leading-[1.08] md:text-5xl",
          "max-w-3xl",
          tone === "light" ? "text-black" : "text-white",
        )}
      >
        {title}
      </h2>

      {subtitle ? (
        <p
          className={cn(
            "mt-5 max-w-2xl text-base md:text-lg",
            tone === "light" ? "text-black/60" : "text-white/60",
          )}
        >
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}
