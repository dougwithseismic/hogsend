import { Check } from "lucide-react";
import type { Metadata } from "next";
import type { JSX, ReactNode } from "react";
import { CheckoutButton } from "@/components/checkout-button";
import { CourseCard } from "@/components/course-card";
import { AnnouncePill, TagPill } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { PlanVignette } from "@/components/ds/course-vignettes";
import { CtaPanel } from "@/components/ds/cta-panel";
import { WaveLines } from "@/components/ds/decor";
import { FaqAccordion } from "@/components/ds/faq";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { type AllAccessView, getCatalog } from "@/lib/catalog";
import { cn } from "@/lib/cn";
import { getCourse } from "@/lib/courses";
import { getSession } from "@/lib/gating";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pricing — one-time, lifetime access",
  description:
    "Buy a single course for a one-time fee, or get All-Access — every course, including future ones, for one payment. No subscription.",
};

const FLAGSHIP_PRICE = getCourse("growth-with-posthog")?.priceLabel ?? "$49";

const SINGLE_INCLUDES: ReactNode[] = [
  "That course on your account, forever",
  "All 11 chapters, quizzes, and the workbook",
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

/**
 * One pricing card: name row (chip on the popular tier), a huge numeral,
 * FEATURES label + check rows, and a bottom-pinned CTA above a hairline.
 * The popular tier gets the accent border and a warm glow from the bottom.
 */
function PlanCard({
  name,
  badge,
  price,
  priceSuffix,
  description,
  features,
  cta,
  popular = false,
}: {
  name: string;
  badge?: ReactNode;
  price: string;
  priceSuffix: string;
  description: string;
  features: ReactNode[];
  cta: ReactNode;
  popular?: boolean;
}): JSX.Element {
  return (
    <Card
      className={cn(
        // Opaque fill so the card reads cleanly where it floats over the hero
        // glow (the base Card is near-transparent).
        "relative h-full overflow-hidden bg-[#0a0606] p-8",
        popular && "border-accent/40",
      )}
    >
      {popular ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(90% 55% at 50% 100%, rgba(246, 72, 56, 0.25), transparent 70%)",
          }}
        />
      ) : null}
      <div className="relative flex h-full flex-col">
        <div className="flex items-center justify-between gap-4">
          <span className="text-base text-white">{name}</span>
          {badge}
        </div>
        <div className="mt-6 flex items-baseline gap-1.5">
          <span className="font-display text-[56px] text-white leading-none tracking-[-0.02em]">
            {price}
          </span>
          <span className="text-base text-white/60">{priceSuffix}</span>
        </div>
        <p className="mt-4 text-base text-white/70 leading-6">{description}</p>
        <p className="eyebrow mt-8 text-white/50">Features</p>
        <CheckList items={features} />
        <div className="mt-8 flex flex-1 flex-col justify-end">
          <div className="border-white/[0.08] border-t pt-6">{cta}</div>
        </div>
      </div>
    </Card>
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
          <div className="relative h-[240px] overflow-hidden rounded-2xl bg-[#070303] md:h-[280px]">
            <WaveLines
              className="absolute inset-0 h-full w-full opacity-80"
              stroke="rgba(255,140,118,0.5)"
              count={7}
            />
            <div
              aria-hidden="true"
              className="absolute inset-0"
              style={{
                background:
                  "radial-gradient(80% 70% at 50% 118%, rgba(246,72,56,0.85) 0%, rgba(246,72,56,0.3) 40%, rgba(246,72,56,0.07) 65%, transparent 82%)",
              }}
            />
            {/* The crisp horizon arc. */}
            <div
              aria-hidden="true"
              className="absolute inset-0"
              style={{
                background:
                  "radial-gradient(58% 46% at 50% 116%, transparent 59%, rgba(255,150,128,0.9) 61.5%, rgba(255,150,128,0.12) 66%, transparent 71%)",
              }}
            />
          </div>
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
                    href="/growth-with-posthog#gift"
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
