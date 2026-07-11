import { Check } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { JSX } from "react";
import { CheckoutButton } from "@/components/checkout-button";
import { CourseCard } from "@/components/course-card";
import { AnnouncePill, Eyebrow } from "@/components/ds/badge";
import { type BrandKey, BrandLogo } from "@/components/ds/brand-logo";
import { Button } from "@/components/ds/button";
import { Card, FeatureCard } from "@/components/ds/card";
import {
  CoursePreviewWindow,
  FlashcardVignette,
  PlanVignette,
  QuizVignette,
  VignetteMedia,
  WorkbookVignette,
} from "@/components/ds/course-vignettes";
import { CtaPanel } from "@/components/ds/cta-panel";
import { HorizonGlowCanvas } from "@/components/ds/decor";
import { FaqAccordion } from "@/components/ds/faq";
import { LogoMarquee } from "@/components/ds/marquee";
import { ProcessSteps } from "@/components/ds/process";
import { ReaderQuotes } from "@/components/ds/reader-quotes";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { StatBand } from "@/components/ds/stat-band";
import { WordReveal } from "@/components/ds/word-reveal";
import { type AllAccessView, getCatalog } from "@/lib/catalog";
import { countChapters } from "@/lib/course-ui";
import { FLAGSHIP_SLUG, getCourse } from "@/lib/courses";
import { faqPageJsonLd } from "@/lib/faq-jsonld";
import { FLAGSHIP_CONTENT_FACTS } from "@/lib/flagship-facts";
import { getSession } from "@/lib/gating";
import { READER_QUOTES } from "@/lib/reader-quotes";
import { source } from "@/lib/source";

// Reads the session to resolve owned/locked card state, so it's per-request.
// Anon requests still render identical HTML for everyone (indexable).
export const dynamic = "force-dynamic";

// Homepage self-canonical. Title/description are inherited from the root
// layout's defaults (the strongest copy for "/").
export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

// Content is fixed at build — count once per process, not per request.
const FLAGSHIP_CHAPTERS = countChapters(FLAGSHIP_SLUG);
const FLAGSHIP_PRICE = getCourse(FLAGSHIP_SLUG)?.priceLabel ?? "$49";

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

const MANIFESTO =
  "Most teams grow by pouring more traffic into a leaky bucket. These courses teach the opposite order: measure what is actually happening, keep the users you already won, then grow on top of a product that holds.";

