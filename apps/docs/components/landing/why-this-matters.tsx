import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { cn } from "@/lib/cn";

/**
 * WhyThisMatters — the stakes section: three external industry benchmarks for
 * lifecycle email, each attributed inline to its source. Sets up the argument
 * that lifecycle is one of the first systems a team should set up, not the one
 * left on the backlog.
 *
 * HARD RULE: every number here is an external benchmark from a named third
 * party (Bain, Epsilon, Harvard Business Review). The source caption beneath
 * each stat is REQUIRED — these are industry figures, never Hogsend's own data.
 */

type Benchmark = {
  value: string;
  claim: string;
  source: string;
};

const BENCHMARKS: Benchmark[] = [
  {
    value: "25–95%",
    claim: "more profit from a 5% lift in retention",
    source: "Bain & Company",
  },
  {
    value: "~2×",
    claim: "the engagement of behaviour-triggered email vs. batch sends",
    source: "Epsilon",
  },
  {
    value: "5–25×",
    claim: "what acquiring a new customer costs vs. keeping one",
    source: "Harvard Business Review",
  },
];

export function WhyThisMatters({ className }: { className?: string }) {
  return (
    <Section className={className}>
      <Reveal>
        <SectionHeading
          eyebrow="Why it's worth doing well"
          title="Lifecycle email is the highest-leverage system most teams skip"
          subtitle="It is one of the first things you should set up and the one most often left on the backlog. The returns are well documented."
        />

        <div className="mt-12 flex flex-col gap-8 sm:flex-row sm:gap-0">
          {BENCHMARKS.map((benchmark, index) => (
            <div
              key={benchmark.source}
              className={cn(
                "flex flex-col gap-2 sm:flex-1 sm:px-10 first:sm:pl-0 last:sm:pr-0",
                index > 0 && "sm:border-white/10 sm:border-l",
              )}
            >
              <span className="font-sans text-[40px] text-white leading-[48px] tracking-[-0.02em]">
                {benchmark.value}
              </span>
              <span className="text-base text-white/60 leading-6">
                {benchmark.claim}
              </span>
              <span className="eyebrow mt-1 text-white/40">
                {benchmark.source}
              </span>
            </div>
          ))}
        </div>
      </Reveal>
    </Section>
  );
}
