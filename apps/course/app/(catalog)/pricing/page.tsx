import { Check } from "lucide-react";
import type { Metadata } from "next";
import type { JSX, ReactNode } from "react";
import { CourseCard } from "@/components/course-card";
import { Eyebrow, TagPill } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { FaqAccordion } from "@/components/ds/faq";
import { AuroraBeam, DotGrid } from "@/components/ds/fx";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { type AllAccessView, getCatalog } from "@/lib/catalog";
import { getCourse } from "@/lib/courses";
import { getSession } from "@/lib/gating";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pricing — one-time, lifetime access",
  description:
    "Buy a single course for a one-time fee, or get All-Access — every course, including future ones, for one payment. No subscription.",
};

const FLAGSHIP_PRICE = getCourse("growth-with-posthog")?.priceLabel ?? "$49";

const ALL_ACCESS_INCLUDES: ReactNode[] = [
  "Every course on the site today",
  "Every future course, unlocked automatically",
  "Lifetime access on your account",
  "All updates and new lessons",
];

const SINGLE_INCLUDES: ReactNode[] = [
  "One full course, every lesson",
  "Lifetime access on your account",
  "First lesson free to try before you buy",
];

const FAQ_ITEMS = [
  {
    q: "Is this a subscription?",
    a: "No. Single courses and All-Access are both one-time payments with lifetime access on your account. There are no recurring charges.",
  },
  {
    q: "What does All-Access include?",
    a: "Every course on the site today, plus every course we publish later — unlocked automatically, for one payment.",
  },
  {
    q: "Can I buy one course and add All-Access later?",
    a: "Yes. Buy any course on its own, and you can add All-Access whenever you like to unlock the rest.",
  },
  {
    q: "Is the first lesson really free?",
    a: "Yes — the first lesson of every course is free to read with no account at all. You only pay to unlock the rest.",
  },
  {
    q: "How do refunds work?",
    a: "If something isn't right, get in touch. A refund revokes access to that purchase; everything else you own stays yours.",
  },
];

const FAQ_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ_ITEMS.map((item) => ({
    "@type": "Question",
    name: item.q,
    acceptedAnswer: { "@type": "Answer", text: item.a },
  })),
};

