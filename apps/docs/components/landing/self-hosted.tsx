import { GitFork, Server, ShieldCheck } from "lucide-react";
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
 * "Yours to run" — light section. Left column states the open-source /
 * self-hosted positioning; right column lists three pillars with line icons.
 */
export function SelfHosted() {
  return (
    <Section tone="light" id="self-hosted">
      <div className="grid grid-cols-1 gap-12 lg:grid-cols-2 lg:gap-16">
        <Reveal>
          <SectionHeading
            tone="light"
            eyebrow="YOURS TO RUN"
            title="Self-hosted, open source, no lock-in"
            subtitle="Run it on your own infrastructure. Your data never leaves your stack, and there's no per-contact pricing to grow into."
          />
        </Reveal>

        <Reveal delay={0.1} className="flex flex-col gap-8">
          {PILLARS.map((pillar) => (
            <div key={pillar.title} className="flex gap-4">
              <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-black/[0.08] bg-black/[0.03] text-black">
                {pillar.icon}
              </span>
              <div className="flex flex-col gap-1.5 pt-0.5">
                <h3 className="font-display text-xl leading-[1.2] text-black">
                  {pillar.title}
                </h3>
                <p className="text-sm leading-relaxed text-black/60 md:text-base">
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
