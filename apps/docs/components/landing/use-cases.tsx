import {
  BarChart3,
  Boxes,
  Clock,
  CreditCard,
  GitBranch,
  Mail,
} from "lucide-react";
import { Button } from "@/components/ds/button";
import { FeatureCard } from "@/components/ds/card";
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
 * "What you can build" — light section showcasing the lifecycle email flows
 * that ship ready to edit. A 3-up grid of feature cards with corner ticks.
 */
export function UseCases() {
  return (
    <Section tone="light" id="use-cases">
      <Reveal>
        <SectionHeading
          tone="light"
          eyebrow="WHAT YOU CAN BUILD"
          title="The emails every product should send"
          subtitle="Welcome series, trial nudges, win-backs, payment saves — the lifecycle flows every product needs, each one a few primitives combined. It's a cookbook: pick the outcome, reach for the pieces."
        />
      </Reveal>

      <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 md:mt-16">
        {USE_CASES.map((useCase, index) => (
          <Reveal key={useCase.title} delay={(index % 3) * 0.08}>
            <FeatureCard
              tone="light"
              ticks
              icon={useCase.icon}
              title={useCase.title}
              description={useCase.description}
              className="h-full"
            />
          </Reveal>
        ))}
      </div>

      <Reveal delay={0.1}>
        <div className="mt-10 flex justify-center">
          <Button href="/recipes" variant="accent" icon>
            Browse the cookbook
          </Button>
        </div>
      </Reveal>
    </Section>
  );
}
