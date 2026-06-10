import {
  BarChart3,
  Boxes,
  Clock,
  CreditCard,
  GitBranch,
  Mail,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ds/button";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";

type UseCase = {
  icon: React.ReactNode;
  title: string;
  description: string;
  href: string;
};

const ICON_SIZE = 20;

const USE_CASES: UseCase[] = [
  {
    icon: <Mail size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Welcome / onboarding",
    description:
      "Greet people when they sign up, then follow up differently depending on whether they've actually tried things.",
    href: "/use-cases/onboarding",
  },
  {
    icon: <CreditCard size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Trials that convert",
    description:
      "Nudge trials toward paying, with the message matched to how much they've really used.",
    href: "/use-cases/trial-conversion",
  },
  {
    icon: <Clock size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Failed payments",
    description:
      "Send friendly reminders when a payment fails — that stop the instant it goes through.",
    href: "/docs/recipes/transactional-emails",
  },
  {
    icon: <Boxes size={ICON_SIZE} strokeWidth={1.5} />,
    title: "The right moment",
    description:
      "ctx.when schedules sends for 9am in the user's timezone, inside your send window — auto-resolved, not guessed.",
    href: "/docs/guides/journeys",
  },
  {
    icon: <GitBranch size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Chaining journeys",
    description:
      "Let one sequence hand off to the next, so flows build on each other instead of repeating.",
    href: "/docs/recipes/lifecycle-journeys",
  },
  {
    icon: <BarChart3 size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Win-back",
    description:
      "Notice when someone goes quiet, run a win-back series, and see who comes back.",
    href: "/use-cases/winback",
  },
];

/**
 * "What you can build" — a 3-up grid of linked use-case cards (every card is
 * a real page or doc), with a tail link to the template gallery.
 */
export function UseCases() {
  return (
    <Section id="use-cases">
      <Reveal>
        <SectionHeading
          eyebrow="Use cases"
          title="The emails every product should send"
          subtitle="The flows behind every good lifecycle programme. Ten of them ship in the scaffold, ready to edit."
        />
      </Reveal>

      <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2 md:mt-16 lg:grid-cols-3">
        {USE_CASES.map((useCase, index) => (
          <Reveal key={useCase.title} delay={(index % 3) * 0.08}>
            <Link
              href={useCase.href}
              className="flex h-full flex-col gap-5 rounded-md border border-white/[0.08] bg-white/[0.015] p-6 transition-colors duration-200 hover:border-white/15"
            >
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.04] text-white">
                {useCase.icon}
              </span>
              <span className="flex flex-col gap-2.5">
                <span className="font-medium font-sans text-white text-xl leading-[1.2] tracking-[-0.02em]">
                  {useCase.title}
                </span>
                <span className="text-base text-white/60 leading-6">
                  {useCase.description}
                </span>
              </span>
            </Link>
          </Reveal>
        ))}
      </div>

      <Reveal delay={0.1} className="mt-10">
        <Button href="/emails" variant="outline" icon>
          Browse the 13 templates they send
        </Button>
      </Reveal>
    </Section>
  );
}
