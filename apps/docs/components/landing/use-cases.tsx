import {
  BarChart3,
  Boxes,
  Clock,
  CreditCard,
  GitBranch,
  Mail,
} from "lucide-react";
import { FeatureCard } from "@/components/ds/card";
import { Squiggle, Star } from "@/components/ds/doodle";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";

type UseCase = {
  icon: React.ReactNode;
  title: string;
  description: string;
};

const ICON_SIZE = 20;

const USE_CASES: UseCase[] = [
  {
    icon: <Mail size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Welcome new users",
    description:
      "Greet people when they sign up, then follow up differently depending on whether they've actually tried things.",
  },
  {
    icon: <CreditCard size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Turn trials into customers",
    description:
      "Nudge trials toward paying, with the message matched to how much they've really used.",
  },
  {
    icon: <Clock size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Recover failed payments",
    description:
      "Send friendly reminders when a payment fails — that stop the instant it goes through.",
  },
  {
    icon: <Boxes size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Catch the right moment",
    description:
      "Spot your power users — or anyone slipping away — the moment it happens, and act on it.",
  },
  {
    icon: <GitBranch size={ICON_SIZE} strokeWidth={1.5} />,
    title: "One thing leads to another",
    description:
      "Let one sequence hand off to the next, so flows build on each other instead of repeating.",
  },
  {
    icon: <BarChart3 size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Win back quiet users",
    description:
      "Notice when someone goes quiet, run a win-back series, and see who comes back.",
  },
];

/**
 * "What you can build" — a STRAWBERRY rounded panel (pastel pink) stacked on the
 * vanilla canvas, showcasing the lifecycle email flows that ship ready to edit.
 * A centered light-serif heading with a hand-drawn raspberry squiggle, then a
 * 3-up grid of white feature cards with chocolate icon chips on the pink surface.
 */
export function UseCases() {
  return (
    <Section tone="teal" id="use-cases">
      <Reveal>
        <SectionHeading
          tone="light"
          align="center"
          eyebrow="WHAT YOU CAN BUILD"
          title={
            <>
              The emails every{" "}
              <span className="relative inline-block">
                product
                <Squiggle className="-bottom-3 absolute inset-x-0 mx-auto w-full text-glow" />
              </span>{" "}
              should send
            </>
          }
          subtitle="Welcome series, trial nudges, win-backs, payment saves — the flows every product needs. Ten ship ready to edit, not blank pages."
          className="mx-auto"
        />
      </Reveal>

      <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 md:mt-16">
        {USE_CASES.map((useCase, index) => (
          <Reveal key={useCase.title} delay={(index % 3) * 0.08}>
            <FeatureCard
              tone="light"
              icon={useCase.icon}
              title={useCase.title}
              description={useCase.description}
              className="h-full"
            />
          </Reveal>
        ))}
      </div>

      <Reveal delay={0.12}>
        <p className="mt-12 flex items-center justify-center gap-2 text-center font-mono text-[0.6875rem] text-ink/55 uppercase tracking-[0.08em] md:mt-16">
          <Star className="size-4 text-glow" />
          Defined in code · versioned in git · observed in Studio
        </p>
      </Reveal>
    </Section>
  );
}
