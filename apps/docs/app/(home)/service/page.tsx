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
import { ServiceInquiryForm } from "@/components/service/inquiry-form";
import { SERVICE_LADDER, type ServiceTier } from "@/lib/pricing";

// Bare label — the root layout template appends " — Hogsend".
export const metadata: Metadata = {
  title: "Lifecycle marketing, built and run in your repo",
  description:
    "I find the moments where your funnel loses customers — stalled trials, cancels, one-and-done buyers — build the emails that recover them, and run the program. Starts with a $2,000 one-week lifecycle audit, credited against the $9,500 30-day build. Runs on your own accounts, in your own repo.",
  alternates: { canonical: "/service" },
  keywords: [
    "lifecycle marketing",
    "lifecycle email",
    "done-for-you email",
    "trial conversion",
    "win-back emails",
    "email automation agency",
    "customer lifecycle",
    "marketing automation for developers",
    "fractional growth engineer",
  ],
};

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
      "A trial that stalls before the aha-moment usually expires without a word. The program catches it and sends the nudge back to the action that makes people stay, while they're still deciding.",
  },
  {
    icon: <RotateCcw className="size-5" strokeWidth={1.5} />,
    title: "Churned customers come back",
    description:
      "When someone cancels, they get a win-back built around why people leave your product, addressed to that reason. Some of them return.",
  },
  {
    icon: <Repeat className="size-5" strokeWidth={1.5} />,
    title: "First-time buyers buy again",
    description:
      "Most first-time buyers never place a second order without a prompt. The program runs the onboarding arc that turns the first purchase into a habit and a second order.",
  },
];

const METHOD_STEPS: Parameters<typeof ProcessSteps>[0]["steps"] = [
  {
    n: "01",
    title: "I find where you're leaking",
    description:
      "I learn your product and your funnel, and pin down the exact moments where customers stall, cancel, or drift away — the ones worth an email. This is the audit, and it stands on its own.",
  },
  {
    n: "02",
    title: "I build the program around them",
    description:
      "I design and write the emails and the timing for each moment, tailored to your product. It ships as TypeScript in your repository, reviewed like the rest of your product.",
  },
  {
    n: "03",
    title: "I run it, and keep it working",
    description:
      "It sends from your own accounts to real customers, and I keep it monitored and improving as your product and funnel change. You stay focused on the product.",
  },
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

/**
 * One rung of the ladder. The first step carries the accent treatment — it's
 * the only CTA cold traffic is asked to take.
 */
function LadderCard({
  tier,
  step,
  primary,
}: {
  tier: ServiceTier;
  step: string;
  primary: boolean;
}): JSX.Element {
  return (
    <Card
      className={`relative flex h-full flex-col overflow-hidden p-8 ${
        primary ? "border-accent/40" : ""
      }`}
    >
      {primary ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(90% 55% at 50% 100%, rgba(246, 72, 56, 0.22), transparent 70%)",
          }}
        />
      ) : null}
      <div className="relative flex flex-1 flex-col">
        <div className="flex items-center justify-between gap-4">
          <span className="text-base text-white">
            {step}. {tier.name}
          </span>
          {primary ? <TagPill accent>Start here</TagPill> : null}
        </div>

        <div className="mt-5 flex items-baseline gap-1.5">
          <span className="font-display text-[36px] text-white leading-[44px]">
            {tier.price}
          </span>
          <span className="text-base text-white/60">{tier.suffix}</span>
        </div>

        <p className="mt-4 text-base text-white/70 leading-6">{tier.promise}</p>

        <p className="eyebrow mt-8 text-white/50">What it covers</p>
        <CheckList items={tier.includes} />

        <div className="mt-auto pt-8">
          <div className="border-white/[0.08] border-t pt-6">
            <Button
              href="#enquire"
              variant={primary ? "accent" : "outline"}
              icon
              className={primary ? "w-full justify-center" : ""}
            >
              {primary ? "Book the audit" : "Talk it through"}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------------ */
/*  Page                                                                     */
/* ------------------------------------------------------------------------ */

