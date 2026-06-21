import type { JSX } from "react";
import { Eyebrow } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { AuroraBeam } from "@/components/ds/fx";
import { Reveal } from "@/components/ds/reveal";
import { Section } from "@/components/ds/section";

export function GrowthHero(): JSX.Element {
  return (
    <Section divider={false} containerClassName="container-page pt-32 pb-20">
      <AuroraBeam />
      <div className="relative z-10 flex flex-col items-center text-center">
        <Reveal className="flex flex-col items-center">
          <Eyebrow>Growth metrics · learn it while you use it</Eyebrow>
          <h1 className="mt-6 max-w-4xl font-display font-medium text-[40px] text-white leading-[1.05] tracking-[-0.05em] md:text-[64px] md:leading-[1.0]">
            Start with what you actually know.
          </h1>
          <p className="mt-6 max-w-xl text-base text-white/80 leading-6">
            You don't need to know what ARPA means to begin. Answer a few plain
            questions — what you make, how many customers, what you spend — and
            the tool works out the rest, explains every term, and shows how the
            numbers pull on each other. Every formula runs in your browser;
            nothing leaves the page.
          </p>
        </Reveal>
        <Reveal delay={0.1} className="mt-12 flex flex-col items-center gap-8">
          <div className="flex flex-wrap items-center justify-center gap-4">
            <Button href="#start-here" icon>
              Start here
            </Button>
            <Button href="/docs/getting-started" variant="outline">
              Start building
            </Button>
          </div>
          <p className="max-w-xl text-white/40 font-mono text-xs sm:text-sm leading-6">
            Growth = Acquisition × Activation × Retention × Monetization ×
            Referral
          </p>
        </Reveal>
      </div>
    </Section>
  );
}
