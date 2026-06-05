import { Eyebrow } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { Squiggle } from "@/components/ds/doodle";
import { FaqAccordion } from "@/components/ds/faq";
import { Reveal } from "@/components/ds/reveal";
import { Section } from "@/components/ds/section";
import { FAQ_ITEMS } from "@/lib/faq-data";

export function Faq() {
  return (
    <Section tone="cream" id="faq">
      <div className="grid gap-12 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-16">
        <Reveal className="lg:sticky lg:top-28 lg:self-start">
          <Eyebrow tone="light" className="mb-5">
            FAQ
          </Eyebrow>
          <h2 className="relative max-w-md font-display text-[clamp(2.25rem,4.5vw,4rem)] leading-[1.0] tracking-tight text-ink">
            Questions,{" "}
            <span className="relative inline-block">
              answered
              <Squiggle className="absolute -bottom-2 left-0 h-3 w-full text-glow" />
            </span>
          </h2>
          <p className="mt-6 max-w-sm font-sans text-base text-ink/65 md:text-lg">
            Still curious? The docs go deeper on every journey, bucket, and
            send.
          </p>
          <div className="mt-7">
            <Button href="/docs" variant="accent" icon>
              Read the docs
            </Button>
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <FaqAccordion items={FAQ_ITEMS} tone="light" />
        </Reveal>
      </div>
    </Section>
  );
}