export default function ServicePage(): JSX.Element {
  return (
    <main className="flex flex-1 flex-col">
      {/* ---- Hero: the outcome, in the buyer's language ---------------- */}
      <Section divider={false} containerClassName="container-page pt-32 pb-20">
        <AuroraBeam className="opacity-60" />
        <div className="relative z-10 grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)] lg:gap-16">
          <Reveal className="flex flex-col">
            <PillBadge className="mb-6 self-start">Service</PillBadge>
            <h1 className="max-w-2xl font-display text-[36px] text-white leading-[1.15] tracking-[-0.02em] md:text-[44px] md:leading-[52px]">
              Your lifecycle marketing, built and run in your repo
            </h1>
            <p className="mt-6 max-w-xl text-base text-white/70 leading-7">
              Every product loses customers at the same few moments. A trial
              that stalls. A subscription that cancels. A first purchase that
              never becomes a second. Each one is recoverable with the right
              email at the right time, but only if something is watching for it.
              I find those moments in your funnel, build the emails that recover
              them, and run the whole program. It sends from your own accounts,
              with no per-contact billing.
            </p>
            <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-4">
              <Button href="#enquire" variant="accent" icon>
                Start with an audit
              </Button>
              <Button href="#how" variant="outline">
                See how the build works
              </Button>
            </div>
            <p className="eyebrow mt-6 text-white/50">
              Audit $2,000 · Build $9,500 · Run from $4,000/mo
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
            <Stat value="$2,000" label="One-week audit, credited" />
            <Stat value="30 days" label="From kickoff to live" />
            <Stat value="Your repo" label="Where the program lives" />
            <Stat value="$0" label="Per-contact fees" />
          </dl>
        </Reveal>
      </Section>

      {/* ---- The unlock: what it does for the business ---------------- */}
      <Section id="unlock">
        <SectionHeading
          eyebrow="What it recovers"
          title="Catch the moments you lose people, turn some back into revenue"
          subtitle="Lifecycle email works on the handful of moments where customers stall, cancel, or churn, and turns some of them back into revenue."
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

      {/* ---- The ladder: audit → build → run -------------------------- */}
      <Section id="pricing">
        <SectionHeading
          eyebrow="How it's priced"
          title="Start with an audit. Build if it's worth building."
          subtitle="Three steps, each one useful on its own. The audit tells you what's leaking whether or not you hire me for the rest, and its fee comes off the build if you do."
        />

        <div className="mt-12 grid items-stretch gap-6 lg:grid-cols-3">
          {SERVICE_LADDER.map((tier, index) => (
            <Reveal key={tier.id} delay={index * 0.08}>
              <LadderCard
                tier={tier}
                step={String(index + 1)}
                primary={index === 0}
              />
            </Reveal>
          ))}
        </div>

        <Reveal delay={0.24}>
          <p className="mt-8 text-sm text-white/60">
            Prefer to run it yourself? The engine is free and source-available —
            every feature, no paid tier held back. See the{" "}
            <Link
              href="/pricing"
              className="text-white/80 underline decoration-white/30 underline-offset-4 transition-colors hover:text-white"
            >
              pricing page
            </Link>
            .
          </p>
        </Reveal>
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

      {/* ---- Risk reversal: the no-lock-in band ----------------------- */}
      <Section id="ownership">
        <SectionHeading
          eyebrow="No lock-in"
          title="Fire me and it all keeps working"
          subtitle="Your engineering team will sign off on this — it's code they can read, in your repository, not another SaaS login. It runs on your accounts under a source-available licence, so there is no platform holding your list hostage. If we stop working together, nothing has to move off anything. Your team can read it, change it, and run it without me."
        />
        <Reveal delay={0.1}>
          <div className="mt-10 flex flex-wrap gap-2">
            {OWNERSHIP_TAGS.map((tag) => (
              <TagPill key={tag}>{tag}</TagPill>
            ))}
          </div>
        </Reveal>
      </Section>

      {/* ---- Book a call: the inquiry form ---------------------------- */}
      <Section id="enquire">
        <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
          <Reveal>
            <SectionHeading
              eyebrow="Book a call"
              title="Start with the audit"
              subtitle="Tell me what your product does and where you think the funnel leaks. The first conversation is about your product, not a feature list — from there I'll scope the audit and send you a time to grab."
            />
          </Reveal>
          <Reveal delay={0.1}>
            <ServiceInquiryForm />
          </Reveal>
        </div>
      </Section>

      {/* ---- Closing CTA ---------------------------------------------- */}
      <Section id="start">
        <DotGrid />
        <div className="relative z-10 flex flex-col items-center text-center">
          <Reveal className="flex flex-col items-center">
            <Eyebrow className="mb-4">Get started</Eyebrow>
            <h2 className="max-w-2xl font-display text-[32px] text-white leading-[1.2] tracking-[-0.02em] md:text-[40px] md:leading-[48px]">
              Find out what you&apos;re leaking
            </h2>
            <p className="mt-5 max-w-2xl text-base text-white/70 leading-7">
              One week, $2,000, and you get a map of every moment your funnel
              loses people plus a 90-day roadmap. It comes off the build if you
              go ahead, and it&apos;s yours to act on if you don&apos;t.
            </p>
          </Reveal>
          <Reveal delay={0.1} className="mt-10">
            <Button href="#enquire" variant="accent" icon>
              Book the audit
            </Button>
          </Reveal>
          <Reveal delay={0.16}>
            <p className="mt-6 text-sm text-white/50">
              Prefer to run Hogsend yourself? The{" "}
              <Link
                href="/docs/getting-started"
                className="text-white/70 underline-offset-2 transition-colors hover:text-white hover:underline"
              >
                docs
              </Link>{" "}
              cover the full self-serve path.
            </p>
          </Reveal>
        </div>
      </Section>
    </main>
  );
}
