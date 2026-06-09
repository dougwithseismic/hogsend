import { ArrowUpRight, Clock, RefreshCw, Server } from "lucide-react";
import { BrandLogo } from "@/components/ds/brand-logo";
import { AuroraBeam } from "@/components/ds/fx";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";

type Pillar = {
  icon: React.ReactNode;
  title: string;
  description: string;
};

const ICON_SIZE = 20;

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
 * PoweredByHatchet — credits the durable execution engine underneath every
 * journey. Hatchet wordmark over a red aurora, plain statement of what
 * durability buys you, three glass pillar cards, and an outlink to
 * hatchet.run. Hogsend is built on Hatchet — not a reimplementation.
 */
export function PoweredByHatchet() {
  return (
    <Section id="hatchet">
      <AuroraBeam className="-z-0 absolute inset-0 opacity-60" />

      <div className="relative z-10">
        <Reveal className="flex flex-col items-start">
          <BrandLogo brand="hatchet" height={40} className="mb-10 text-white" />

          <SectionHeading
            eyebrow="Powered by Hatchet"
            title="Durable execution, by Hatchet"
            subtitle={
              <>
                Every journey runs on{" "}
                <a
                  href="https://hatchet.run"
                  target="_blank"
                  rel="noreferrer"
                  className="text-white underline decoration-white/30 underline-offset-4 transition-colors hover:decoration-white"
                >
                  Hatchet
                </a>
                , the durable execution engine underneath Hogsend. It's what
                lets a long ctx.sleep survive a deploy and resume two days later
                exactly where it left off — retries and timeouts handled for
                you. We didn't reimplement durability. We built on the engine
                that does it for real.
              </>
            }
          />
        </Reveal>

        <div className="mt-14 grid grid-cols-1 gap-5 md:grid-cols-3">
          {PILLARS.map((pillar, index) => (
            <Reveal
              key={pillar.title}
              delay={(index % 3) * 0.08}
              className="rounded-md border border-hairline-faint bg-white/[0.015] p-8 transition-colors hover:border-white/15"
            >
              <span aria-hidden="true" className="block text-white">
                {pillar.icon}
              </span>
              <h3 className="mt-10 font-medium font-sans text-base text-white tracking-[-0.02em]">
                {pillar.title}
              </h3>
              <p className="mt-3 text-sm text-white/60 leading-[1.5]">
                {pillar.description}
              </p>
            </Reveal>
          ))}
        </div>

        <Reveal delay={0.16} className="mt-12">
          <a
            href="https://hatchet.run"
            target="_blank"
            rel="noreferrer"
            className="group inline-flex items-center gap-2 font-medium text-base text-white tracking-[-0.02em]"
          >
            Learn about Hatchet
            <ArrowUpRight
              size={18}
              strokeWidth={1.5}
              className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
            />
          </a>
        </Reveal>
      </div>
    </Section>
  );
}
