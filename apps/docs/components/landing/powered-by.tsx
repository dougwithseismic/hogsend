import { ArrowUpRight, Clock, RefreshCw, Server } from "lucide-react";
import { Eyebrow } from "@/components/ds/badge";
import { BrandLogo } from "@/components/ds/brand-logo";
import { AuroraBeam } from "@/components/ds/fx";
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
 * PoweredByHatchet — dark "Powered by Hatchet" section. Leads with the real
 * Hatchet wordmark at large size over an AuroraBeam, states plainly that every
 * journey runs on Hatchet's durable execution engine, then lists three pillars
 * (mirroring self-hosted.tsx) and links out to hatchet.run. Hogsend is built on
 * Hatchet for durability — not a reimplementation.
 */
export function PoweredByHatchet() {
  return (
    <Section tone="dark">
      <AuroraBeam className="absolute inset-0 -z-0" />

      <div className="relative z-10">
        <Reveal className="flex max-w-3xl flex-col items-start">
          <BrandLogo brand="hatchet" height={56} className="text-white" />

          <Eyebrow tone="dark" className="mt-8 mb-5">
            POWERED BY
          </Eyebrow>

          <h2 className="font-display text-3xl leading-[1.08] text-white md:text-5xl">
            Durable execution, by Hatchet
          </h2>

          <p className="mt-5 max-w-2xl text-base text-white/60 md:text-lg">
            Every journey runs on{" "}
            <a
              href="https://hatchet.run"
              target="_blank"
              rel="noreferrer"
              className="text-white underline decoration-white/30 underline-offset-4 transition-colors hover:decoration-white"
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
              <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/5 text-white">
                {pillar.icon}
              </span>
              <div className="flex flex-col gap-1.5 pt-0.5">
                <h3 className="font-display text-xl leading-[1.2] text-white">
                  {pillar.title}
                </h3>
                <p className="text-sm leading-relaxed text-white/60 md:text-base">
                  {pillar.description}
                </p>
              </div>
            </div>
          ))}
        </Reveal>

        <Reveal delay={0.2} className="mt-14 md:mt-16">
          <a
            href="https://hatchet.run"
            target="_blank"
            rel="noreferrer"
            className="group inline-flex items-center gap-2 rounded-md border border-white/15 bg-white/5 px-5 py-3 text-sm font-medium text-white transition-colors hover:border-white/30 hover:bg-white/10"
          >
            Learn about Hatchet
            <ArrowUpRight
              size={18}
              strokeWidth={1.5}
              className="transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
            />
          </a>
        </Reveal>
      </div>
    </Section>
  );
}
