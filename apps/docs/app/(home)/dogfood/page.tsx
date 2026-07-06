import { Bell } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { JSX, ReactNode } from "react";
import { TagPill } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { CodeWindow } from "@/components/ds/code-window";
import { MockupFrame } from "@/components/ds/mockup";
import { ProcessSteps } from "@/components/ds/process";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { GITHUB_URL } from "@/lib/site";

// Bare label — the root layout template appends " — Hogsend".
export const metadata: Metadata = {
  title: "How we run Hogsend on Hogsend",
  description:
    "The four loops our production instance runs — the docs check-in, the course lifecycle, the referral credit, and the Discord /link — shown as the real emails, DMs, and journeys they are.",
};

/* ------------------------------------------------------------------------ */
/*  The one code window on the page — the check-in listener, trimmed from   */
/*  the production journey (hogsend-dogfood/src/journeys/docs-subscriber).  */
/* ------------------------------------------------------------------------ */

const CHECKIN_LISTENER_CODE = `// Day 10 — the buttons in the email ARE the answer.
const checkin = await ctx.waitForEvent({
  event: Events.DOCS_CHECKIN_ANSWERED,
  timeout: days(5),
});

const answer = checkin.timedOut
  ? undefined
  : checkin.properties?.answer;

if (answer === "yes") {
  // Winning → the favour (the referral loop).
  await ctx.trigger({
    event: Events.DOCS_REFERRAL_ELIGIBLE,
    userId: user.id,
  });
}

if (answer === "no") {
  // Stuck → real help (the setup week).
  await ctx.trigger({
    event: Events.DOCS_SETUP_ELIGIBLE,
    userId: user.id,
  });
}`;

/* ------------------------------------------------------------------------ */
/*  Mock shells — every artifact below mirrors a real send from the         */
/*  production dogfood app: real subjects, real button labels, real copy.   */
/* ------------------------------------------------------------------------ */

/** Small sentence-case label above a mocked artifact. */
function MockLabel({ children }: { children: ReactNode }): JSX.Element {
  return <p className="mb-3 text-[12px] text-white/40">{children}</p>;
}

/**
 * A rendered email, from site tokens only: sender line, subject, body,
 * whatever the email's interactive row is, and the journey footer.
 */
function EmailShell({
  subject,
  children,
}: {
  subject: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="text-left">
      <p className="font-mono text-[11px] text-white/40">
        From: hello@hogsend.com
      </p>
      <h3 className="mt-2 font-medium text-[16px] text-white">{subject}</h3>
      {children}
      <p className="mt-7 text-[12px] text-white/40">
        Sent by a journey · Unsubscribe
      </p>
    </div>
  );
}

/** The day-10 check-in — subject, copy, and button labels verbatim. */
function CheckinEmailMock(): JSX.Element {
  return (
    <EmailShell subject="Did you get a journey running?">
      <p className="mt-3 text-[14px] text-white/70 leading-6">
        It&rsquo;s Doug. Ten days in: did you get a journey running?
      </p>
      <div className="mt-4 flex flex-wrap gap-2.5">
        <span className="inline-flex rounded-lg border border-white/20 bg-white/[0.06] px-5 py-2 font-semibold text-sm text-white">
          Yes, it&rsquo;s live
        </span>
        <span className="inline-flex rounded-lg border border-white/20 bg-white/[0.06] px-5 py-2 font-semibold text-sm text-white">
          Not yet
        </span>
      </div>
      <p className="mt-4 text-[13px] text-white/50 leading-5">
        Your answer tells me whether to send help or leave you to it —
        that&rsquo;s all I do with it.
      </p>
    </EmailShell>
  );
}

