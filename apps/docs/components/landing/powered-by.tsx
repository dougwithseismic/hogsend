import { ArrowUpRight, Clock, RefreshCw, Server } from "lucide-react";
import { Eyebrow } from "@/components/ds/badge";
import { BrandLogo } from "@/components/ds/brand-logo";
import { Button } from "@/components/ds/button";
import { Star } from "@/components/ds/doodle";
import { Reveal } from "@/components/ds/reveal";
import { Section } from "@/components/ds/section";

type Pillar = {
  icon: React.ReactNode;
  title: string;
  description: string;
};

const ICON_SIZE = 22;

const PILLARS: Pillar[] = [
  {
    icon: <Clock size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Survives deploys & restarts",
    description:
      "A long ctx.sleep keeps running across a deploy and resumes days later, exactly where it left off.",
  },
  {
    icon: <RefreshCw size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Automatic retries & timeouts",
    description:
      "Failed steps retry and waits expire on their own — durability you don't have to hand-roll.",
  },
  {
    icon: <Server size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Self-host it, or use Hatchet Cloud",
    description:
      "Run Hatchet-Lite next to your app, or point at Hatchet Cloud. Same engine either way.",
  },
];

/**
 * PoweredByHatchet — the "Powered by Hatchet" dark rounded panel stacked on the
 * cream canvas (Wispr Flow homage, spec §6.6). Leads with the real Hatchet
 * wordmark tinted to lumen, a lavender-square eyebrow, and a light-serif h2,
 * states plainly that every journey runs on Hatchet's durable execution engine,
 * then lists three pillars with amber-tinted icon chips and links out to
 * hatchet.run. Hogsend is built on Hatchet for durability — not a reimplementation.
 */
export function PoweredByHatchet() {
  return (
    <Section tone="dark">
      <Reveal className="flex max-w-3xl flex-col items-start">
        <BrandLogo brand="hatchet" height={56} className="text-lumen" />

        <Eyebrow tone="dark" className="mt-8 mb-5">
          POWERED BY
        </Eyebrow>

        <h2 className="font-display flex items-start gap-3 text-[clamp(2.25rem,4.5vw,4rem)] leading-[1.0] tracking-tight text-lumen">
          Durable execution, by Hatchet
          <Star className="mt-2 size-6 shrink-0" />
        </h2>

        <p className="mt-5 max-w-2xl font-sans text-base text-lumen/65 md:text-lg">
          Every journey runs on{" "}
          <a
            href="https://hatchet.run"
            target="_blank"
            rel="noreferrer"
            className="text-lumen underline decoration-glow/50 underline-offset-4 transition-colors hover:decoration-glow"
          >
            Hatchet
          </a>
          , the durable execution engine underneath Hogsend. It's what lets a
          long ctx.sleep survive a deploy and resume two days later exactly
          where it left off — with automatic retries and timeouts handled for
          you. We didn't reimplement durability. We built on the engine that
          does it for real.
        </p>
      </Reveal>

      <Reveal
        delay={0.1}
        className="mt-14 grid grid-cols-1 gap-8 md:mt-20 md:grid-cols-3"
      >
        {PILLARS.map((pillar) => (
          <div key={pillar.title} className="flex gap-4">
            <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl border-2 border-glow/25 bg-glow/10 text-glow">
              {pillar.icon}
            </span>
            <div className="flex flex-col gap-1.5 pt-0.5">
              <h3 className="font-display text-xl leading-[1.2] tracking-tight text-lumen">
                {pillar.title}
              </h3>
              <p className="font-sans text-sm leading-relaxed text-lumen/60 md:text-base">
                {pillar.description}
              </p>
            </div>
          </div>
        ))}
      </Reveal>

      <Reveal delay={0.2} className="mt-14 md:mt-16">
        <Button
          href="https://hatchet.run"
          external
          variant="outline"
          tone="light"
          icon={
            <ArrowUpRight
              size={18}
              strokeWidth={2}
              className="size-[1.05em] shrink-0"
              aria-hidden="true"
            />
          }
        >
          Learn about Hatchet
        </Button>
      </Reveal>
    </Section>
  );
}
