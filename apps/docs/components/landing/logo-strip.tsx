import { Plug, Puzzle, Webhook } from "lucide-react";
import { type BrandKey, BrandLogo } from "@/components/ds/brand-logo";
import { FeatureCard } from "@/components/ds/card";
import { Squiggle, Sunburst } from "@/components/ds/doodle";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";

/**
 * Integrations + plugins panel — the first stacked panel under the hero, in the
 * neapolitan skin. A single CHOCOLATE (#3a2418) rounded panel framed by the
 * vanilla canvas: a centered serif headline, an arc of real `BrandLogo` marks
 * for the first-party integrations, and a 3-up grid telling the extensibility
 * story — built-in integrations, any custom event, and your own plugins.
 *
 * Server component: paints the brand marks via CSS mask, so they inherit the
 * panel's `lumen` ink.
 */

// The first-party marks we ship — drives the integration arc.
const STACK = [
  "posthog",
  "resend",
  "stripe",
  "railway",
  "typescript",
] as const satisfies readonly BrandKey[];

const ICON = 20;

// The extensibility story: batteries-included, then open all the way down.
const PILLARS = [
  {
    icon: <Plug size={ICON} strokeWidth={1.5} />,
    title: "Built-in integrations",
    description:
      "First-party support for PostHog, Resend, Stripe, and Railway, plus a generic webhook source for everything else. Wire them up in a few lines of TypeScript — no glue code.",
  },
  {
    icon: <Webhook size={ICON} strokeWidth={1.5} />,
    title: "Any custom event",
    description:
      "Fire your own events straight from your app over the SDK or a plain HTTP webhook. Trigger journeys and buckets off anything that happens in your product, not just a fixed list.",
  },
  {
    icon: <Puzzle size={ICON} strokeWidth={1.5} />,
    title: "Build your own plugins",
    description:
      "Swap the email provider, add a channel, or publish a @hogsend/plugin. The provider and webhook-source contracts are open, so the plugin ecosystem grows with you.",
  },
];

export function LogoStrip() {
  return (
    <Section tone="dark">
      <Reveal>
        <SectionHeading
          tone="dark"
          align="center"
          eyebrow="Integrations & plugins"
          title={
            <>
              Plug into your stack,{" "}
              <span className="relative inline-block">
                then extend it
                <Squiggle className="-bottom-3 absolute inset-x-0 mx-auto w-full text-glow" />
              </span>
            </>
          }
          subtitle="PostHog events in, email out — wired together with zero glue code. Fire any custom event from your app, swap the email provider, or publish your own plugin. The engine is built to be extended, not boxed in."
          className="mx-auto"
        />
      </Reveal>

      {/* Arc of first-party integration marks. A pair of raspberry doodle sparks
          punctuate the row, Wispr style. */}
      <div className="relative mt-14 flex flex-wrap items-center justify-center gap-x-10 gap-y-8 sm:gap-x-14">
        <Sunburst className="-top-6 -left-2 absolute size-7 text-glow/80 max-sm:hidden" />
        {STACK.map((brand) => (
          <BrandLogo
            key={brand}
            brand={brand}
            height={30}
            className="text-lumen/80 transition-colors duration-200 hover:text-lumen"
          />
        ))}
        <Sunburst className="-right-1 -bottom-7 absolute size-5 text-glow/70 max-sm:hidden" />
      </div>

      {/* The extensibility story — built-in, custom events, your own plugins. */}
      <div className="mt-16 grid grid-cols-1 gap-5 md:mt-20 md:grid-cols-3">
        {PILLARS.map((pillar, index) => (
          <Reveal key={pillar.title} delay={index * 0.08}>
            <FeatureCard
              tone="dark"
              icon={pillar.icon}
              title={pillar.title}
              description={pillar.description}
              className="h-full"
            />
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
