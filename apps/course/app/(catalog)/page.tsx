import { Check } from "lucide-react";
import type { JSX } from "react";
import { CheckoutButton } from "@/components/checkout-button";
import { CourseCard } from "@/components/course-card";
import { Eyebrow, PillBadge } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { FaqAccordion } from "@/components/ds/faq";
import { DotGrid, GlowField } from "@/components/ds/fx";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { type AllAccessView, getCatalog } from "@/lib/catalog";
import { getSession } from "@/lib/gating";
import { source } from "@/lib/source";

// Reads the session to resolve owned/locked card state, so it's per-request.
// Anon requests still render identical HTML for everyone (indexable).
export const dynamic = "force-dynamic";

const FLAGSHIP_SLUG = "growth-with-posthog";

const PILLARS = [
  {
    name: "Measure",
    body: "Instrument PostHog so you can actually see what's happening — the events, the funnels, and the leaks in your bucket.",
  },
  {
    name: "Keep",
    body: "Turn one-time visitors into retained users with lifecycle messaging you build in code with Hogsend.",
  },
  {
    name: "Grow",
    body: "Drive traffic that compounds, and capture every visitor into an audience you own — not one you rent.",
  },
];

const FAQ_ITEMS = [
  {
    q: "Is the first lesson really free?",
    a: "Yes. The first lesson of every course is free to read with no account at all. Paid courses unlock the rest with a one-time purchase; free courses just need a free account.",
  },
  {
    q: "Is this a subscription?",
    a: "No. Every course is a one-time purchase with lifetime access on your account. All-Access is a single payment that unlocks every course — including the ones we publish later.",
  },
  {
    q: "What's the difference between a single course and All-Access?",
    a: "A single course unlocks that one course forever. All-Access unlocks every course we publish, now and in the future, for one payment.",
  },
  {
    q: "Do I need a PostHog account?",
    a: "The flagship course teaches PostHog + Hogsend hands-on, so a free PostHog account helps you follow along — but you can read the whole thing first and set it up after.",
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

/** All-access value banner: a direct buy form when it's for sale, an owned
 *  confirmation once held, or a link to pricing when not yet configured. */
function AllAccessBanner({ view }: { view: AllAccessView }): JSX.Element {
  return (
    <Card className="relative overflow-hidden border-accent/40 p-8">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(90% 60% at 50% 100%, rgba(246, 72, 56, 0.18), transparent 70%)",
        }}
      />
      <div className="relative flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
        <div className="max-w-xl">
          <Eyebrow className="mb-2">All-Access Pass</Eyebrow>
          <h3 className="font-display text-2xl tracking-[-0.02em]">
            {view.owned ? "You have All-Access" : view.title}
          </h3>
          <p className="mt-2 text-base text-white/60 leading-6">
            {view.tagline}
          </p>
        </div>

        <div className="shrink-0">
          {view.owned ? (
            <span className="inline-flex items-center gap-2 text-sm text-white/70">
              <Check className="size-4 text-accent" strokeWidth={2.5} /> Every
              course unlocked
            </span>
          ) : view.configured ? (
            <CheckoutButton
              sku="all-access"
              next="/"
              label={`Get All-Access — ${view.priceLabel}`}
            />
          ) : (
            <Button href="/pricing" variant="accent" icon>
              See pricing
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

export default async function CatalogPage() {
  const session = await getSession();
  const { courses, allAccess } = await getCatalog(session?.user.id ?? null);

  // First (free) lesson of the flagship — the hero's "start free" target.
  const flagshipFirstLesson =
    source
      .getPages()
      .filter((p) => p.slugs[0] === FLAGSHIP_SLUG)
      .sort((a, b) => a.slugs.join("/").localeCompare(b.slugs.join("/")))[0]
      ?.url ?? `/${FLAGSHIP_SLUG}`;

  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <GlowField className="opacity-70" />
        <div className="container-page relative z-10 py-24 md:py-32">
          <Reveal className="flex flex-col items-start">
            <PillBadge className="mb-6">Code-first growth courses</PillBadge>
            <h1 className="max-w-3xl font-display text-[40px] leading-[1.05] tracking-[-0.03em] md:text-[64px]">
              Build your growth in code.
            </h1>
            <p className="mt-6 max-w-2xl text-lg text-white/60 leading-7">
              Start-to-finish courses on PostHog, lifecycle messaging, and
              turning traffic into an audience you own — written for the people
              who build it. The first lesson of every course is free.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-x-5 gap-y-3">
              <Button href={flagshipFirstLesson} variant="accent" icon>
                Start learning free
              </Button>
              <Button href="/pricing" variant="outline" icon>
                See pricing
              </Button>
            </div>
          </Reveal>
        </div>
      </section>

      {/* Course grid */}
      <Section>
        <SectionHeading
          eyebrow="The catalog"
          title="Courses"
          subtitle="Read the first lesson of any course free. Unlock the rest per course, or get everything with All-Access."
        />
        <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {courses.map((view) => (
            <Reveal key={view.slug}>
              <CourseCard view={view} />
            </Reveal>
          ))}
        </div>
        <Reveal className="mt-8">
          <AllAccessBanner view={allAccess} />
        </Reveal>
      </Section>

      {/* Value: Measure / Keep / Grow */}
      <Section>
        <SectionHeading
          eyebrow="The method"
          title="Measure, keep, then grow"
          subtitle="Most teams grow by pouring more traffic into a leaky bucket. These courses teach the opposite order."
        />
        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {PILLARS.map((pillar, i) => (
            <Reveal key={pillar.name} delay={i * 0.08}>
              <Card className="h-full">
                <span className="font-mono text-sm text-white/30">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h3 className="mt-3 font-display text-xl tracking-[-0.02em]">
                  {pillar.name}
                </h3>
                <p className="mt-2.5 text-base text-white/60 leading-6">
                  {pillar.body}
                </p>
              </Card>
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
              title="Common questions"
              subtitle="The short version: first lesson free, one-time pricing, lifetime access."
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
              No account needed to start. Read the first lesson, then unlock the
              rest when you're ready.
            </p>
          </Reveal>
          <Reveal delay={0.12} className="mt-9">
            <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-3">
              <Button href={flagshipFirstLesson} variant="accent" icon>
                Start learning free
              </Button>
              <Button href="/pricing" variant="outline" icon>
                See pricing
              </Button>
            </div>
          </Reveal>
        </div>
      </Section>
    </>
  );
}
