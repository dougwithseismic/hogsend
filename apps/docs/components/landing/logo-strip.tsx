import { type BrandKey, BrandLogo } from "@/components/ds/brand-logo";
import { Sunburst } from "@/components/ds/doodle";
import { Section, SectionHeading } from "@/components/ds/section";

/**
 * Integrations panel — the first stacked panel under the hero, in the neapolitan
 * skin. A single CHOCOLATE (#3a2418) rounded panel framed by the vanilla canvas:
 * a centered serif headline, an arc of real `BrandLogo` marks tinted for the
 * dark panel, and a row of rounded-full bordered platform pills (the PostHog in
 * / Resend out story).
 *
 * Server component: paints the brand marks via CSS mask, so they inherit the
 * panel's `lumen` ink.
 */

// The stack we wire together — drives the integration arc + the platform pills.
const STACK = [
  "posthog",
  "resend",
  "stripe",
  "railway",
  "typescript",
] as const satisfies readonly BrandKey[];

// The platform "pills" — the channels Hogsend speaks to out of the box.
const PLATFORMS = ["PostHog", "Resend", "Stripe", "Webhooks"] as const;

export function LogoStrip() {
  return (
    <Section tone="dark">
      <SectionHeading
        tone="dark"
        align="center"
        eyebrow="Integrations"
        title="Works in every part of your stack"
        subtitle="PostHog in, Resend out — events, journeys, and sends wired together in plain TypeScript, no glue code."
        className="mx-auto"
      />

      {/* Arc of integration marks, tinted for the dark panel. A pair of raspberry
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
  );
}
