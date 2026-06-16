import {
  ArrowRight,
  Check,
  Hourglass,
  Repeat,
  RotateCcw,
  ShoppingBag,
  TrendingUp,
  UserMinus,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { JSX, ReactNode } from "react";
import { Eyebrow, PillBadge, TagPill } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { Card, FeatureCard } from "@/components/ds/card";
import { Stat } from "@/components/ds/decor";
import { AuroraBeam, DotGrid } from "@/components/ds/fx";
import { ProcessSteps } from "@/components/ds/process";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { CONTACT_EMAIL } from "@/lib/site";

// Bare label — the root layout template appends " — Hogsend".
export const metadata: Metadata = {
  title: "Done-for-you lifecycle email for PostHog-native startups",
  description:
    "I find the moments where your funnel loses customers — stalled trials, cancels, one-and-done buyers — build the emails that recover them, and run the whole program for you. Setup from $2,300/week, then a managed retainer from $1,000/month.",
};

const MAILTO = `mailto:${CONTACT_EMAIL}`;

/* ------------------------------------------------------------------------ */
/*  Copy data                                                                */
/* ------------------------------------------------------------------------ */

const MOMENTS: Array<{ icon: ReactNode; moment: string; recovery: string }> = [
  {
    icon: <Hourglass className="size-4" strokeWidth={1.75} />,
    moment: "A trial stalls before it activates",
    recovery: "a nudge back to the aha-moment",
  },
  {
    icon: <UserMinus className="size-4" strokeWidth={1.75} />,
    moment: "A customer cancels",
    recovery: "a win-back built on why they left",
  },
  {
    icon: <ShoppingBag className="size-4" strokeWidth={1.75} />,
    moment: "A first order lands",
    recovery: "the arc to a second",
  },
];

const UNLOCK_CARDS: Array<{
  icon: ReactNode;
  title: string;
  description: string;
}> = [
  {
    icon: <TrendingUp className="size-5" strokeWidth={1.5} />,
    title: "More trials convert",
    description:
      "A trial that stalls before the aha-moment usually just goes quiet and expires. The program catches it and sends the nudge back to the action that makes them stay — while they're still deciding.",
  },
  {
    icon: <RotateCcw className="size-5" strokeWidth={1.5} />,
    title: "Churned customers come back",
    description:
      "When someone cancels, they get a win-back built around why people actually leave your product — not a generic “we miss you.” Some of them return.",
  },
  {
    icon: <Repeat className="size-5" strokeWidth={1.5} />,
    title: "First-time buyers buy again",
    description:
      "A first purchase is the start, not the win. The program runs the arc that turns it into a habit and a second order, instead of letting them quietly drift.",
  },
];

const METHOD_STEPS: Parameters<typeof ProcessSteps>[0]["steps"] = [
  {
    n: "01",
    title: "I find where you're leaking",
    description:
      "I learn your product and your funnel, and pin down the exact moments where customers stall, cancel, or drift away — the ones worth an email.",
  },
  {
    n: "02",
    title: "I build the program around them",
    description:
      "I design and write the emails and the timing for each moment, tailored to your product. Done for you — there's no tool for you to learn and no brief for you to write.",
  },
  {
    n: "03",
    title: "I run it, and keep it working",
    description:
      "It sends from your own accounts to real customers, and I keep it monitored and improving as your product and funnel change. You stay focused on the product.",
  },
];

const SETUP_ITEMS: string[] = [
  "I learn your product and map the moments in your funnel that are losing you customers.",
  "I design and write the emails and sequences that recover them.",
  "I get it sending from your own account, on your domain — set up end to end.",
  "Your first revenue-recovery journeys go live against your real customers.",
  "You can see every send and result, without touching the build.",
];

const RETAINER_ITEMS: string[] = [
  "Ongoing email and sequence work as your product and funnel change.",
  "Monitoring, so a stalled or broken send gets caught — not discovered months later.",
  "The program keeps improving instead of going stale.",
];

const OWNERSHIP_TAGS: string[] = [
  "Your accounts",
  "No per-contact billing",
  "Yours to keep",
];

/* ------------------------------------------------------------------------ */
/*  Shared bits                                                              */
/* ------------------------------------------------------------------------ */

/** Accent-bulleted checklist — the pricing-page list treatment. */
function CheckList({ items }: { items: string[] }): JSX.Element {
  return (
    <ul className="mt-4 flex flex-col gap-3">
      {items.map((item) => (
        <li
          key={item}
          className="flex items-start gap-3 text-base text-white/80 leading-6"
        >
          <Check
            aria-hidden="true"
            className="mt-1 size-4 shrink-0 text-accent"
            strokeWidth={2}
          />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

/** Hero companion — the funnel moments where revenue leaks, and the fix. */
function MomentsCard(): JSX.Element {
  return (
    <div className="glass-panel relative overflow-hidden rounded-xl p-6">
      {/* Faint accent glow rising from the bottom edge. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(80% 60% at 50% 100%, rgba(246, 72, 56, 0.16), transparent 70%)",
        }}
      />
      <div className="relative">
        <p className="eyebrow text-white/50">Where you're losing people</p>
        <ol className="mt-5 flex flex-col gap-3">
          {MOMENTS.map((m) => (
            <li
              key={m.moment}
              className="flex items-start gap-3.5 rounded-md border border-white/[0.08] bg-white/[0.02] px-4 py-3.5"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-md border border-white/[0.08] bg-white/[0.04] text-accent">
                {m.icon}
              </span>
              <div className="min-w-0">
                <p className="text-sm text-white">{m.moment}</p>
                <p className="mt-0.5 flex items-center gap-1.5 text-white/50 text-xs leading-5">
                  <ArrowRight
                    aria-hidden="true"
                    className="size-3 shrink-0 text-accent"
                    strokeWidth={2}
                  />
                  {m.recovery}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/*  Page                                                                     */
/* ------------------------------------------------------------------------ */

export default function ServicePage(): JSX.Element {
  return (
    <main className="flex flex-1 flex-col">
      {/* ---- Hero: the problem + the fix ------------------------------ */}
      <Section divider={false} containerClassName="container-page pt-32 pb-20">
        <AuroraBeam className="opacity-60" />
        <div className="relative z-10 grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)] lg:gap-16">
          <Reveal className="flex flex-col">
            <PillBadge className="mb-6 self-start">Done for you</PillBadge>
            <h1 className="max-w-2xl font-display text-[36px] text-white leading-[1.15] tracking-[-0.02em] md:text-[44px] md:leading-[52px]">
              Win back the customers your funnel is quietly losing
            </h1>
            <p className="mt-6 max-w-xl text-base text-white/70 leading-7">
              Every product loses customers at the same few moments — a trial
              that stalls, a subscription that cancels, a first purchase that
              never becomes a second. Each one is recoverable with the right
              email at the right time, but only if something&apos;s watching for
              it. I find those moments in your funnel, build the emails that
              recover them, and run the whole program for you — so the revenue
              you&apos;re leaving on the table starts coming back, without you
              building or babysitting a thing.
            </p>
            <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-4">
              <Button href={MAILTO} variant="accent" icon>
                Email doug@withseismic.com
              </Button>
              <Button href="/docs/getting-started" variant="outline">
                Read the docs
              </Button>
            </div>
            <p className="eyebrow mt-6 text-white/50">
              Setup from $2,300/week · Managed retainer from $1,000/month · No
              per-contact billing
            </p>
          </Reveal>

          <Reveal delay={0.12}>
            <MomentsCard />
          </Reveal>
        </div>
      </Section>

      {/* ---- Stat row: the facts, up front ---------------------------- */}
      <Section>
        <Reveal>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-10 md:grid-cols-4">
            <Stat value="$2,300" label="Setup, billed weekly" />
            <Stat value="$1,000+" label="Managed, per month" />
            <Stat value="Done for you" label="Nothing for you to build" />
            <Stat value="$0" label="Per-contact fees" />
          </dl>
        </Reveal>
      </Section>

      {/* ---- The unlock: what it does for the business ---------------- */}
      <Section id="unlock">
        <SectionHeading
          eyebrow="The unlock"
          title="What this does for your business"
          subtitle="Lifecycle email isn't about sending more. It's about catching the handful of moments where you're losing people, and turning some of them back into revenue."
        />

        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {UNLOCK_CARDS.map((card, index) => (
            <Reveal key={card.title} delay={index * 0.08}>
              <FeatureCard
                icon={card.icon}
                title={card.title}
                description={card.description}
                className="h-full"
              />
            </Reveal>
          ))}
        </div>
      </Section>

      {/* ---- How I work: find, build, run ----------------------------- */}
      <Section id="how">
        <Reveal>
          <ProcessSteps
            eyebrow="How I work"
            title="I find the leaks, build the fix, and run it"
            subtitle="This isn't a template you fill in. Every product loses customers in its own places, so every program I build is shaped to the product in front of me."
            steps={METHOD_STEPS}
          />
        </Reveal>
      </Section>

      {/* ---- Pricing: the setup + the retainer ------------------------ */}
      <Section id="pricing">
        <SectionHeading
          eyebrow="How it's priced"
          title="Set it up, then keep it running"
          subtitle="A scoped build first, then a managed retainer — both billed simply, with no per-contact meter."
        />

        <div className="mt-12 grid items-stretch gap-6 md:grid-cols-2">
          {/* The setup — the accent-highlighted entry point. */}
          <Reveal delay={0.08}>
            <Card className="relative flex h-full flex-col overflow-hidden border-accent/40 p-8">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0"
                style={{
                  background:
                    "radial-gradient(90% 55% at 50% 100%, rgba(246, 72, 56, 0.22), transparent 70%)",
                }}
              />
              <div className="relative flex flex-1 flex-col">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-base text-white">The setup</span>
                  <TagPill accent>Find + build</TagPill>
                </div>

                <div className="mt-5 flex items-baseline gap-1.5">
                  <span className="font-display text-[40px] text-white leading-[48px]">
                    $2,300
                  </span>
                  <span className="text-base text-white/60">/per week</span>
                </div>

                <p className="mt-4 text-base text-white/70 leading-6">
                  A scoped engagement — usually a couple of weeks. It&apos;s
                  where your program gets found, designed, and built, not just
                  switched on.
                </p>

                <p className="eyebrow mt-8 text-white/50">
                  What the engagement covers
                </p>
                <CheckList items={SETUP_ITEMS} />

                <p className="mt-6 text-base text-white/60 leading-6">
                  By the end you have a lifecycle program working against your
                  real customers — not a deck describing one.
                </p>

                <div className="mt-auto border-white/[0.08] border-t pt-6">
                  <Button href={MAILTO} variant="accent" icon>
                    Email doug@withseismic.com
                  </Button>
                  <p className="eyebrow mt-6 text-white/50">
                    Scoped · billed weekly · yours to keep
                  </p>
                </div>
              </div>
            </Card>
          </Reveal>

          {/* The retainer — keeping it working. */}
          <Reveal delay={0.16}>
            <Card className="relative flex h-full flex-col overflow-hidden p-8">
              <div className="relative flex flex-1 flex-col">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-base text-white">The retainer</span>
                  <TagPill>Keep it running</TagPill>
                </div>

                <div className="mt-5 flex items-baseline gap-1.5">
                  <span className="font-display text-[40px] text-white leading-[48px]">
                    $1,000
                  </span>
                  <span className="text-base text-white/60">/per month</span>
                </div>

                <p className="mt-4 text-base text-white/70 leading-6">
                  Lifecycle programs drift — your product changes, a moment
                  shifts, a send quietly stalls. The retainer keeps it working,
                  and keeps recovering more over time instead of going stale.
                </p>

                <p className="eyebrow mt-8 text-white/50">What it covers</p>
                <CheckList items={RETAINER_ITEMS} />

                <p className="mt-6 text-base text-white/60 leading-6">
                  Typically $1,000–3,000/month, depending on how much is
                  changing.
                </p>

                <div className="mt-auto border-white/[0.08] border-t pt-6">
                  <Button href={MAILTO} variant="outline" icon>
                    Email doug@withseismic.com
                  </Button>
                  <p className="eyebrow mt-6 text-white/50">
                    Monthly · scales with what&apos;s changing
                  </p>
                </div>
              </div>
            </Card>
          </Reveal>
        </div>
      </Section>

      {/* ---- Ownership: the no-lock-in band --------------------------- */}
      <Section id="ownership">
        <Reveal>
          <Card className="p-8 md:p-10">
            <div className="flex flex-col gap-8 md:flex-row md:items-center md:justify-between">
              <div className="max-w-2xl">
                <Eyebrow className="mb-3">No lock-in</Eyebrow>
                <h2 className="font-display text-[24px] text-white leading-[1.2] tracking-[-0.02em] md:text-[28px]">
                  It runs on your accounts, and you keep all of it
                </h2>
                <p className="mt-4 text-base text-white/70 leading-7">
                  No platform to get locked into, and no per-contact bill that
                  grows as your list does. If we ever stop working together,
                  nothing has to move off anything — it was always your accounts
                  and your program.
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2 md:flex-col md:items-end">
                {OWNERSHIP_TAGS.map((tag) => (
                  <TagPill key={tag}>{tag}</TagPill>
                ))}
              </div>
            </div>
          </Card>
        </Reveal>
      </Section>

      {/* ---- Closing CTA ---------------------------------------------- */}
      <Section id="start">
        <DotGrid />
        <div className="relative z-10 flex flex-col items-center text-center">
          <Reveal className="flex flex-col items-center">
            <Eyebrow className="mb-4">Get started</Eyebrow>
            <h2 className="max-w-2xl font-display text-[32px] text-white leading-[1.2] tracking-[-0.02em] md:text-[40px] md:leading-[48px]">
              Tell me where you&apos;re losing people
            </h2>
            <p className="mt-5 max-w-2xl text-base text-white/70 leading-7">
              Email me with what your product does and where you think the
              funnel leaks. The first conversation is about your product, not a
              feature list — from there I&apos;ll scope the setup.
            </p>
          </Reveal>
          <Reveal delay={0.1} className="mt-10">
            <Button href={MAILTO} variant="accent" icon>
              Email doug@withseismic.com
            </Button>
          </Reveal>
          <Reveal delay={0.16}>
            <p className="mt-6 text-sm text-white/50">
              Would rather run Hogsend yourself? Genuinely fine —{" "}
              <Link
                href="/docs/getting-started"
                className="text-white/70 underline-offset-2 transition-colors hover:text-white hover:underline"
              >
                start with the docs
              </Link>
              , you owe me nothing.
            </p>
          </Reveal>
        </div>
      </Section>
    </main>
  );
}
