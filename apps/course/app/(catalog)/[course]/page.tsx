import { and, eq } from "drizzle-orm";
import { Check, Lock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { JSX, ReactNode } from "react";
import { CheckoutButton } from "@/components/checkout-button";
import { AnnouncePill, Eyebrow, TagPill } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { Card, FeatureCard } from "@/components/ds/card";
import {
  CoursePreviewWindow,
  FlashcardVignette,
  GlowMedia,
  PlanVignette,
  QuizVignette,
  VignetteMedia,
  WorkbookVignette,
} from "@/components/ds/course-vignettes";
import { CtaPanel } from "@/components/ds/cta-panel";
import { HorizonGlowCanvas } from "@/components/ds/decor";
import { FaqAccordion } from "@/components/ds/faq";
import { PlanCard } from "@/components/ds/plan-card";
import { ProgressBar } from "@/components/ds/progress-bar";
import { ReaderQuotes } from "@/components/ds/reader-quotes";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { StatBand } from "@/components/ds/stat-band";
import { WordReveal } from "@/components/ds/word-reveal";
import { ExpenseCourse } from "@/components/expense-course";
import { GiftBanner, GiftCourse } from "@/components/gift-course";
import { TeamBanner, TeamLicense } from "@/components/team-license";
import {
  type CourseModuleLesson,
  getCourseModules,
  slugsFromUrl,
} from "@/lib/course-ui";
import {
  ALL_ACCESS,
  COURSES,
  type CourseMeta,
  FLAGSHIP_SLUG,
  getCourse,
} from "@/lib/courses";
import { db } from "@/lib/db";
import { lessonProgress } from "@/lib/db/schema";
import {
  allAccessConfigured,
  hasAccess,
  isCoursePaywalled,
} from "@/lib/entitlements";
import { faqPageJsonLd } from "@/lib/faq-jsonld";
import { FLAGSHIP_CONTENT_FACTS as FACTS } from "@/lib/flagship-facts";
import { getSession, isFreeLesson } from "@/lib/gating";
import { READER_QUOTES } from "@/lib/reader-quotes";
import { GITHUB_URL, HOGSEND_URL, SITE_URL, WITHSEISMIC_URL } from "@/lib/site";

// Reads the session for owned/completed state, so it's per-request.
export const dynamic = "force-dynamic";

const FLAGSHIP_SUBHEAD =
  "A start-to-finish growth program for teams on PostHog. Measure what's " +
  "actually happening, keep the users you already have, then drive traffic " +
  "into an audience you own — and run it on a 30/60/90/180-day plan. Written " +
  "for technical founders and the consultants who set this up for them.";

const MANIFESTO =
  "Most teams grow by pouring more traffic into a leaky bucket. This course " +
  "teaches the opposite order: fix retention first, then acquisition — " +
  "because every improvement to retention compounds, and every dollar of " +
  "traffic works harder.";

/** One outcome sentence per part of the flagship spine (meta.json separators). */
const PART_OUTCOMES: Record<string, string> = {
  Measure:
    "Instrument PostHog from zero, build the one dashboard you check every day, and run experiments that settle arguments.",
  Keep: "Which lifecycle emails to send, in what order — and the playbook for building the whole sequence.",
  Grow: "Drive traffic that compounds, and capture every visitor into an audience you own instead of rent.",
  Run: "Assemble the whole system, learn to talk about growth credibly, and leave with a staged 30/60/90/180-day plan.",
  Career:
    "What running growth well is worth to you — the case for growth as career capital.",
};

// Third-party retention benchmarks — same vetted trio as the product homepage.
// The HBR range gets the course's own honest framing (a flashcard teaches it
// as "direction, not decimals"); the landing page shouldn't outrun the course.
const BENCHMARKS = [
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
    claim:
      "what acquiring a new customer costs vs. keeping one — a range the course teaches you to treat as direction, not decimals",
    source: "Harvard Business Review",
  },
];

/** The three readers the course is written for, and what each walks out with.
 *  Every claim maps to real content (chapters, calculators, the workbook). */
