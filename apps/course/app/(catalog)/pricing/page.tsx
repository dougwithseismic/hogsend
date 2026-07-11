import { Check } from "lucide-react";
import type { Metadata } from "next";
import type { JSX, ReactNode } from "react";
import { CheckoutButton } from "@/components/checkout-button";
import { CourseCard } from "@/components/course-card";
import { AnnouncePill, TagPill } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { PlanVignette } from "@/components/ds/course-vignettes";
import { CtaPanel } from "@/components/ds/cta-panel";
import { HorizonGlowCanvas } from "@/components/ds/decor";
import { FaqAccordion } from "@/components/ds/faq";
import { PlanCard } from "@/components/ds/plan-card";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { type AllAccessView, getCatalog } from "@/lib/catalog";
import { FLAGSHIP_SLUG, getCourse } from "@/lib/courses";
import { faqPageJsonLd } from "@/lib/faq-jsonld";
import { getSession } from "@/lib/gating";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pricing — one-time, lifetime access",
  description:
    "Buy a single course for a one-time fee, or get All-Access — every course, including future ones, for one payment. No subscription.",
  keywords: [
    "posthog course pricing",
    "growth course",
    "lifetime access",
    "one-time payment",
    "all-access pass",
    "product analytics training",
  ],
  alternates: { canonical: "/pricing" },
};

const FLAGSHIP_PRICE = getCourse(FLAGSHIP_SLUG)?.priceLabel ?? "$49";

const SINGLE_INCLUDES: ReactNode[] = [
  "That course on your account, forever",
  "Every chapter, quiz, and workbook item in it",
  "First lesson free before you buy",
];

const ALL_ACCESS_INCLUDES: ReactNode[] = [
  "Every course on the site today",
  "Every future course, unlocked automatically",
  "Lifetime access on your account",
  "All updates and new lessons",
];

const GIFT_INCLUDES: ReactNode[] = [
  "You get the receipt; they get the code",
  "They redeem it on their own account",
  "The code never expires",
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
    a: "There are no refunds. The first lesson of every course is free — and the flagship course gives away its first two chapters in full — so you can judge before you buy.",
  },
];

const FAQ_JSON_LD = faqPageJsonLd(FAQ_ITEMS);

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
      <CheckoutButton
        sku="all-access"
        next="/account"
        label={`Get All-Access — ${view.priceLabel}`}
        fullWidth
      />
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
      {/* Hero + offer grid — the three plans float up over a planet-horizon
          glow, mirroring the homepage hero's floating-product-over-glow move.
          The offer IS pricing's product shot, so the grid is what floats. */}
      <section className="relative overflow-hidden">
        <div className="container-page relative z-10 flex flex-col items-center pt-24 text-center md:pt-28">
          <Reveal className="flex w-full flex-col items-center">
            <AnnouncePill href="/" chip="Free" className="mb-8">
              The first lesson of every course is free — no account needed
              <span className="font-medium text-white">Browse →</span>
            </AnnouncePill>
            <h1 className="max-w-3xl font-display text-[40px] leading-[1.15] tracking-[-0.04em] md:text-[56px]">
              One price. Every course. Forever.
            </h1>
            <p className="mt-5 max-w-2xl text-base text-white/60 leading-6">
              Buy a single course, or get All-Access to everything — including
              the courses we haven't written yet. Both are one-time payments
              with lifetime access. No subscription.
            </p>
          </Reveal>
        </div>

        {/* Glow canvas */}
        <div className="container-page relative mt-14">
          <HorizonGlowCanvas
            heightClassName="h-[240px] md:h-[280px]"
            waveCount={7}
          />
        </div>

        {/* Offer grid floats up over the glow. */}
        <div className="container-page relative z-10 -mt-[170px] md:-mt-[200px]">
          <div className="grid items-stretch gap-6 md:grid-cols-3">
            <Reveal className="h-full">
              <PlanCard
                name="Single course"
                price={FLAGSHIP_PRICE}
                priceSuffix="/one-time"
                description="Just want one? Unlock a single course forever — try the first lesson free first."
                features={SINGLE_INCLUDES}
                cta={
                  <Button
                    href="/"
                    variant="outline"
                    icon
                    className="w-full justify-center"
                  >
                    Browse courses
                  </Button>
                }
              />
            </Reveal>

            <Reveal delay={0.08} className="h-full">
              <PlanCard
                popular
                name="All-Access"
                badge={<TagPill accent>Best value</TagPill>}
                price={allAccess.priceLabel}
                priceSuffix="/one-time · lifetime"
                description="Every course, now and later, unlocked on your account for one payment."
                features={ALL_ACCESS_INCLUDES}
                cta={<AllAccessCta view={allAccess} />}
              />
            </Reveal>

            <Reveal delay={0.16} className="h-full">
              <PlanCard
                name="Gift a course"
                price={FLAGSHIP_PRICE}
                priceSuffix="/one-time"
                description="Pay for one copy and we mint a single-use unlock code — emailed to them, or to you to forward."
                features={GIFT_INCLUDES}
                cta={
                  <Button
                    href={`/${FLAGSHIP_SLUG}#gift`}
                    variant="outline"
                    icon
                    className="w-full justify-center"
                  >
                    Gift a course
                  </Button>
                }
              />
            </Reveal>
          </div>
          <p className="mt-10 text-center text-sm text-white/50">
            One-time payments. No subscription. The first lesson of every course
            is free.
          </p>
        </div>
      </section>

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
      <CtaPanel
        eyebrow="Start now"
        title="The first lesson is free"
        body="Read before you buy. Start the first lesson now — no account needed."
        actions={
          <Button href="/" variant="accent" icon>
            Browse courses
          </Button>
        }
        media={<PlanVignette />}
      />
    </main>
  );
}
