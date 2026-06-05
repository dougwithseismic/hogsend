import { GitFork, Server, ShieldCheck } from "lucide-react";
import { Star } from "@/components/ds/doodle";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";

type Pillar = {
  icon: React.ReactNode;
  title: string;
  description: string;
};

const ICON_SIZE = 22;

const PILLARS: Pillar[] = [
  {
    icon: <ShieldCheck size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Your data stays yours",
    description: "Everything runs in your own Postgres and your own infra.",
  },
  {
    icon: <Server size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Deploy anywhere",
    description:
      "Docker compose locally, one-click Railway, or bring your own host.",
  },
  {
    icon: <GitFork size={ICON_SIZE} strokeWidth={1.5} />,
    title: "No vendor lock-in",
    description:
      "Plain TypeScript and an open engine. Extend, patch, or eject anytime.",
  },
];

/**
 * "Yours to run" — open cream section. The left column states the open-source /
 * self-hosted positioning with a light-serif heading; the right column lists the
 * three pillars, each with an ink icon chip. Restyled to the Wispr Flow cream
 * system (§6.10): tokens only, serif heading, an amber doodle accent.
 */
export function SelfHosted() {
  return (
    <Section tone="cream" id="self-hosted">
      <div className="grid grid-cols-1 gap-12 lg:grid-cols-2 lg:gap-16">
        <Reveal>
          <div className="relative">
            {/* Amber doodle accent punctuating the serif heading. */}
            <Star className="absolute -top-2 -left-1 size-6 text-glow lg:-top-4 lg:-left-3" />
            <SectionHeading
              tone="cream"
              eyebrow="YOURS TO RUN"
              title="Self-hosted, open source, no lock-in"
              subtitle="Run it on your own infrastructure. Your data never leaves your stack, and there's no per-contact pricing to grow into."
            />
          </div>
        </Reveal>

        <Reveal delay={0.1} className="flex flex-col gap-8">
          {PILLARS.map((pillar) => (
            <div key={pillar.title} className="flex gap-4">
              <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border-2 border-ink bg-ink text-lumen">
                {pillar.icon}
              </span>
              <div className="flex flex-col gap-1.5 pt-0.5">
                <h3 className="font-display text-xl leading-[1.2] tracking-tight text-ink">
                  {pillar.title}
                </h3>
                <p className="font-sans text-sm leading-relaxed text-ink/65 md:text-base">
                  {pillar.description}
                </p>
              </div>
            </div>
          ))}
        </Reveal>
      </div>
    </Section>
  );
}