/** The post-completion NPS email — subject and 0–10 row verbatim. */
function NpsEmailMock(): JSX.Element {
  return (
    <EmailShell subject="Would you recommend Measure, Keep, and Grow?">
      <p className="mt-3 text-[14px] text-white/70 leading-6">
        One tap, honestly given, and you&rsquo;re done.
      </p>
      <div className="mt-4 flex flex-wrap gap-1.5">
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((score) => (
          <span
            key={score}
            className="inline-flex min-w-9 items-center justify-center rounded-md border border-white/15 bg-white/[0.05] px-2.5 py-1.5 font-semibold text-[13px] text-white/85"
          >
            {score}
          </span>
        ))}
      </div>
      <p className="mt-3 text-[13px] text-white/50 leading-5">
        0 = not at all, 10 = absolutely.
      </p>
      <div className="mt-5 flex flex-col gap-2.5 border-white/[0.08] border-t pt-5">
        <p className="flex flex-wrap items-center gap-2.5 text-[13px] text-white/60">
          <TagPill accent>9–10</TagPill>
          &ldquo;Thank you — one small ask&rdquo; — the testimonial.
        </p>
        <p className="flex flex-wrap items-center gap-2.5 text-[13px] text-white/60">
          <TagPill>0–6</TagPill>
          Doug, personally — a flag in his inbox, not an automated apology.
        </p>
      </div>
    </EmailShell>
  );
}

/** The referral credit email — subject and copy verbatim. */
function ReferralEmailMock(): JSX.Element {
  return (
    <EmailShell subject="Someone you referred just joined">
      <p className="mt-3 text-[14px] text-white/70 leading-6">
        A new person came in through your referral link. Thank you for spreading
        the word.
      </p>
    </EmailShell>
  );
}

