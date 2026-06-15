import {
  Boxes,
  Clock,
  CreditCard,
  Gift,
  Mail,
  MessageSquare,
  Trophy,
  Undo2,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { Clip } from "@/components/clips/clip";
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
      "Greet people the moment they sign up, then branch on whether they've actually tried anything yet.",
    href: "/use-cases/onboarding",
  },
  {
    icon: <Zap size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Activation nudge",
    description:
      "Drive the one action most correlated with sticking around — before the trial clock runs out.",
    href: "/use-cases/onboarding",
  },
  {
    icon: <Boxes size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Feature adoption",
    description:
      "Most churn is a feature users never found. Surface the one they're missing.",
    href: "/docs/recipes/lifecycle-journeys",
  },
  {
    icon: <CreditCard size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Trials that convert",
    description:
      "Match the ask to how much they've really used, not the day on the calendar.",
    href: "/use-cases/trial-conversion",
  },
  {
    icon: <Clock size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Failed payments",
    description:
      "Involuntary churn is the biggest leak you can plug. Remind, and stop the moment it clears.",
    href: "/docs/recipes/transactional-emails",
  },
  {
    icon: <Undo2 size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Win-back",
    description:
      "You already paid to acquire them once — winning them back costs a fraction of a new signup.",
    href: "/use-cases/winback",
  },
  {
    icon: <Trophy size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Milestones",
    description:
      "Celebrate progress and reinforce the habit at the moments value actually lands.",
    href: "/docs/guides/journeys",
  },
  {
    icon: <Gift size={ICON_SIZE} strokeWidth={1.5} />,
    title: "Referral ask",
    description:
      "Ask for the referral at the moment value lands, when they're most likely to say yes.",
    href: "/docs/recipes/lifecycle-journeys",
  },
  {
    icon: <MessageSquare size={ICON_SIZE} strokeWidth={1.5} />,
    title: "NPS / feedback",
    description:
      "Catch churn risk early and feed it straight back to the product.",
    href: "/docs/recipes/lifecycle-journeys",
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

      <Reveal delay={0.1} className="mt-12 md:mt-16">
        <Clip
          clip="journey-onboarding"
          title="An onboarding journey — welcome, a durable wait for the first project, then a branch, fanning every step back to PostHog"
        />
      </Reveal>

      <Reveal delay={0.1} className="mt-10">
        <Button href="/emails" variant="outline" icon>
          Browse the 13 templates they send
        </Button>
      </Reveal>
    </Section>
  );
}