const AUDIENCES: {
  kicker: string;
  title: string;
  body: string;
  takeaways: string[];
}[] = [
  {
    kicker: "For technical founders",
    title: "Growth as a hat, not a hire",
    body:
      "You can already ship. This adds the operating model: instrument " +
      "PostHog so you can see what's actually happening, fix retention " +
      "before buying traffic, and run the whole thing on a plan that " +
      "survives busy weeks.",
    takeaways: [
      "Your own numbers in every calculator — payback, compounding retention, paid readiness",
      "The lifecycle playbook: which emails to send, in what order, built in code",
      "A 30/60/90/180-day plan assembled from your own answers",
    ],
  },
  {
    kicker: "For consultants",
    title: "A playbook you can charge for",
    body:
      "The chapter order is the setup order for a client engagement: " +
      "measurement first, retention second, acquisition last. Every stage " +
      "produces an artefact a client can hold.",
    takeaways: [
      "A repeatable setup sequence — event taxonomy, the daily dashboard, lifecycle sends",
      "Deliverables that justify the retainer: the dashboard, the experiment doc, the staged plan",
      "The arguments, with sources, for why retention work comes before ad spend",
    ],
  },
  {
    kicker: "For people breaking into growth",
    title: "The vocabulary and the reasoning",
    body:
      "Every term is defined the moment it appears — acronyms expanded, " +
      "jargon cashed out into things you can measure. You learn why each " +
      "tactic works, not just what it's called.",
    takeaways: [
      "Working fluency: AARRR, CAC, LTV, cohorts, holdouts — each defined, then used",
      "A workbook and plan you can show — evidence you can do the work, not just discuss it",
      "A chapter on talking about growth credibly, and one on what the skill is worth to you",
    ],
  },
];

const INSIDE_CARDS: {
  title: string;
  description: string;
  media?: ReactNode;
}[] = [
  {
    title: "Quizzes you can't memorise",
    description:
      "Every chapter ends with one, and each run samples five questions from a bigger pool — so a retake is a fresh test of the ideas, not of your memory.",
    media: <QuizVignette />,
  },
  {
    title: "Flashcards for the ideas worth keeping",
    description:
      "One deck per chapter, written as full answers in the course voice rather than keyword prompts — for spaced review long after you finish reading.",
    media: <FlashcardVignette />,
  },
  {
    title: "Calculators that run on your numbers",
    description:
      "Retention compounding, CAC/LTV payback, paid readiness, dunning recovery, viral K-factor, ICE scoring, PMF-40, activation value — each takes your inputs and saves its read-out to your workbook.",
  },
  {
    title: "Watch the video, or read its digest",
    description:
      "Every embedded talk and podcast carries a transcript and a what-to-take-from-it summary — press play when it's worth the minutes, keep moving when it isn't.",
  },
  {
    title: "Answers you commit to in writing",
    description:
      "Check-ins profile your stage and stack as you read; writing prompts make you put decisions into words. Both persist to your workbook.",
  },
  {
    title: "The deeper end, verified",
    description:
      "Reading lists with the books and essays behind the arguments — quoted and checked against the source — for any chapter you want more of.",
  },
];

/** What lands in the reader's workbook, by kind — the itemized receipt. */
const WORKBOOK_RECEIPT: [number, string][] = [
  [FACTS.calculators, "calculator read-outs"],
  [FACTS.checklists, "checklists"],
  [FACTS.writingPrompts, "writing prompts"],
  [FACTS.checkIns, "profiling check-ins"],
  [FACTS.quizzes, "quiz scores"],
  [FACTS.flashcardDecks, "flashcard decks"],
  [FACTS.videos + FACTS.podcasts, "videos & podcasts"],
  [FACTS.readingLists, "reading lists"],
];

function buildFaqItems(priceLabel: string): { q: string; a: string }[] {
  return [
    {
      q: "Who is this course for?",
      a: "Technical founders running their own growth, and the consultants who set it up for clients. It assumes you can read a dashboard and aren't scared of a code block — as growth material it runs beginner to intermediate.",
    },
    {
      q: "What do I need to follow along?",
      a: "A free PostHog account covers the Measure chapters. Hogsend enters at the lifecycle playbook — and you can read the entire course before setting up either.",
    },
    {
      q: "Is it video or text?",
      a: `Text-first: fifteen chapters of prose, about six hours of reading. The ${FACTS.videos} embedded videos are optional depth — each has a transcript and a takeaways digest, so nothing depends on pressing play.`,
    },
    {
      q: "How much is free?",
      a: "The first two chapters in full — the product-led growth opener and the PostHog chapter — with no account needed. Complete chapters with their videos, quizzes, and flashcards, not a teaser.",
    },
    {
      q: "Is this a subscription?",
      a: `No. ${priceLabel} once for lifetime access to this course and every update to it. All-Access is the same deal across every course — current and future — for ${ALL_ACCESS.priceLabel}.`,
    },
    {
      q: "Can I gift it, expense it, or buy it for a team?",
      a: "All three. Gifting mints a single-use unlock code — emailed to your recipient, or to you to forward — and it never expires. A team pack does the same for 2–25 seats: one checkout, one invoice, one code per seat, emailed to you to hand out. For expensing, checkout issues a proper invoice, and there's a pre-written approval email on this page you can copy and send to your manager.",
    },
    {
      q: "What's the refund policy?",
      a: "There are no refunds. The first two chapters are free in full precisely so you can judge the course before paying.",
    },
  ];
}

