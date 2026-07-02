import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Eyebrow } from "./badge";
import { DotGrid } from "./fx";
import { H2_CLASS } from "./section";

type CtaPanelProps = {
  /** Uppercase micro-label above the title. */
  eyebrow?: string;
  title: ReactNode;
  /** Paragraph under the title (white/70). */
  body?: ReactNode;
  /** Buttons/links row under the body — pass your own flex children. */
  actions?: ReactNode;
  /**
   * Decorative panel for the right column (lg+ only) — a DOM vignette, not
   * an image. Positioned oversized (w-[120%], slight rotate) so it bleeds
   * off the card's right edge.
   */
  media?: ReactNode;
  className?: string;
};

/**
 * Crimzon closing-CTA card: one big hairline-bordered card over a DotGrid
 * backdrop, a red glow bleeding from the left edge, copy + actions on the
 * left, and an optional media vignette bleeding off the right edge.
 * Server component — renders a full section (top hairline, section rhythm).
 */
export function CtaPanel({
  eyebrow,
  title,
  body,
  actions,
  media,
  className,
}: CtaPanelProps) {
  return (
    <section
      className={cn(
        "relative border-hairline-faint border-t text-white",
        className,
      )}
    >
      <DotGrid />

      <div className="container-page section-py relative">
        <div className="relative overflow-hidden rounded-md border border-white/10 bg-[#070303]">
          {/* Red glow bleeding in from the left edge of the card. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(70% 100% at 0% 60%, rgba(246,72,56,0.22), rgba(246,72,56,0.06) 45%, transparent 70%)",
            }}
          />

          <div
            className={cn(
              "relative grid grid-cols-1",
              media && "lg:grid-cols-[1.1fr_0.9fr]",
            )}
          >
            {/* Left: copy + actions. */}
            <div className="flex flex-col items-start p-8 md:p-12">
              {eyebrow ? <Eyebrow className="mb-4">{eyebrow}</Eyebrow> : null}

              <h2 className={H2_CLASS}>{title}</h2>

              {body ? (
                <p className="mt-5 max-w-lg text-base text-white/70 leading-6">
                  {body}
                </p>
              ) : null}

              {actions ? (
                <div className="mt-8 flex flex-wrap items-center gap-5">
                  {actions}
                </div>
              ) : null}
            </div>

            {/* Right: media vignette bleeding off the card edge. */}
            {media ? (
              <div
                aria-hidden="true"
                className="relative hidden min-h-[400px] lg:block"
              >
                <div className="absolute top-12 left-6 w-[120%] rotate-[-2deg] shadow-2xl shadow-black/60">
                  {media}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
