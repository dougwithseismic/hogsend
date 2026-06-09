import { TagPill } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { cn } from "@/lib/cn";

/**
 * Economics — the crimzon pricing-card row, used honestly: a highlighted
 * "Self-hosted · $0 software" card next to the rent models lifecycle tools
 * charge by. Facts only, no competitor bashing — competitor pricing carries
 * a visible verified-date stamp.
 */

type RentCard = {
  name: string;
  chargesBy: string;
  whenYouGrow: string;
};

const RENT_CARDS: RentCard[] = [
  {
    name: "Loops",
    chargesBy: "Subscribed contacts",
    whenYouGrow: "$249/mo at 50k contacts.*",
  },
  {
    name: "Customer.io",
    chargesBy: "Profiles + emails + credits",
    whenYouGrow: "Talk to sales.",
  },
  {
    name: "PostHog Workflows",
    chargesBy: "$0.003/send after 10k free/mo*",
    whenYouGrow: "Per-send creep.",
  },
];

function MicroLabel({ children }: { children: React.ReactNode }) {
  return <span className="eyebrow block text-white/50">{children}</span>;
}

export function Economics({ className }: { className?: string }) {
  return (
    <Section id="economics" className={className}>
      <Reveal>
        <SectionHeading
          eyebrow="Economics"
          title="And nobody meters your contacts"
          subtitle="Rent models are fine prices for software they host. Hogsend's position is different: lifecycle email is a feature of your product, and features live in your repo, not on someone else's meter."
        />
      </Reveal>

      <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2 md:mt-16 lg:grid-cols-4">
        {/* Highlighted card — the self-hosted $0 position. */}
        <Reveal delay={0} className="h-full">
          <div className="relative flex h-full flex-col overflow-hidden rounded-md border border-accent/40 bg-white/[0.02] p-6 transition-colors duration-200">
            {/* Red radial glow rising from the bottom of the card. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  "radial-gradient(90% 70% at 50% 115%, rgba(246,72,56,0.25), transparent 70%)",
              }}
            />
            <div className="relative flex h-full flex-col">
              <div className="flex items-center justify-between gap-3">
                <span className="text-base text-white tracking-[-0.02em]">
                  Hogsend
                </span>
                <TagPill accent>Self-hosted</TagPill>
              </div>

              <div className="mt-5 flex items-baseline gap-2">
                <span className="font-sans text-[40px] text-white leading-[48px] tracking-[-0.02em]">
                  $0
                </span>
                <span className="text-base text-white/60">software</span>
              </div>

              <div className="mt-6 flex flex-col gap-1.5">
                <MicroLabel>Charges by</MicroLabel>
                <span className="text-base text-white/80 leading-6">
                  Nothing — it's your infra.
                </span>
              </div>

              <div className="mt-5 flex flex-col gap-1.5">
                <MicroLabel>When your list grows</MicroLabel>
                <span className="text-base text-white/80 leading-6">
                  Postgres doesn't charge per row.
                </span>
              </div>

              <div className="mt-auto border-hairline-faint border-t pt-5">
                <Button
                  href="/pricing"
                  variant="accent"
                  icon
                  className="w-full justify-center"
                >
                  See pricing
                </Button>
              </div>
            </div>
          </div>
        </Reveal>

        {RENT_CARDS.map((card, index) => (
          <Reveal key={card.name} delay={(index + 1) * 0.08} className="h-full">
            <div
              className={cn(
                "flex h-full flex-col rounded-md border border-white/[0.08] bg-white/[0.015] p-6",
                "transition-colors duration-200 hover:border-white/15",
              )}
            >
              <span className="text-base text-white tracking-[-0.02em]">
                {card.name}
              </span>

              <div className="mt-6 flex flex-col gap-1.5">
                <MicroLabel>Charges by</MicroLabel>
                <span className="text-base text-white/80 leading-6">
                  {card.chargesBy}
                </span>
              </div>

              <div className="mt-5 flex flex-col gap-1.5">
                <MicroLabel>When your list grows</MicroLabel>
                <span className="text-base text-white/70 leading-6">
                  {card.whenYouGrow}
                </span>
              </div>
            </div>
          </Reveal>
        ))}
      </div>

      <Reveal delay={0.1}>
        <p className="mt-6 text-sm text-white/50">
          *List prices at the time of writing — all pricing last checked June
          2026.
        </p>

        <p className="mt-10 max-w-3xl text-base text-white/70 leading-6">
          Hogsend is free to self-host — run it commercially, deploy it for
          clients. It's your Postgres, your event log, your templates, your
          provider account — pg_dump is the exit interview. And if you'd rather
          have it installed for you, that's a week of work, done properly.
        </p>

        <div className="mt-6">
          <Button href="/pricing" variant="outline" icon>
            Pricing & setup
          </Button>
        </div>
      </Reveal>
    </Section>
  );
}