const FAQ_ITEMS = [
  {
    q: "Is the first lesson really free?",
    a: "Yes. The first lesson of every course is free to read with no account at all — and the flagship course gives away its first two chapters in full. Paid courses unlock the rest with a one-time purchase; free courses just need a free account.",
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
  {
    q: "Can I expense it?",
    a: "Yes — checkout issues a proper invoice, and the flagship course page has a pre-written approval email you can copy and send to your manager. Gifting a copy to a teammate mints a single-use unlock code.",
  },
];

const FAQ_JSON_LD = faqPageJsonLd(FAQ_ITEMS);

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

const INSIDE_CARDS = [
  {
    title: "A workbook, not highlights",
    description:
      "Everything you type — check-ins, writing prompts, calculator read-outs — saves to one page on your account. You finish with your numbers and your plan, not a pile of notes.",
    media: <WorkbookVignette />,
  },
  {
    title: "Quizzes & flashcards that stick",
    description:
      "Every chapter ends with a quiz that samples fresh questions from a bigger pool, plus a flashcard deck written as full answers — retakes test the ideas, not your memory.",
    // A flashcard peeking behind the quiz, cropped by the media area — both
    // halves of the card title in one stack.
    media: (
      <div className="relative">
        <FlashcardVignette className="-rotate-2 absolute inset-x-0 top-0 bg-[#0f0808]" />
        <QuizVignette className="relative top-6 mx-2 shadow-2xl shadow-black/50" />
      </div>
    ),
  },
  {
    title: `Your ${FLAGSHIP_CONTENT_FACTS.dayPlan} plan`,
    description:
      "The final chapters assemble your workbook answers into a staged plan for days 0–180 — the thing you actually run after the course.",
    media: <PlanVignette />,
  },
];

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
      {/* Hero — mirrors the product homepage: announcement pill, big display
          headline, a contained planet-horizon glow canvas, and the course
          preview window floating over it, then a built-on marquee. */}
      <section className="relative overflow-hidden">
        <div className="container-page relative z-10 flex flex-col items-center pt-20 text-center md:pt-24">
          <Reveal className="flex w-full flex-col items-center">
            {/* Announcement pill — the free-first-lesson offer. */}
            <AnnouncePill href={flagshipFirstLesson} chip="Free">
              The first lesson of every course is free to read
              <span className="font-medium text-white">Start →</span>
            </AnnouncePill>

            <h1 className="mx-auto mt-9 max-w-4xl text-center font-display text-[48px] leading-[1.0] tracking-[-0.05em] md:text-[76px]">
              Build your growth in code.
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-center text-lg text-white/70 leading-7">
              Start-to-finish courses on PostHog, lifecycle messaging, and
              turning traffic into an audience you own — written for the people
              who build it.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-x-5 gap-y-3">
              <Button href={flagshipFirstLesson} variant="accent" icon>
                Start learning free
              </Button>
              <Button href="/pricing" variant="outline" icon>
                See pricing
              </Button>
            </div>
            <p className="mt-6 text-sm text-white/40">
              First lesson free · One-time purchase · Lifetime access
            </p>
          </Reveal>
        </div>

        {/* Glow canvas — the course preview window floats over it. */}
        <div className="container-page relative mt-14">
          <HorizonGlowCanvas />
        </div>

        <div className="container-page relative z-10 -mt-[210px] pb-14 md:-mt-[230px]">
          <Reveal>
            <CoursePreviewWindow chapterCount={FLAGSHIP_CHAPTERS} />
          </Reveal>
          <p className="mt-5 text-center text-[13px] text-white/40">
            The syllabus, quizzes, and workbook are the real course —{" "}
            <Link href={flagshipFirstLesson} className="font-medium text-white">
              read the first lesson free →
            </Link>
          </p>
        </div>

        {/* Built-on strip */}
        <div className="border-accent/20 border-y">
          <div className="container-page flex flex-col gap-5 py-9 md:flex-row md:items-center md:gap-12">
            <span className="shrink-0 font-mono text-[12px] text-white/40 uppercase tracking-[0.08em]">
              Built on
            </span>
            <div className="relative min-w-0 flex-1 opacity-70 grayscale">
              <LogoMarquee
                items={(
                  [
                    "posthog",
                    "resend",
                    "typescript",
                    "stripe",
                    "railway",
                  ] as const satisfies readonly BrandKey[]
                ).map((brand) => (
                  <BrandLogo
                    key={brand}
                    brand={brand}
                    height={22}
                    className="mx-8 text-white/55"
                  />
                ))}
              />
            </div>
          </div>
        </div>
      </section>

      {/* Stat band */}
      <Section>
        <Reveal>
          <StatBand
            label="One course today, built to be worked, not just read — everything you type saves to a workbook you keep."
            stats={[
              { value: "2", caption: "Chapters free, in full" },
              { value: FLAGSHIP_PRICE, caption: "Once — lifetime access" },
              { value: "~6 hrs", caption: "Of focused reading" },
            ]}
          />
        </Reveal>
      </Section>

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

      {/* Manifesto — WordReveal is its own scroll-linked entry, so no Reveal. */}
      <Section>
        <div className="mx-auto flex max-w-4xl flex-col items-center">
          <Eyebrow className="mb-6">Why this order</Eyebrow>
          <p className="text-center font-display text-[28px] leading-[1.25] tracking-[-0.03em] md:text-[40px] md:leading-[1.2]">
            <WordReveal text={MANIFESTO} className="[&>span]:justify-center" />
          </p>
        </div>
      </Section>

      {/* Reader quotes — real feedback only, appended as it arrives. */}
      {READER_QUOTES.length > 0 ? (
        <Section>
          <Reveal className="flex flex-col items-center">
            <Eyebrow className="mb-8">From early readers</Eyebrow>
            <ReaderQuotes quotes={READER_QUOTES} />
          </Reveal>
        </Section>
      ) : null}

      {/* The method — sticky left column; no Reveal/transform wrapper (it
          would break position: sticky inside ProcessSteps). */}
      <Section>
        <ProcessSteps
          eyebrow="The method"
          title="Measure, keep, then grow"
          subtitle="One operating model, taught in the order the work runs — written for founders wearing the growth hat, consultants setting it up for clients, and people breaking into the field."
          steps={PILLARS.map((pillar, i) => ({
            n: String(i + 1).padStart(2, "0"),
            title: pillar.name,
            description: pillar.body,
          }))}
        />
      </Section>

      {/* What's inside */}
      <Section>
        <Reveal>
          <SectionHeading
            eyebrow="What's inside"
            title="Quizzes, flashcards, a workbook, and a plan"
            subtitle="Every chapter has a quiz and a flashcard deck; the workbook runs through the whole course."
          />
        </Reveal>
        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {INSIDE_CARDS.map((card, i) => (
            <Reveal key={card.title} delay={i * 0.08}>
              <FeatureCard
                title={card.title}
                description={card.description}
                media={<VignetteMedia>{card.media}</VignetteMedia>}
                className="h-full"
              />
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

      {/* Closing CTA — CtaPanel renders its own full section. */}
      <CtaPanel
        eyebrow="Start now"
        title="The first lesson is free"
        body="No account needed to start. Read the first lesson, then unlock the rest when you're ready."
        actions={
          <>
            <Button href={flagshipFirstLesson} variant="accent" icon>
              Start learning free
            </Button>
            <Button href="/pricing" variant="outline" icon>
              See pricing
            </Button>
          </>
        }
        media={<PlanVignette className="bg-[#0d0707]" />}
      />
    </>
  );
}
