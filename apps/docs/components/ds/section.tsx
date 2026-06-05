import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Eyebrow } from "./badge";

/**
 * `cream`/`light` are the transparent canvas tone (light maps to cream for
 * back-compat). `dark` and `teal` are rounded panels stacked on the cream.
 */
type Tone = "cream" | "light" | "dark" | "teal";

/** True when the tone renders ink text on the open cream canvas. */
function isCream(tone: Tone): boolean {
  return tone === "cream" || tone === "light";
}

type SectionProps = {
  tone?: Tone;
  /**
   * Wrap the content in a rounded panel framed by the cream canvas. Defaults to
   * true for `dark`/`teal`, false for `cream`/`light`.
   */
  panel?: boolean;
  id?: string;
  className?: string;
  containerClassName?: string;
  children: ReactNode;
};

const PANEL_SHELL =
  "mx-4 overflow-hidden rounded-[2.5rem] md:mx-6 md:rounded-[4rem]";

/**
 * Page section. Cream/light tones are transparent over the body and use the
 * normal container. Dark/teal tones render as rounded panels inset from the
 * edges so the cream canvas frames them like Wispr Flow's stacked cards.
 */
export function Section({
  tone = "cream",
  panel,
  id,
  className,
  containerClassName,
  children,
}: SectionProps) {
  const cream = isCream(tone);
  // Panels are on by default for dark/teal, off for cream/light.
  const asPanel = panel ?? !cream;

  const toneClasses = cream
    ? "bg-transparent text-ink"
    : tone === "teal"
      ? "bg-fathom text-lumen"
      : "bg-ink text-lumen";

  const inner = (
    <div className={cn("container-page section-py", containerClassName)}>
      {children}
    </div>
  );

  if (asPanel) {
    return (
      <section id={id} className={cn("relative", className)}>
        <div className={cn(PANEL_SHELL, toneClasses)}>{inner}</div>
      </section>
    );
  }

  return (
    <section id={id} className={cn("relative", toneClasses, className)}>
      {inner}
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
 * Standard section header: optional eyebrow kicker, a large light-serif display
 * heading, and an optional Figtree subtitle. Colors follow `tone`.
 */
export function SectionHeading({
  eyebrow,
  title,
  subtitle,
  tone = "cream",
  align = "left",
  className,
}: SectionHeadingProps) {
  const centered = align === "center";
  const cream = isCream(tone);

  return (
    <div
      className={cn(
        "flex flex-col",
        centered ? "items-center text-center" : "items-start text-left",
        className,
      )}
    >
      {eyebrow ? (
        // Eyebrow tone: amber square on cream, lavender square on a panel.
        <Eyebrow tone={cream ? "light" : "dark"} className="mb-5">
          {eyebrow}
        </Eyebrow>
      ) : null}

      <h2
        className={cn(
          "font-display max-w-3xl tracking-tight",
          "text-[clamp(2.25rem,4.5vw,4rem)] leading-[1.0]",
          cream ? "text-ink" : "text-lumen",
        )}
      >
        {title}
      </h2>

      {subtitle ? (
        <p
          className={cn(
            "mt-5 max-w-2xl font-sans text-base md:text-lg",
            cream ? "text-ink/65" : "text-lumen/65",
          )}
        >
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}