function CheckList({ items }: { items: ReactNode[] }): JSX.Element {
  return (
    <ul className="mt-4 flex flex-col gap-3">
      {items.map((item, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: static, never-reordered list
          key={i}
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

/** The All-Access plan CTA — owned / buyable / not-yet-live, in that order. */
function AllAccessCta({ view }: { view: AllAccessView }): JSX.Element {
  if (view.owned) {
    return (
      <span className="inline-flex items-center gap-2 text-sm text-white/70">
        <Check className="size-4 text-accent" strokeWidth={2.5} aria-hidden />{" "}
        You have All-Access
      </span>
    );
  }
  if (view.configured) {
    return (
      <form method="post" action="/api/checkout">
        <input type="hidden" name="course" value="all-access" />
        <input type="hidden" name="next" value="/account" />
        <button
          type="submit"
          className="group inline-flex h-12 w-full select-none items-center justify-center gap-2 rounded-[10px] bg-white px-5 font-medium text-[#0a0a0a] text-base tracking-[-0.02em] transition-colors duration-200 hover:bg-white/90"
        >
          Get All-Access — {view.priceLabel}
        </button>
      </form>
    );
  }
  return (
    <span className="inline-flex h-12 w-full items-center justify-center rounded-[10px] border border-white/15 px-5 text-sm text-white/50">
      Available soon
    </span>
  );
}

export default async function PricingPage() {
  const session = await getSession();
  const { courses, allAccess } = await getCatalog(session?.user.id ?? null);

  return (
    <main className="flex flex-1 flex-col">
      {/* Hero */}
      <section className="relative overflow-hidden">
        <AuroraBeam className="opacity-60" />
        <div className="container-page relative z-10 pt-28 pb-20 text-center">
          <Reveal className="flex flex-col items-center">
            <Eyebrow className="mb-4">Pricing</Eyebrow>
            <h1 className="max-w-3xl font-display text-[36px] leading-[1.15] tracking-[-0.02em] md:text-[48px]">
              One price. Every course. Forever.
            </h1>
            <p className="mt-5 max-w-2xl text-base text-white/60 leading-6">
              Buy a single course, or get All-Access to everything — including
              the courses we haven't written yet. Both are one-time payments
              with lifetime access. No subscription.
            </p>
          </Reveal>
        </div>
      </section>

      {/* Two-tier offer grid */}
      <Section divider={false}>
        <div className="grid items-start justify-center gap-6 lg:grid-cols-[minmax(0,30rem)_minmax(0,26rem)]">
          {/* All-Access */}
          <Reveal>
            <Card className="relative w-full overflow-hidden border-accent/40 p-8">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0"
                style={{
                  background:
                    "radial-gradient(90% 55% at 50% 100%, rgba(246, 72, 56, 0.22), transparent 70%)",
                }}
              />
              <div className="relative flex flex-col">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-base text-white">All-Access</span>
                  <TagPill accent>Best value</TagPill>
                </div>
                <div className="mt-5 flex items-baseline gap-1.5">
                  <span className="font-display text-[40px] text-white leading-[48px]">
                    {allAccess.priceLabel}
                  </span>
                  <span className="text-base text-white/60">
                    /one-time · lifetime
                  </span>
                </div>
                <p className="mt-4 text-base text-white/70 leading-6">
                  Every course, now and later, unlocked on your account for one
                  payment.
                </p>
                <CheckList items={ALL_ACCESS_INCLUDES} />
                <div className="mt-8 border-white/[0.08] border-t pt-6">
                  <AllAccessCta view={allAccess} />
                </div>
              </div>
            </Card>
          </Reveal>

          {/* Single course */}
          <Reveal delay={0.08}>
            <Card className="relative w-full overflow-hidden p-8">
              <div className="relative flex flex-col">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-base text-white">Single course</span>
                  <TagPill>Pay per course</TagPill>
                </div>
                <div className="mt-5 flex items-baseline gap-1.5">
                  <span className="font-display text-[40px] text-white leading-[48px]">
                    {FLAGSHIP_PRICE}
                  </span>
                  <span className="text-base text-white/60">
                    /course · lifetime
                  </span>
                </div>
                <p className="mt-4 text-base text-white/70 leading-6">
                  Just want one? Unlock a single course forever — try the first
                  lesson free first.
                </p>
                <CheckList items={SINGLE_INCLUDES} />
                <div className="mt-8 border-white/[0.08] border-t pt-6">
                  <Button href="/" variant="outline" icon>
                    Browse courses
                  </Button>
                </div>
              </div>
            </Card>
          </Reveal>
        </div>
      </Section>

      {/* Course list */}
      <Section>
        <SectionHeading
          eyebrow="What's included"
          title="The courses"
          subtitle="All-Access unlocks every one of these — and everything we add later."
        />
        <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {courses.map((view) => (
            <Reveal key={view.slug}>
              <CourseCard view={view} />
            </Reveal>
          ))}
        </div>
      </Section>

      {/* FAQ */}
      <Section>
        <div className="grid gap-12 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <Reveal>
            <SectionHeading
              eyebrow="FAQ"
              title="Pricing questions"
              subtitle="The short version: one-time, lifetime, no meter."
            />
          </Reveal>
          <Reveal delay={0.08}>
            <FaqAccordion items={FAQ_ITEMS} />
          </Reveal>
        </div>
        <script
          type="application/ld+json"
          // FAQPage structured data mirroring the visible accordion verbatim.
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD from a local constant
          dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_JSON_LD) }}
        />
      </Section>

      {/* Closing CTA */}
      <Section>
        <DotGrid />
        <div className="relative z-10 flex flex-col items-center text-center">
          <Reveal className="flex flex-col items-center">
            <Eyebrow className="mb-4">Start now</Eyebrow>
            <h2 className="max-w-2xl font-display text-[32px] leading-[1.2] tracking-[-0.02em] md:text-[40px]">
              The first lesson is free
            </h2>
            <p className="mt-5 max-w-2xl text-base text-white/60 leading-6">
              Read before you buy. Start the first lesson now — no account
              needed.
            </p>
          </Reveal>
          <Reveal delay={0.12} className="mt-9">
            <Button href="/" variant="accent" icon>
              Browse courses
            </Button>
          </Reveal>
        </div>
      </Section>
    </main>
  );
}
