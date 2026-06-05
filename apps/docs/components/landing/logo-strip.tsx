import { type BrandKey, BrandLogo } from "@/components/ds/brand-logo";
import { Sunburst } from "@/components/ds/doodle";
import { LogoMarquee } from "@/components/ds/marquee";
import { Section, SectionHeading } from "@/components/ds/section";
import { cn } from "@/lib/cn";

/**
 * Integrations + clients block — the first stacked panel under the hero, in the
 * Wispr Flow skin. Two rounded panels framed by the cream canvas:
 *
 *   1. a DARK (#1a1a1a) "integrations" panel — serif headline, a centered arc of
 *      real `BrandLogo` marks tinted for dark, and a row of rounded-full bordered
 *      platform pills (the PostHog in / Resend out story);
 *   2. a TEAL (#034f46) "clients" strip — a serif line + the auto-scrolling
 *      `LogoMarquee` of the same stack marks, tinted lumen.
 *
 * Server component: composes the client-free `LogoMarquee` (CSS keyframe) and
 * paints the brand marks via CSS mask, so they inherit the panel's `lumen` ink.
 */

// The stack we wire together — drives both the integration arc and the marquee.
const STACK = [
  "posthog",
  "resend",
  "stripe",
  "railway",
  "typescript",
] as const satisfies readonly BrandKey[];

// The platform "pills" — the channels Hogsend speaks to out of the box.
const PLATFORMS = ["PostHog", "Resend", "Stripe", "Webhooks"] as const;

export function LogoStrip({ className }: { className?: string }) {
  // Marquee items reuse the same brand marks, tinted for the teal panel.
  const marqueeItems = STACK.map((brand) => (
    <BrandLogo
      key={brand}
      brand={brand}
      height={24}
      className="text-lumen/70"
    />
  ));

  return (
    <div className={cn("flex flex-col", className)}>
      {/* 1 — Dark integrations panel */}
      <Section tone="dark">
        <SectionHeading
          tone="dark"
          align="center"
          eyebrow="Integrations"
          title="Works in every part of your stack"
          subtitle="PostHog in, Resend out — events, journeys, and sends wired together in plain TypeScript, no glue code."
          className="mx-auto"
        />

        {/* Arc of integration marks, tinted for the dark panel. A pair of amber
            doodle sparks punctuate the row, Wispr style. */}
        <div className="relative mt-14 flex flex-wrap items-center justify-center gap-x-10 gap-y-8 sm:gap-x-14">
          <Sunburst className="-top-6 -left-2 absolute size-7 text-glow/80 max-sm:hidden" />
          {STACK.map((brand) => (
            <BrandLogo
              key={brand}
              brand={brand}
              height={30}
              className="text-lumen/65 transition-colors duration-200 hover:text-lumen"
            />
          ))}
          <Sunburst className="-right-1 -bottom-7 absolute size-5 text-glow/70 max-sm:hidden" />
        </div>

        {/* Platform pills — rounded-full, bordered, the channels Hogsend speaks. */}
        <div className="mt-14 flex flex-wrap items-center justify-center gap-3">
          {PLATFORMS.map((platform) => (
            <span
              key={platform}
              className="inline-flex items-center gap-2 rounded-full border border-lumen/20 bg-lumen/[0.04] px-4 py-2 font-sans text-lumen/80 text-sm leading-none"
            >
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-full bg-glow"
              />
              {platform}
            </span>
          ))}
        </div>
      </Section>

      {/* 2 — Teal clients strip */}
      <Section tone="teal">
        <div className="flex flex-col items-center gap-10 text-center">
          <h2 className="font-display max-w-2xl text-[clamp(1.75rem,3vw,2.75rem)] text-lumen leading-[1.05] tracking-tight">
            Built for teams shipping on PostHog + Resend
          </h2>

          <div className="relative w-full">
            <LogoMarquee items={marqueeItems} tone="lumen" />
          </div>
        </div>
      </Section>
    </div>
  );
}
