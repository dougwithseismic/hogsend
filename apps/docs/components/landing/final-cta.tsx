import { ArrowRight } from "lucide-react";
import { Eyebrow } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { DottedCircle } from "@/components/ds/dotted-circle";
import { Reveal } from "@/components/ds/reveal";
import { Section } from "@/components/ds/section";

/**
 * "FinalCta" — the big, airy closing section. A homage to Wispr Flow's "Start
 * flowing" finale: a HUGE light-serif headline ("Start sending") cradled by a
 * dotted-circle amber motif, a Figtree subtitle, and the two bordered buttons
 * (primary lavender → /docs, secondary white → the docs index). Rendered on the
 * open cream canvas with a soft amber aurora for the warm cream-to-glow feel.
 */
export function FinalCta() {
  return (
    <Section tone="cream" id="get-started">
      <Reveal className="relative flex flex-col items-center text-center">
        {/* Soft amber aurora wash + dotted ring, cradling the headline. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -top-10 flex justify-center"
        >
          <div className="aurora h-64 w-[36rem] max-w-full" />
        </div>
        <DottedCircle className="pointer-events-none absolute -top-8 size-56 text-glow/70 md:-top-10 md:size-72" />

        <Eyebrow tone="light" className="relative mb-6">
          READY WHEN YOU ARE
        </Eyebrow>

        <h2 className="relative font-display text-[clamp(3rem,8vw,6rem)] leading-[0.95] tracking-tight text-ink">
          Start sending
        </h2>

        <p className="relative mt-6 max-w-xl font-sans text-base text-ink/65 md:text-lg">
          Lifecycle email as plain TypeScript — journeys and buckets as
          functions, not a canvas. Scaffold an app and ship your first journey
          in an afternoon.
        </p>

        <div className="relative mt-9 flex flex-col items-center gap-3 sm:flex-row">
          <Button href="/docs" variant="accent" icon={<ArrowRight />}>
            Get started
          </Button>
          <Button href="/docs" variant="outline" tone="dark">
            Read the docs
          </Button>
        </div>

        <p className="relative mt-6 font-mono text-xs uppercase tracking-[0.08em] text-ink/50">
          Open source · self-hosted · PostHog + Resend
        </p>
      </Reveal>
    </Section>
  );
}