/** Group a module's flat lesson list into chapters (hub + its atoms). */
function chapterize(
  lessons: CourseModuleLesson[],
): { hub: CourseModuleLesson; atoms: CourseModuleLesson[] }[] {
  const chapters: { hub: CourseModuleLesson; atoms: CourseModuleLesson[] }[] =
    [];
  for (const lesson of lessons) {
    if (lesson.depth === 0 || chapters.length === 0) {
      chapters.push({ hub: lesson, atoms: [] });
    } else {
      chapters[chapters.length - 1]?.atoms.push(lesson);
    }
  }
  return chapters;
}

/** One curriculum row — a chapter hub (numbered) or an atom (indented). */
function LessonRow({
  lesson,
  num,
  free,
  isDone,
  isLocked,
}: {
  lesson: CourseModuleLesson;
  num?: number;
  free: boolean;
  isDone: boolean;
  isLocked: boolean;
}): JSX.Element {
  const isAtom = lesson.depth > 0;
  return (
    <Link
      href={lesson.url}
      className={`group flex items-baseline gap-4 border-hairline-faint border-t transition-colors hover:bg-white/[0.03] ${
        isAtom ? "py-3 pl-8" : "py-5"
      }`}
    >
      <span
        className={`shrink-0 font-display ${
          isAtom ? "w-4 text-sm text-white/15" : "w-8 text-lg text-white/25"
        }`}
      >
        {num ? String(num).padStart(2, "0") : "·"}
      </span>
      <span className="flex-1">
        <span
          className={`block font-medium transition-colors group-hover:text-accent ${
            isAtom ? "text-sm text-white/85" : "text-white"
          }`}
        >
          {lesson.title}
        </span>
        {!isAtom && lesson.description ? (
          <span className="mt-1 block text-sm text-white/50 leading-6">
            {lesson.description}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 self-center">
        {isDone ? (
          <Check
            className="size-4 text-accent"
            strokeWidth={2.5}
            aria-label="Completed"
          />
        ) : free ? (
          <TagPill accent>Free</TagPill>
        ) : isLocked ? (
          <Lock
            className="size-4 text-white/30"
            strokeWidth={2}
            aria-label="Locked"
          />
        ) : null}
      </span>
    </Link>
  );
}

export function generateStaticParams() {
  // Coming-soon courses have no content; don't try to prerender them.
  return COURSES.filter((c) => !c.comingSoon).map((c) => ({ course: c.slug }));
}

export async function generateMetadata(props: {
  params: Promise<{ course: string }>;
}): Promise<Metadata> {
  const { course: slug } = await props.params;
  const course = getCourse(slug);
  if (!course) return {};
  return {
    title: course.title,
    description: course.tagline,
    alternates: { canonical: `/${slug}` },
    openGraph: { title: course.title, description: course.tagline },
  };
}

function ComingSoonOverview({ course }: { course: CourseMeta }): JSX.Element {
  return (
    <article className="container-page py-16 md:py-24">
      <Link
        href="/"
        className="text-sm text-white/40 transition-colors hover:text-white"
      >
        ← All courses
      </Link>

      <div className="mt-8 flex items-center gap-3">
        <p className="kicker">{course.level}</p>
        <TagPill>
          <Lock className="mr-1 size-3" strokeWidth={2} aria-hidden /> Coming
          soon
        </TagPill>
      </div>
      <h1 className="mt-3 max-w-3xl font-display text-[44px] leading-[1.0] tracking-[-0.045em] md:text-[64px]">
        {course.title}
      </h1>
      <p className="mt-5 max-w-2xl text-lg text-white/60 leading-7">
        {course.summary}
      </p>

      <Card className="mt-8 max-w-xl">
        <h2 className="font-display text-xl tracking-[-0.02em]">
          In production
        </h2>
        <p className="mt-2 text-base text-white/60 leading-6">
          This course isn't published yet. Get it — and every other course — the
          moment it lands with All-Access, or start the course that's ready
          today.
        </p>
        <div className="mt-5 flex flex-wrap gap-4">
          <Button href="/" variant="accent" icon>
            Browse available courses
          </Button>
          <Button href="/pricing" variant="outline" icon>
            See pricing
          </Button>
        </div>
      </Card>
    </article>
  );
}

export default async function CourseOverview(props: {
  params: Promise<{ course: string }>;
  searchParams: Promise<{ gift?: string; team?: string }>;
}) {
  const { course: slug } = await props.params;
  const { gift: giftStatus, team: teamStatus } = await props.searchParams;
  const course = getCourse(slug);
  if (!course) notFound();

  if (course.comingSoon) return <ComingSoonOverview course={course} />;

  const flagship = slug === FLAGSHIP_SLUG;
  const modules = getCourseModules(slug);
  const allLessons = modules.flatMap((m) => m.lessons);
  const first = allLessons[0];
  // Number only chapters (depth-0 entries: flat lessons + chapter hubs); atoms
  // (depth 1) render indented and unnumbered under their chapter.
  const chapterNumBySlug = new Map<string, number>();
  let chapterCount = 0;
  for (const l of allLessons) {
    if (l.depth === 0) chapterNumBySlug.set(l.slug, ++chapterCount);
  }

  const session = await getSession();
  const userId = session?.user.id ?? null;
  const paywalled = isCoursePaywalled(slug);
  // Ownership and progress are independent lookups — run them together.
  const [owned, progressRows] = userId
    ? await Promise.all([
        hasAccess(userId, slug),
        db
          .select({ lessonSlug: lessonProgress.lessonSlug })
          .from(lessonProgress)
          .where(
            and(
              eq(lessonProgress.userId, userId),
              eq(lessonProgress.courseSlug, slug),
            ),
          ),
      ])
    : ([false, []] as [boolean, { lessonSlug: string }[]]);
  const completed = new Set(progressRows.map((r) => r.lessonSlug));
  const total = allLessons.length;
  // Clamp: stale lessonProgress rows (a lesson renamed/removed after it was
  // completed) could otherwise push done past total → >100%.
  const done = Math.min(completed.size, total);
  const pct = total ? Math.round((done / total) * 100) : 0;
  const nextLesson = allLessons.find((l) => !completed.has(l.slug)) ?? first;
  const locked = paywalled && !owned;

  const freeOfferLine = flagship
    ? "The first two chapters are free to read in full"
    : "The first lesson is free to read";
  const freeCtaLabel = flagship
    ? "Read the free chapters"
    : "Start free lesson";
  const priceLabel = course.priceLabel ?? "$49";
  const unlockLabel = course.priceLabel
    ? `Unlock the course — ${course.priceLabel}`
    : "Unlock the course";
  const continueLabel =
    done > 0 && nextLesson
      ? `Continue: ${nextLesson.title}`
      : "Start the course";
  // The unlock CTA pair is rendered twice (hero + closing panel) — one source.
  const unlockActions = (
    <>
      <CheckoutButton sku={slug} next={first?.url} label={unlockLabel} />
      {first ? (
        <Button href={first.url} variant="outline" icon>
          {freeCtaLabel}
        </Button>
      ) : null}
    </>
  );

  const faqItems = flagship ? buildFaqItems(priceLabel) : [];
  const faqJsonLd = flagship ? faqPageJsonLd(faqItems) : null;
  const courseUrl = `${SITE_URL}/${course.slug}`;
  const courseJsonLd = !flagship
    ? null
    : {
        "@context": "https://schema.org",
        "@type": "Course",
        name: course.title,
        description: course.tagline,
        url: courseUrl,
        educationalLevel: course.level,
        provider: {
          "@type": "Organization",
          name: "Hogsend",
          url: HOGSEND_URL,
          sameAs: [GITHUB_URL, WITHSEISMIC_URL],
        },
        ...(course.priceLabel
          ? {
              offers: [
                {
                  "@type": "Offer",
                  price: course.priceLabel.replace(/[^0-9.]/g, ""),
                  priceCurrency: "USD",
                  category: "Paid",
                  url: courseUrl,
                  availability: "https://schema.org/InStock",
                },
              ],
            }
          : {}),
        hasCourseInstance: [
          {
            "@type": "CourseInstance",
            courseMode: "Online",
            courseWorkload: "PT6H",
          },
        ],
      };

  return (
    <>
      {/* Hero — announcement pill, display headline, CTAs; for the flagship,
          the course preview window floats over a planet-horizon glow canvas
          (mirrors the catalog + product homepage heroes). */}
      <section className="relative overflow-hidden">
        <div className="container-page relative z-10 flex flex-col items-center pt-16 text-center md:pt-20">
          <Reveal className="flex w-full flex-col items-center">
            {first ? (
              <AnnouncePill href={first.url} chip="Free">
                {freeOfferLine}
                <span className="font-medium text-white">Start →</span>
              </AnnouncePill>
            ) : null}

            <div className="mt-8 flex items-center gap-3">
              <p className="kicker">
                {course.level} · {course.estimate}
              </p>
              {owned ? (
                <TagPill accent>
                  <Check
                    className="mr-1 size-3"
                    strokeWidth={2.5}
                    aria-hidden
                  />{" "}
                  Owned
                </TagPill>
              ) : null}
            </div>
            <h1 className="mt-4 max-w-4xl font-display text-[48px] leading-[1.0] tracking-[-0.05em] md:text-[72px]">
              {course.title}
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg text-white/70 leading-7">
              {flagship ? FLAGSHIP_SUBHEAD : course.summary}
            </p>

            <div className="w-full max-w-xl text-left">
              <GiftBanner status={giftStatus} />
              <TeamBanner status={teamStatus} />
            </div>

            <div className="mt-9 flex flex-wrap items-center justify-center gap-x-4 gap-y-3">
              {!locked ? (
                nextLesson ? (
                  <Button href={nextLesson.url} variant="accent" icon>
                    {continueLabel}
                  </Button>
                ) : null
              ) : (
                unlockActions
              )}
            </div>

            {locked ? (
              <p className="mt-5 text-sm text-white/45">
                One-time purchase · Lifetime access
                {allAccessConfigured() ? (
                  <>
                    {" "}
                    · Or every course with{" "}
                    <Link
                      href="/pricing"
                      className="text-accent hover:underline"
                    >
                      All-Access — {ALL_ACCESS.priceLabel}
                    </Link>
                  </>
                ) : null}
              </p>
            ) : null}

            {userId ? (
              <div className="mt-8 w-full max-w-md text-left">
                <ProgressBar
                  value={done}
                  max={total}
                  className="h-1.5"
                  barClassName="bg-accent"
                />
                <p className="mt-2 text-sm text-white/40">
                  {done}/{total} lessons · {pct}% ·{" "}
                  <Link
                    href={`/workbook#wb-${slug}`}
                    className="underline transition-colors hover:text-white"
                  >
                    your workbook
                  </Link>
                </p>
              </div>
            ) : null}
          </Reveal>
        </div>

        {flagship ? (
          <>
            {/* Glow canvas — the course preview window floats over it. */}
            <div className="container-page relative mt-14">
              <HorizonGlowCanvas />
            </div>

            <div className="container-page relative z-10 -mt-[210px] pb-14 md:-mt-[230px]">
              <Reveal>
                <CoursePreviewWindow chapterCount={chapterCount} />
              </Reveal>
              {first ? (
                <p className="mt-5 text-center text-[13px] text-white/40">
                  The syllabus, quizzes, and workbook are the real course —{" "}
                  <Link href={first.url} className="font-medium text-white">
                    read the first two chapters free →
                  </Link>
                </p>
              ) : null}
            </div>
          </>
        ) : (
          <div className="pb-16" />
        )}
      </section>

      {/* Stat band — every number derived from the content at build time. */}
      {flagship ? (
        <Section>
          <Reveal>
            <StatBand
              label="Built to be worked, not watched — everything you type saves to a workbook you keep."
              stats={[
                { value: "2", caption: "Chapters free, in full" },
                { value: priceLabel, caption: "Once — lifetime access" },
                { value: "~6 hrs", caption: "Of focused reading" },
              ]}
            />
          </Reveal>
        </Section>
      ) : null}

      {/* Manifesto — WordReveal is its own scroll-linked entry, so no Reveal. */}
      {flagship ? (
        <Section>
          <div className="mx-auto flex max-w-4xl flex-col items-center">
            <Eyebrow className="mb-6">Why this order</Eyebrow>
            <p className="text-center font-display text-[28px] leading-[1.25] tracking-[-0.03em] md:text-[40px] md:leading-[1.2]">
              <WordReveal
                text={MANIFESTO}
                className="[&>span]:justify-center"
              />
            </p>
          </div>
        </Section>
      ) : null}

      {/* Benchmarks */}
      {flagship ? (
        <Section>
          <Reveal>
            <SectionHeading
              eyebrow="The evidence"
              title="Why retention comes first"
              subtitle="Retention improvements compound; traffic buys don't. The course opens by making you run that math on your own numbers."
            />
          </Reveal>
          <div className="mt-12 grid gap-4 md:grid-cols-3">
            {BENCHMARKS.map((b, i) => (
              <Reveal key={b.source} delay={i * 0.08}>
                <Card className="flex h-full flex-col">
                  <span className="font-display text-[44px] leading-[1.1] tracking-[-0.02em]">
                    {b.value}
                  </span>
                  <p className="mt-2 text-sm text-white/55 leading-6">
                    {b.claim}
                  </p>
                  <span className="mt-auto pt-6">
                    <span className="inline-flex items-center rounded-full bg-accent-tint px-3 py-1 font-mono text-[11px] text-accent uppercase tracking-[0.06em]">
                      {b.source}
                    </span>
                  </span>
                </Card>
              </Reveal>
            ))}
          </div>
        </Section>
      ) : null}

      {/* Reader quotes — real feedback only, appended as it arrives. */}
      {flagship && READER_QUOTES.length > 0 ? (
        <Section>
          <Reveal className="flex flex-col items-center">
            <Eyebrow className="mb-8">From early readers</Eyebrow>
            <ReaderQuotes quotes={READER_QUOTES} />
          </Reveal>
        </Section>
      ) : null}

      {/* Who this is for */}
      {flagship ? (
        <Section id="who-its-for">
          <Reveal>
            <SectionHeading
              eyebrow="Who it's for"
              title="Three readers, one operating model"
              subtitle="The course teaches one system. What you take from it depends on the seat you're sitting in."
            />
          </Reveal>
          <div className="mt-12 grid gap-6 lg:grid-cols-3">
            {AUDIENCES.map((a, i) => (
              <Reveal key={a.kicker} delay={i * 0.08}>
                <Card className="flex h-full flex-col">
                  <p className="kicker">{a.kicker}</p>
                  <h3 className="mt-3 font-display text-2xl tracking-[-0.02em]">
                    {a.title}
                  </h3>
                  <p className="mt-3 text-sm text-white/55 leading-6">
                    {a.body}
                  </p>
                  <p className="mt-6 font-mono text-[11px] text-white/40 uppercase tracking-[0.06em]">
                    You leave with
                  </p>
                  <ul className="mt-3 flex flex-col gap-2.5">
                    {a.takeaways.map((t) => (
                      <li key={t} className="flex items-start gap-2.5">
                        <Check
                          className="mt-1 size-3.5 shrink-0 text-accent"
                          strokeWidth={2.5}
                          aria-hidden
                        />
                        <span className="text-sm text-white/70 leading-6">
                          {t}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Card>
              </Reveal>
            ))}
          </div>
        </Section>
      ) : null}

      {/* Curriculum */}
      <Section id="curriculum">
        <SectionHeading
          eyebrow="The curriculum"
          title={
            modules.length > 1
              ? `${chapterCount} chapters in ${modules.length} parts`
              : `${chapterCount} chapters`
          }
          subtitle={
            flagship
              ? "Ordered the way the work runs: measure, keep, grow — then run it. The two free chapters are marked."
              : undefined
          }
        />
        <div className="mt-12 flex flex-col gap-12">
          {modules.map((mod) => (
            // Key on the module's first lesson URL (globally unique) so duplicate
            // separator labels can't collide; fall back to the name when empty.
            <section key={mod.lessons[0]?.url ?? mod.name ?? "module"}>
              {mod.name ? (
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  {/* .kicker scaled to 20px — the class is unlayered CSS, so a
                      text-xl utility can't override its font-size. */}
                  <h2 className="text-accent text-xl leading-7 tracking-[-0.02em]">
                    {mod.name}
                  </h2>
                  {userId ? (
                    <span className="whitespace-nowrap text-sm text-white/40">
                      {mod.lessons.filter((l) => completed.has(l.slug)).length}/
                      {mod.lessons.length} done
                    </span>
                  ) : null}
                </div>
              ) : null}
              {mod.name && PART_OUTCOMES[mod.name] ? (
                <p className="mb-4 max-w-2xl text-sm text-white/50 leading-6">
                  {PART_OUTCOMES[mod.name]}
                </p>
              ) : null}
              <ol className="flex flex-col">
                {chapterize(mod.lessons).map(({ hub, atoms }) => {
                  const hubFree = isFreeLesson(slugsFromUrl(hub.url));
                  const doneAtoms = atoms.filter((a) =>
                    completed.has(a.slug),
                  ).length;
                  return (
                    <li key={hub.url}>
                      <LessonRow
                        lesson={hub}
                        num={chapterNumBySlug.get(hub.slug)}
                        free={hubFree}
                        isDone={completed.has(hub.slug)}
                        isLocked={locked && !hubFree}
                      />
                      {/* Atoms collapse behind a zero-JS disclosure so the
                          curriculum reads as chapters; lesson titles stay in
                          the DOM for crawlers and readers who expand. */}
                      {atoms.length > 0 ? (
                        <details className="group/atoms border-hairline-faint border-t">
                          <summary className="flex cursor-pointer list-none items-center gap-2.5 py-2.5 pl-12 text-white/40 text-xs transition-colors hover:text-white/70 [&::-webkit-details-marker]:hidden">
                            <span
                              aria-hidden
                              className="transition-transform group-open/atoms:rotate-90"
                            >
                              →
                            </span>
                            {atoms.length} lessons
                            {userId ? ` · ${doneAtoms} done` : ""}
                          </summary>
                          <ol className="flex flex-col pb-2">
                            {atoms.map((atom) => {
                              const atomFree = isFreeLesson(
                                slugsFromUrl(atom.url),
                              );
                              return (
                                <li key={atom.url}>
                                  <LessonRow
                                    lesson={atom}
                                    free={atomFree}
                                    isDone={completed.has(atom.slug)}
                                    isLocked={locked && !atomFree}
                                  />
                                </li>
                              );
                            })}
                          </ol>
                        </details>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      </Section>

      {/* What's inside */}
      {flagship ? (
        <Section>
          <Reveal>
            <SectionHeading
              eyebrow="What's inside"
              title="Built to be worked, not watched"
              subtitle="Every element below is in the course today, and everything interactive saves to your account as you go."
            />
          </Reveal>
          <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {INSIDE_CARDS.map((card, i) => (
              <Reveal key={card.title} delay={(i % 3) * 0.08}>
                <FeatureCard
                  title={card.title}
                  description={card.description}
                  media={
                    card.media ? (
                      <VignetteMedia>{card.media}</VignetteMedia>
                    ) : undefined
                  }
                  className="h-full"
                />
              </Reveal>
            ))}
          </div>
        </Section>
      ) : null}

      {/* The workbook */}
      {flagship ? (
        <Section>
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <Reveal>
              <SectionHeading
                eyebrow="The workbook"
                title="Your answers become your plan"
              />
              <p className="mt-6 max-w-xl text-base text-white/60 leading-7">
                Everything you type — calculator inputs, checklist ticks,
                written answers — lands on one page on your account, editable in
                place. You finish with your numbers and your plan, not a pile of
                highlights.
              </p>
              <dl className="mt-8 grid max-w-xl grid-cols-2 gap-x-8 gap-y-3">
                {WORKBOOK_RECEIPT.map(([n, label]) => (
                  <div
                    key={label}
                    className="flex items-baseline justify-between gap-3 border-white/[0.08] border-b pb-2"
                  >
                    <dt className="text-sm text-white/55">{label}</dt>
                    <dd className="font-display text-lg">{n}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-6 text-sm text-white/45">
                All of it on one page, for as long as you want it.
              </p>
            </Reveal>
            <Reveal delay={0.08}>
              <GlowMedia className="min-h-[340px]">
                <div className="absolute inset-x-6 top-8">
                  <WorkbookVignette />
                </div>
              </GlowMedia>
            </Reveal>
          </div>
        </Section>
      ) : null}

      {/* The plan */}
      {flagship ? (
        <Section>
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <Reveal delay={0.08} className="max-lg:order-2">
              <GlowMedia className="min-h-[340px]">
                <div className="absolute inset-x-6 top-8">
                  <PlanVignette />
                </div>
              </GlowMedia>
            </Reveal>
            <Reveal className="max-lg:order-1">
              <SectionHeading
                eyebrow="After the course"
                title="Leave with a plan for days 0–180"
              />
              <p className="mt-6 max-w-xl text-base text-white/60 leading-7">
                The plan chapter assembles your workbook answers into a staged
                checklist: five day-0 commitments, then a short list each for
                days 1–30, 31–60, 61–90, and 91–180. A weekly-review ritual and
                an experiment doc keep it running past the last page.
              </p>
            </Reveal>
          </div>
        </Section>
      ) : null}

      {/* Pricing */}
      {locked ? (
        <Section id="pricing">
          <SectionHeading
            eyebrow="Pricing"
            title="One payment, yours forever"
            subtitle="No subscription. Promo codes are accepted at checkout, and checkout issues an invoice you can expense."
            align="center"
            className="items-center"
          />
          <div className="mx-auto mt-12 grid max-w-3xl items-stretch gap-6 md:grid-cols-2">
            <Reveal className="h-full">
              <PlanCard
                name="This course"
                price={priceLabel}
                priceSuffix="/one-time"
                description={`${course.title} on your account, forever.`}
                features={[
                  `All ${chapterCount} chapters, every quiz, calculator, and deck`,
                  ...(flagship
                    ? [
                        "The full workbook, saved to your account",
                        "Two full chapters free before you pay",
                      ]
                    : ["First lesson free before you buy"]),
                  "Lifetime access and all future updates",
                ]}
                cta={
                  <CheckoutButton
                    sku={slug}
                    next={first?.url}
                    label={unlockLabel}
                    fullWidth
                  />
                }
              />
            </Reveal>
            {allAccessConfigured() ? (
              <Reveal delay={0.08} className="h-full">
                <PlanCard
                  popular
                  name="All-Access"
                  badge={<TagPill accent>Best value</TagPill>}
                  price={ALL_ACCESS.priceLabel}
                  priceSuffix="/one-time · lifetime"
                  description="Every course, now and later, unlocked on your account for one payment."
                  features={[
                    "Every course on the site today",
                    "Every future course, unlocked automatically",
                    "Lifetime access, one payment",
                  ]}
                  cta={
                    <CheckoutButton
                      sku="all-access"
                      next={`/${slug}`}
                      label={`Get All-Access — ${ALL_ACCESS.priceLabel}`}
                      fullWidth
                    />
                  }
                />
              </Reveal>
            ) : null}
          </div>
          <p className="mt-8 text-center text-sm text-white/50">
            No refunds — the first two chapters are free in full so you can
            judge the course before paying.
          </p>
          <div className="mx-auto max-w-3xl">
            <GiftCourse course={course} />
            <TeamLicense course={course} />
          </div>
        </Section>
      ) : paywalled ? (
        // Owned: keep the gift + team affordances (owners buy for their team).
        <Section>
          <SectionHeading
            eyebrow="Gifting"
            title="Give it to someone on your team"
          />
          <GiftCourse course={course} />
          <TeamLicense course={course} />
        </Section>
      ) : null}

      {/* Expense it — only worth showing while the course isn't unlocked. */}
      {flagship && locked ? (
        <Section id="expense-it">
          <SectionHeading
            eyebrow="Expense it"
            title="Get this course for free"
            subtitle="Most teams have a learning budget that goes unused. We've written the email — edit the brackets and send it."
            align="center"
            className="items-center"
          />
          <Reveal className="mx-auto mt-12 max-w-2xl">
            <ExpenseCourse
              courseTitle={course.title}
              courseSlug={slug}
              priceLabel={priceLabel}
            />
          </Reveal>
        </Section>
      ) : null}

      {/* FAQ */}
      {flagship ? (
        <Section>
          <div className="grid gap-12 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <Reveal>
              <SectionHeading
                eyebrow="FAQ"
                title="Common questions"
                subtitle={`The short version: ${priceLabel} once, lifetime access, and the first two chapters free to judge it by.`}
              />
            </Reveal>
            <Reveal delay={0.08}>
              <FaqAccordion items={faqItems} />
            </Reveal>
          </div>
          <script
            type="application/ld+json"
            // FAQPage structured data mirroring the visible accordion verbatim.
            // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD from a local constant
            dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
          />
          <script
            type="application/ld+json"
            // Course structured data for search results.
            // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD from a local constant
            dangerouslySetInnerHTML={{ __html: JSON.stringify(courseJsonLd) }}
          />
        </Section>
      ) : null}

      {/* Closing CTA — CtaPanel renders its own full section. */}
      <CtaPanel
        eyebrow={locked ? "Start free" : "Keep going"}
        title={
          locked
            ? flagship
              ? "Start with the free chapters"
              : "Start with the free lesson"
            : done > 0
              ? "Pick up where you left off"
              : "Start the course"
        }
        body={
          locked
            ? flagship
              ? "The first two chapters are free in full, no account needed. If they don't change how you look at your funnel, the rest isn't for you."
              : "The first lesson is free, no account needed. Unlock the rest when you're ready."
            : "Your progress and workbook are saved on your account — the next lesson is one click away."
        }
        actions={
          locked ? (
            unlockActions
          ) : nextLesson ? (
            <Button href={nextLesson.url} variant="accent" icon>
              {continueLabel}
            </Button>
          ) : (
            <Button href={`/workbook#wb-${slug}`} variant="accent" icon>
              Open your workbook
            </Button>
          )
        }
        media={<WorkbookVignette className="bg-[#0d0707]" />}
      />
    </>
  );
}