/** The Discord welcome DM — message copy verbatim from the welcome journey. */
function DiscordDmMock(): JSX.Element {
  return (
    <div className="rounded-xl border border-white/10 bg-[#0a0606]/80 p-5 md:p-6">
      <div className="flex items-start gap-3.5">
        <span
          aria-hidden="true"
          className="grid size-9 shrink-0 place-items-center rounded-full border border-accent/40 bg-accent-tint font-medium text-sm text-white"
        >
          H
        </span>
        <div className="min-w-0">
          <p className="flex items-center gap-2">
            <span className="font-medium text-sm text-white">Hogsend</span>
            <TagPill className="px-1.5 py-0.5 text-[10px]">APP</TagPill>
          </p>
          <div className="mt-1.5 flex flex-col gap-3 text-[14px] text-white/75 leading-6">
            <p>
              Hey — welcome to the Hogsend community, and thanks for verifying!
              🎉
            </p>
            <p>
              If you&rsquo;re getting started, here&rsquo;s the quickest path
              in:{" "}
              <span className="text-accent underline underline-offset-2">
                your personal getting-started link
              </span>
            </p>
            <p>Ask anything in the server — we read everything.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The same moment in the web bell — title and copy from the same journey. */
function BellFeedMock(): JSX.Element {
  return (
    <div className="rounded-xl border border-white/10 bg-[#0a0606]/80 p-5 md:p-6">
      <p className="flex items-center gap-2 text-white/50 text-xs">
        <Bell className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
        Notifications
      </p>
      <div className="mt-4 rounded-lg border border-white/[0.08] bg-white/[0.03] p-4">
        <p className="font-medium text-sm text-white">
          You linked your Discord 🎉
        </p>
        <p className="mt-1.5 text-[13px] text-white/60 leading-5">
          Your Discord is now connected to your Hogsend identity — one identity
          across web and Discord.
        </p>
        <p className="mt-3 font-medium text-accent text-sm">
          Getting started →
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/*  The bucket — the strategy, as a picture.                                */
/* ------------------------------------------------------------------------ */

/**
 * Four ways in pour into one bucket; each leak is plugged by a journey; the
 * paid-traffic tap stays off until the bucket holds. Accent red is spent on
 * the water and the patches — the nurture is what holds it.
 */
function BucketDiagram(): JSX.Element {
  const inlets = [
    { x: 180, label: "Docs" },
    { x: 262, label: "The course" },
    { x: 344, label: "Discord" },
    { x: 426, label: "A friend's link" },
  ];
  const patches = [
    { x: 186, y: 168, w: 104, label: "the check-in" },
    { x: 312, y: 192, w: 116, label: "the walkthrough" },
    { x: 208, y: 232, w: 104, label: "the thank-you" },
    { x: 326, y: 258, w: 100, label: "the welcome" },
  ];

  return (
    <svg
      viewBox="0 0 560 348"
      width="100%"
      height="auto"
      role="img"
      aria-label="Four ways in — docs, the course, Discord, a friend's link — pour into one bucket. Every leak is plugged by a journey: the check-in, the walkthrough, the thank-you, the welcome. The paid-traffic tap stays off until the bucket holds."
    >
      {/* Paid-traffic tap — drawn dashed and dry: it waits. */}
      <rect
        x="34"
        y="44"
        width="66"
        height="20"
        rx="4"
        fill="none"
        stroke="rgba(255,255,255,0.25)"
        strokeWidth="1"
        strokeDasharray="4 4"
      />
      <text
        x="67"
        y="36"
        fill="rgba(255,255,255,0.55)"
        fontSize="12"
        textAnchor="middle"
      >
        Paid traffic
      </text>
      <text
        x="67"
        y="58"
        fill="rgba(246,72,56,0.9)"
        fontSize="10"
        fontFamily="monospace"
        textAnchor="middle"
      >
        later
      </text>
      <line
        x1="88"
        y1="70"
        x2="146"
        y2="106"
        stroke="rgba(255,255,255,0.18)"
        strokeWidth="1"
        strokeDasharray="2 6"
      />

      {/* Four inlets — labels and arrows into the bucket mouth. */}
      {inlets.map((inlet) => (
        <g key={inlet.label}>
          <text
            x={inlet.x}
            y="36"
            fill="rgba(255,255,255,0.7)"
            fontSize="12"
            textAnchor="middle"
          >
            {inlet.label}
          </text>
          <line
            x1={inlet.x}
            y1="46"
            x2={inlet.x}
            y2="82"
            stroke="rgba(255,255,255,0.3)"
            strokeWidth="1.5"
          />
          <path
            d={`M${inlet.x - 4} 80 L${inlet.x} 90 L${inlet.x + 4} 80 Z`}
            fill="rgba(255,255,255,0.3)"
          />
        </g>
      ))}

      {/* Bucket silhouette. */}
      <path
        d="M150 108 L450 108 L418 328 L182 328 Z"
        fill="rgba(255,255,255,0.02)"
        stroke="rgba(255,255,255,0.22)"
        strokeWidth="1.5"
      />

      {/* Water — it holds. */}
      <path
        d="M156 148 L444 148 L418 328 L182 328 Z"
        fill="rgba(246,72,56,0.08)"
      />
      <line
        x1="156"
        y1="148"
        x2="444"
        y2="148"
        stroke="rgba(246,72,56,0.5)"
        strokeWidth="1.5"
      />

      {/* Patches — one journey over every hole. */}
      {patches.map((patch) => (
        <g key={patch.label}>
          <rect
            x={patch.x}
            y={patch.y}
            width={patch.w}
            height="28"
            rx="6"
            fill="rgba(246,72,56,0.14)"
            stroke="rgba(246,72,56,0.5)"
            strokeWidth="1"
          />
          <text
            x={patch.x + patch.w / 2}
            y={patch.y + 18}
            fill="rgba(255,255,255,0.9)"
            fontSize="11"
            fontFamily="monospace"
            textAnchor="middle"
          >
            {patch.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

/* ------------------------------------------------------------------------ */
/*  The purchase fan-out — one event, five journeys, drawn as a trace.      */
/* ------------------------------------------------------------------------ */

const PURCHASE_FANOUT: { name: string; artifact: string }[] = [
  {
    name: "The receipt",
    artifact: "“That's yours now — all eleven chapters” · immediately",
  },
  {
    name: "The walkthrough",
    artifact:
      "watches three days for a first chapter; one nudge — “Twenty minutes gets you chapter 0” — then silence",
  },
  {
    name: "The community invite",
    artifact: "“Your seat in the private #course channel” · the next day",
  },
  {
    name: "Discord access",
    artifact: "the 🎓 role, granted without asking if your account is linked",
  },
  {
    name: "Your share code",
    artifact: "a discount code to give away",
  },
];

function PurchaseFanout(): JSX.Element {
  return (
    <div>
      <span className="inline-flex items-center rounded-md border border-accent/40 bg-accent-tint px-3 py-1.5 font-mono text-[13px] text-white">
        course.purchased
      </span>
      <ul className="mt-2 ml-3 flex flex-col border-white/10 border-l">
        {PURCHASE_FANOUT.map((row) => (
          <li key={row.name} className="relative py-3 pl-6">
            <span
              aria-hidden="true"
              className="absolute top-1/2 left-0 h-px w-4 bg-white/10"
            />
            <p className="font-medium text-sm text-white">{row.name}</p>
            <p className="mt-0.5 text-[13px] text-white/55 leading-5">
              {row.artifact}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/*  The three check-in outcomes — real subjects as the artifacts.           */
/* ------------------------------------------------------------------------ */

const CHECKIN_OUTCOMES: { answer: string; title: string; line: string }[] = [
  {
    answer: "Yes, it's live",
    title: "“A small favour”",
    line: "Two days later we ask you to tell a friend — the referral loop below.",
  },
  {
    answer: "Not yet",
    title: "“If the install is the blocker”",
    line: "Real help: the setup week, a human installing it with you.",
  },
  {
    answer: "Silence",
    title: "We look at what you did instead",
    line: "A deploy click since the check-in means you got moving — the pitch is withdrawn, the favour asked instead.",
  },
];

/* ------------------------------------------------------------------------ */
/*  Page                                                                     */
/* ------------------------------------------------------------------------ */

export default function DogfoodPage(): JSX.Element {
  return (
    <main className="flex flex-1 flex-col">
      {/* ---- Hero ------------------------------------------------------ */}
      <section className="relative overflow-hidden text-white">
        <div className="container-page pt-32 pb-20">
          <Reveal>
            <SectionHeading
              eyebrow="How we use it"
              title="How we run Hogsend on Hogsend"
              subtitle="Hogsend is one business, and its marketing runs on one production Hogsend instance. These are the four loops it runs — shown as the real emails, DMs, and journeys they are."
            />
          </Reveal>
          <Reveal
            delay={0.1}
            className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-4"
          >
            <Button href="#bucket" variant="accent" icon>
              See the loops
            </Button>
            <Button href={GITHUB_URL} variant="outline" external>
              The engine, on GitHub
            </Button>
          </Reveal>
        </div>
      </section>

      {/* ---- The bucket --------------------------------------------------- */}
      <Section id="bucket">
        <Reveal>
          <SectionHeading
            align="center"
            eyebrow="The aim"
            title="Fix the bucket before paying to fill it"
            subtitle="We nurture every step of the way — so when we turn paid traffic on, the bucket has no holes."
          />
        </Reveal>
        <Reveal delay={0.1} className="mx-auto mt-12 max-w-3xl">
          <MockupFrame>
            <BucketDiagram />
          </MockupFrame>
          <p className="mt-4 text-center text-[13px] text-white/45 leading-5">
            Paid clicks are the most expensive way to find a leak. Every loop
            below plugs one first.
          </p>
        </Reveal>
      </Section>

      {/* ---- Loop 1: the docs funnel ------------------------------------ */}
      <Section id="docs-funnel">
        <Reveal>
          <SectionHeading
            eyebrow="Loop 1 · The docs funnel"
            title="Get readers to a running journey"
            subtitle="Six short notes over ten days, then one question. The tap is the answer — it flows back into the journey and decides what happens next."
          />
        </Reveal>
        <div className="mt-12 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
          <Reveal>
            <MockLabel>The day-10 email, as sent</MockLabel>
            <MockupFrame>
              <CheckinEmailMock />
            </MockupFrame>
          </Reveal>
          <Reveal delay={0.1}>
            <MockLabel>The journey listening for the tap</MockLabel>
            <CodeWindow
              filename="src/journeys/docs-subscriber.ts (trimmed)"
              code={CHECKIN_LISTENER_CODE}
            />
          </Reveal>
        </div>
        <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-3">
          {CHECKIN_OUTCOMES.map((outcome, index) => (
            <Reveal key={outcome.answer} delay={index * 0.05}>
              <Card className="h-full">
                <TagPill accent={outcome.answer === "Yes, it's live"}>
                  {outcome.answer}
                </TagPill>
                <h3 className="mt-4 font-medium text-[16px] text-white leading-[1.3] tracking-[-0.02em]">
                  {outcome.title}
                </h3>
                <p className="mt-2 text-[13px] text-white/55 leading-5">
                  {outcome.line}
                </p>
              </Card>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* ---- Loop 2: the course ------------------------------------------ */}
      <Section id="course">
        <Reveal>
          <SectionHeading
            eyebrow="Loop 2 · The course"
            title="The course runs on what it teaches"
            subtitle="One purchase starts five journeys, each with one job. When you finish, one tap decides what we do next."
          />
        </Reveal>
        <div className="mt-12 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
          <Reveal>
            <MockLabel>What a purchase kicks off</MockLabel>
            <MockupFrame>
              <PurchaseFanout />
            </MockupFrame>
          </Reveal>
          <Reveal delay={0.1}>
            <MockLabel>Two days after you finish</MockLabel>
            <MockupFrame>
              <NpsEmailMock />
            </MockupFrame>
          </Reveal>
        </div>
      </Section>

      {/* ---- Loop 3: referrals -------------------------------------------- */}
      <Section id="referrals" className="overflow-visible">
        <ProcessSteps
          eyebrow="Loop 3 · Referrals"
          title="Ask the favour when it's earned"
          subtitle="The ask lives at the end of the docs funnel's happy path, not in a banner. And the credit is strict about the moment it counts."
          steps={[
            {
              n: "01",
              title: "A friend arrives through your link",
              description:
                "The visit is remembered against them. No codes table, no ledger to reconcile — the events are the ledger.",
            },
            {
              n: "02",
              title: "They verify in the Discord",
              description:
                "That's the conversion — the moment an anonymous visitor becomes a real, reachable person.",
            },
            {
              n: "03",
              title: "The credit lands on you",
              description:
                "A thank-you email and DM each time, and the 🏅 Ambassador role in the server when you cross the milestone — once, ever.",
              media: (
                <MockupFrame>
                  <ReferralEmailMock />
                </MockupFrame>
              ),
            },
          ]}
        />
      </Section>

      {/* ---- Loop 4: the Discord community -------------------------------- */}
      <Section id="discord">
        <Reveal>
          <SectionHeading
            eyebrow="Loop 4 · The community"
            title="One identity across web, email, and Discord"
            subtitle="Verify with /link and the welcome reaches you twice — a DM in Discord, and a notification in the web bell. Both, because both now belong to one contact."
          />
        </Reveal>
        <div className="mt-12 grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
          <Reveal>
            <MockLabel>In your Discord DMs</MockLabel>
            <DiscordDmMock />
          </Reveal>
          <Reveal delay={0.1}>
            <MockLabel>The same moment, in the web bell</MockLabel>
            <BellFeedMock />
          </Reveal>
        </div>
        <Reveal delay={0.15} className="mt-8 flex flex-wrap gap-2.5">
          <TagPill>🎓 course channel unlocks automatically once linked</TagPill>
          <TagPill>a re-link never re-greets — once per person</TagPill>
        </Reveal>
      </Section>

      {/* ---- Closing ------------------------------------------------------ */}
      <Section id="next">
        <div className="mx-auto flex max-w-2xl flex-col items-center text-center">
          <Reveal>
            <SectionHeading
              align="center"
              eyebrow="Go deeper"
              title="Read the loops, then run your own"
              subtitle="The course loop has a journey-by-journey walkthrough in the docs — and everything on this page runs on the same code create-hogsend scaffolds."
            />
          </Reveal>
          <Reveal
            delay={0.1}
            className="mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-4"
          >
            <Button href="/docs/dogfooding" variant="accent" icon>
              The course-loop deep dive
            </Button>
            <Button href={GITHUB_URL} variant="outline" external>
              Source on GitHub
            </Button>
          </Reveal>
          <Reveal delay={0.16}>
            <p className="mt-6 text-sm text-white/50">
              Hogsend is free to self-host —{" "}
              <Link
                href="/pricing"
                className="text-white/70 underline-offset-2 transition-colors hover:text-white hover:underline"
              >
                pricing
              </Link>{" "}
              covers what you actually pay for.
            </p>
          </Reveal>
        </div>
      </Section>
    </main>
  );
}
