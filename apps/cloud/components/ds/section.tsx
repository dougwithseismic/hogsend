import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Eyebrow } from "./badge";

type SectionProps = {
  id?: string;
  /**
   * Full-width horizontal hairline above the section. On by default; pass
   * false for the first section under the page header's own hairline.
   */
  divider?: boolean;
  className?: string;
  containerClassName?: string;
  children: ReactNode;
};

/**
 * Page section wrapper. Background stays transparent over the global #050101
 * page so the frame hairlines run through; a full-bleed top hairline separates
 * sections. Children sit in the shared content-frame rhythm.
 */
export function Section({
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
        "relative text-white",
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

type SectionHeadingProps = {
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  align?: "left" | "center";
  className?: string;
};

/**
 * Standard section header: red sentence-case kicker, an Inter Display heading,
 * and an optional 16px white/60 subtitle.
 */
export function SectionHeading({
  eyebrow,
  title,
  subtitle,
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
      {eyebrow ? <Eyebrow className="mb-3">{eyebrow}</Eyebrow> : null}

      <h2 className="max-w-3xl font-display text-[24px] text-white leading-[1.2] tracking-[-0.02em] md:text-[28px]">
        {title}
      </h2>

      {subtitle ? (
        <p className="mt-3 max-w-2xl text-base text-white/60 leading-6">
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}
