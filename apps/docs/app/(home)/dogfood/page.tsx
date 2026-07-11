import { Bell } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { JSX, ReactNode } from "react";
import { TagPill } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { CodeWindow } from "@/components/ds/code-window";
import { MockupFrame } from "@/components/ds/mockup";
import { ProcessSteps } from "@/components/ds/process";
import { Reveal } from "@/components/ds/reveal";
import { isHogsendConfigured } from "@/components/hogsend/config";
import { InAppDemoBody } from "@/components/landing/in-app-demo-body";
import { cn } from "@/lib/cn";
import { GITHUB_URL } from "@/lib/site";
import { OpenBellButton } from "./open-bell-button";
// The homepage's animation keyframes (ps-pulse, ps-dash) — this page is a
// sibling of the homepage and borrows its live-dot + contour-line idioms.
import "@/app/(landing)/home.css";

// Bare label — the root layout template appends " — Hogsend".
export const metadata: Metadata = {
  title: "How we run Hogsend on Hogsend",
  description:
    "Hogsend's own marketing runs on one production Hogsend instance — the docs funnel, the course lifecycle, the Discord community, and referrals. This page shows the real emails, DMs, and journeys, and the live bell you're already inside.",
  alternates: { canonical: "/dogfood" },
  keywords: [
    "hogsend dogfood",
    "lifecycle email",
    "email automation",
    "posthog",
    "customer lifecycle",
    "referrals",
    "product-led growth",
    "self-hosted",
  ],
};

/* ========================================================================== */
/*  Homepage idiom, lifted faithfully (app/(landing)/page.tsx): Montserrat    */
/*  display h2s (--ps-display is loaded by the (home) layout for the nav),    */
/*  the ▲ mono eyebrow, two-tone headlines, crimzon section rules, and the    */
/*  tinted lead+rest cards. Content frame is the (home) chrome's 1200px       */
/*  .container-page so sections align with the PageFrame hairlines.           */
/* ========================================================================== */

const DISPLAY = "[font-family:var(--ps-display)]";

/** The homepage eyebrow: red ▲ + mono uppercase. */
function Eyebrow({
  children,
  light,
  className,
}: {
  children: ReactNode;
  light?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 font-mono text-[12px] uppercase tracking-[0.08em]",
        light ? "text-white/80" : "text-white",
        className,
      )}
    >
      <svg
        width="9"
        height="8"
        viewBox="0 0 9 8"
        aria-hidden="true"
        className="text-[#f64838]"
      >
        <path d="M4.5 0L9 8H0z" fill="currentColor" />
      </svg>
      {children}
    </span>
  );
}

/** The homepage two-tone display h2 — white lead, faint tail. */
function Headline({
  lead,
  tail,
  as: Tag = "h2",
  className,
}: {
  lead: string;
  tail?: string;
  as?: "h1" | "h2";
  className?: string;
}): JSX.Element {
  return (
    <Tag
      className={cn(
        "mt-8 max-w-[860px] font-normal text-[34px] leading-[1.15] tracking-[-0.01em] md:text-[48px] md:leading-[56px]",
        DISPLAY,
        className,
      )}
    >
      <span className="text-white">{lead}</span>{" "}
      {tail ? <span className="text-white/40">{tail}</span> : null}
    </Tag>
  );
}

/** The homepage tinted scenario card: bold lead sentence + gray rest. */
function LeadCard({
  lead,
  rest,
  index,
}: {
  lead: string;
  rest: string;
  index: number;
}): JSX.Element {
  return (
    <div
      className="h-full p-6"
      style={{
        background:
          index % 2 === 0 ? "rgba(255,255,255,0.04)" : "rgba(246,72,56,0.07)",
      }}
    >
      <p className="text-[14.5px] leading-[22px] tracking-[-0.02em]">
        <span className="font-medium text-white">{lead}</span>{" "}
        <span className="text-white/55">{rest}</span>
      </p>
    </div>
  );
}

/** Fanned contour lines with a slow dash-drift — the homepage decoration. */
function WaveLines({
  className,
  stroke = "rgba(255,150,128,0.45)",
  count = 7,
}: {
  className?: string;
  stroke?: string;
  count?: number;
}): JSX.Element {
  const paths = Array.from({ length: count }, (_, i) => {
    const y = 16 + i * 26;
    const lift = 24 + ((i * 13) % 26);
    return `M-20 ${y} C 180 ${y - lift}, 380 ${y + lift}, 620 ${y - lift / 2} S 980 ${y + lift}, 1240 ${y - lift}`;
  });
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 1200 200"
      fill="none"
      preserveAspectRatio="none"
      className={cn("pointer-events-none", className)}
    >
      {paths.map((d, i) => (
        <path
          // biome-ignore lint/suspicious/noArrayIndexKey: static deterministic art
          key={i}
          d={d}
          stroke={stroke}
          strokeWidth="1"
          strokeOpacity={0.3 + (i % 4) * 0.16}
          className="ps-dash"
          style={{ animationDelay: `${i * -3.5}s` }}
        />
      ))}
    </svg>
  );
}

/* ------------------------------------------------------------------------ */
/*  The one code window on the page — the check-in listener, trimmed from   */
/*  the production journey (hogsend-dogfood/src/journeys/docs-subscriber).  */
/*  Comments verbatim from source.                                          */
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
  // Activated — a couple of days from now, the referral favour.
  await ctx.trigger({
    event: Events.DOCS_REFERRAL_ELIGIBLE,
    userId: user.id,
  });
}

if (answer === "no") {
  // Struggler — the setup-week offer path.
  await ctx.trigger({
    event: Events.DOCS_SETUP_ELIGIBLE,
    userId: user.id,
  });
}`;

/* ------------------------------------------------------------------------ */
/*  Mock shells — every artifact below mirrors a real send from the         */
/*  production dogfood app: real subjects, real button labels, real copy.   */
/* ------------------------------------------------------------------------ */

/** Small mono label above a mocked artifact, homepage window-title style. */
function MockLabel({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p className="mb-3 font-mono text-[11px] text-white/40 tracking-wide">
      {children}
    </p>
  );
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
    <EmailShell subject="Would you recommend Measure, Keep, and Grow? One tap.">
      <p className="mt-3 text-[14px] text-white/70 leading-6">
        You finished the course a couple of days ago. One tap, honestly given,
        and you&rsquo;re done.
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
          className="grid size-9 shrink-0 place-items-center rounded-full border border-[#f64838]/40 bg-[#f64838]/[0.08] font-medium text-sm text-white"
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
              <span className="text-[#f64838] underline underline-offset-2">
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

/** The same moment in the web bell — title and body verbatim. */
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
          Your Discord is now connected to your Hogsend identity. This reached
          your bell because linking stitched your web session to your contact —
          one identity across web and Discord.
        </p>
        <p className="mt-3 font-medium text-[#f64838] text-sm">
          Getting started →
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/*  The purchase fan-out — one event, five journeys, drawn in the homepage  */
/*  journey-trace idiom (dots, connecting rail, mono labels).               */
/* ------------------------------------------------------------------------ */

const PURCHASE_FANOUT: {
  kind: "trigger" | "send" | "wait";
  label: string;
  note: string;
}[] = [
  {
    kind: "trigger",
    label: "course.purchased",
    note: "recorded server-side by course.hogsend.com",
  },
  {
    kind: "send",
    label: "course-purchase-welcome",
    note: "“That's yours now — all eleven chapters” · immediately",
  },
  {
    kind: "wait",
    label: "course-purchase-onboarding",
    note: "waits for your first chapter — “Twenty minutes gets you chapter 0” only if you stall",
  },
  {
    kind: "send",
    label: "course-community-invite",
    note: "“Your seat in the private #course channel” · the next day",
  },
  {
    kind: "send",
    label: "course-discord-access",
    note: "the 🎓 Student role, granted without asking if your Discord is linked",
  },
  {
    kind: "wait",
    label: "course-share-code",
    note: "a week in, if you've done the work — a discount code to give away",
  },
];

function PurchaseFanoutTrace(): JSX.Element {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-6">
      <span className="font-mono text-[11px] text-white/40 tracking-wide">
        one event, five journeys — each with one job
      </span>
      <div className="mt-4 flex flex-col">
        {PURCHASE_FANOUT.map((step, i) => (
          <div key={step.label} className="flex gap-4">
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  "mt-1 inline-flex size-3 shrink-0 rounded-full",
                  step.kind === "wait"
                    ? "ps-pulse bg-[#f64838]"
                    : step.kind === "trigger"
                      ? "bg-white"
                      : "border-2 border-white/30 bg-transparent",
                )}
              />
              {i < PURCHASE_FANOUT.length - 1 && (
                <span className="my-1 w-px flex-1 bg-white/15" />
              )}
            </div>
            <div className="pb-5">
              <p className="font-mono text-[13px] text-white">{step.label}</p>
              <p className="mt-0.5 text-[12px] text-white/50 leading-5">
                {step.note}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/*  The live demo window — the homepage hero demo, hosted here too. Same    */
/*  chrome, same InAppDemoBody (a REAL sign-up + the live in-app feed).     */
/* ------------------------------------------------------------------------ */

function LiveDemoWindow(): JSX.Element {
  return (
    <div className="overflow-hidden rounded-xl border border-white/15 bg-[#0a0606] shadow-2xl">
      <div className="flex items-center justify-between border-white/10 border-b px-4 py-2.5">
        <div className="flex items-center gap-3">
          <div aria-hidden="true" className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
          </div>
          <span className="font-mono text-[11px] text-white/40 tracking-wide">
            hogsend.com — live demo
          </span>
        </div>
        <span className="flex items-center gap-1.5 font-mono text-[#23c489] text-[11px]">
          <span className="ps-pulse size-1.5 rounded-full bg-[#23c489]" />
          {isHogsendConfigured ? "live" : "offline"}
        </span>
      </div>
      {isHogsendConfigured ? (
        <div className="p-4 text-left md:p-6">
          <InAppDemoBody />
        </div>
      ) : (
        <div className="p-8 text-center">
          <p className="text-sm text-white/55">
            The live demo needs the production keys — see it running on the{" "}
            <Link href="/" className="font-medium text-white">
              homepage
            </Link>
            .
          </p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/*  Card copy                                                                */
/* ------------------------------------------------------------------------ */

/** The three live surfaces on THIS page — every claim wired in this repo. */
const LIVE_SURFACES = [
  {
    lead: "The bell in the nav.",
    rest: "A real @hogsend/react feed on a publishable key — journeys on our production instance drop notifications straight into it.",
  },
  {
    lead: "The ticker above it.",
    rest: "It shows your newest notification. Click it and the bell’s feed opens.",
  },
  {
    lead: "The sign-up form below.",
    rest: "Fires a real docs.subscribed event into the ingest pipeline — Loop 1 picks you up from there.",
  },
];

/** The three check-in outcomes — real subjects as the artifacts. */
const CHECKIN_OUTCOMES = [
  {
    lead: "Yes, it's live.",
    rest: "Two days later, “A small favour” — the referral ask, only ever on the happy path.",
  },
  {
    lead: "Not yet.",
    rest: "“If the install is the blocker” — the setup week, a human installing it with you.",
  },
  {
    lead: "No reply.",
    rest: "We look at what you did instead — a deploy click since the check-in withdraws the pitch and asks the favour instead.",
  },
];

/** More course surfaces on the same instance — all real journeys. */
const COURSE_SURFACES = [
  {
    lead: "Milestones.",
    rest: "Crossing 25, 50, 75% each gets a note — “You're halfway — most people never get here.”",
  },
  {
    lead: "Gifts.",
    rest: "Three journeys: the code to the buyer, the unwrap to the recipient, a note back when it's redeemed.",
  },
  {
    lead: "The plan's gate reviews.",
    rest: "The course ends with a 30/60/90-day plan — “Day 30 — your gate review is due” holds you to it.",
  },
];

/** The Discord role ladder — every promotion is a journey. */
const ROLE_LADDER = [
  {
    emoji: "🧍",
    role: "Stranger",
    how: "Joined the server, unlinked — a DM nudges you to run /link.",
  },
  {
    emoji: "🐷",
    role: "Piglet",
    how: "Verified with /link — the role flips the moment the identities fold.",
  },
  {
    emoji: "🐗",
    role: "Hog",
    how: "Seven days in plus one message — a durable wait graduates you.",
  },
  {
    emoji: "🎓",
    role: "Student",
    how: "Bought the course — granted without asking once your Discord is linked.",
  },
  {
    emoji: "🏅",
    role: "Ambassador",
    how: "Referrals crossing the milestone — granted once, ever.",
  },
];

/* ------------------------------------------------------------------------ */
/*  Page                                                                     */
/* ------------------------------------------------------------------------ */

export default function DogfoodPage(): JSX.Element {
  return (
    <main className="flex flex-1 flex-col overflow-x-clip">
      {/* ---- Hero ------------------------------------------------------ */}
      <section className="relative overflow-hidden">
        <div className="container-page pt-32 pb-20">
          <Reveal>
            <Eyebrow>How we use it</Eyebrow>
            <Headline
              as="h1"
              lead="Hogsend runs on Hogsend."
              tail="These are the loops."
              className="max-w-[880px] md:text-[56px] md:leading-[63px]"
            />
            <p className="mt-6 max-w-[620px] text-base text-white/75 leading-[24px] tracking-[-0.02em]">
              Hogsend is one business, and all of its marketing runs on one
              production Hogsend instance. Everything on this page is a real
              email, DM, or notification that instance sends. Subscribe, join
              the Discord, or take the course, and these are the journeys that
              run for you.
            </p>
          </Reveal>
          <Reveal
            delay={0.1}
            className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-4"
          >
            <Button href="#live" variant="accent" icon>
              See the loops
            </Button>
            <Button href={GITHUB_URL} variant="outline" external>
              The engine, on GitHub
            </Button>
          </Reveal>
        </div>
      </section>

      {/* ---- You're inside it ------------------------------------------- */}
      <section id="live" className="relative border-[#f6483826] border-t">
        <div className="container-page pt-16 pb-24">
          <Reveal>
            <Eyebrow>Live right now</Eyebrow>
            <div className="flex flex-col justify-between gap-8 lg:flex-row lg:items-end">
              <Headline
                lead="You're inside one of the loops right now."
                tail="The bell above is live."
                className="max-w-[720px]"
              />
              <div className="pb-1">
                <OpenBellButton />
              </div>
            </div>
            <p className="mt-6 max-w-[620px] text-base text-white/55 leading-[24px] tracking-[-0.02em]">
              This documentation site is itself a Hogsend customer. The bell in
              the nav, the ticker above it, and the sign-up form below all talk
              to the production instance — open the bell and you're reading a
              real feed.
            </p>
          </Reveal>

          <div className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-3">
            {LIVE_SURFACES.map((surface, i) => (
              <Reveal key={surface.lead} delay={i * 0.05} className="h-full">
                <LeadCard lead={surface.lead} rest={surface.rest} index={i} />
              </Reveal>
            ))}
          </div>

          <Reveal delay={0.1} className="mt-12 block">
            <div className="mx-auto max-w-[1024px]">
              <LiveDemoWindow />
            </div>
            <p className="mt-5 text-center text-[13px] text-white/40 tracking-[-0.02em]">
              The homepage demo, live here too — the welcome email arrives from
              hello@hogsend.com in seconds, and the feed it unlocks is the same
              one behind the bell.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ---- Loop 1: the docs site --------------------------------------- */}
      <section id="docs" className="relative border-[#f6483826] border-t">
        <div className="container-page pt-16 pb-24">
          <Reveal>
            <Eyebrow>Loop 1 · The docs site</Eyebrow>
            <Headline
              lead="Six short notes, then one question."
              tail="One tap answers it."
            />
            <p className="mt-6 max-w-[620px] text-base text-white/55 leading-[24px] tracking-[-0.02em]">
              Subscribe and docs.subscribed enrolls you: welcome on day 0, one
              benefit per note, and on day 10 an email that asks how it went.
            </p>
          </Reveal>
          <div className="mt-12 grid grid-cols-1 gap-10 lg:grid-cols-2 lg:items-start">
            <Reveal>
              <MockLabel>the day-10 email, as sent</MockLabel>
              <MockupFrame>
                <CheckinEmailMock />
              </MockupFrame>
            </Reveal>
            <Reveal delay={0.1}>
              <MockLabel>the journey listening for the tap</MockLabel>
              <CodeWindow
                filename="src/journeys/docs-subscriber.ts (trimmed)"
                code={CHECKIN_LISTENER_CODE}
              />
            </Reveal>
          </div>
          <div className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-3">
            {CHECKIN_OUTCOMES.map((outcome, i) => (
              <Reveal key={outcome.lead} delay={i * 0.05} className="h-full">
                <LeadCard lead={outcome.lead} rest={outcome.rest} index={i} />
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ---- Loop 2: the course ------------------------------------------ */}
      <section id="course" className="relative border-[#f6483826] border-t">
        <div className="container-page pt-16 pb-24">
          <Reveal>
            <Eyebrow>Loop 2 · The course</Eyebrow>
            <Headline
              lead="The course runs on what it teaches."
              tail="One purchase starts five journeys."
            />
            <p className="mt-6 max-w-[620px] text-base text-white/55 leading-[24px] tracking-[-0.02em]">
              course.hogsend.com is another surface on the same instance — the
              course's emails, milestones, and Discord access run on the same
              loops its chapters teach.
            </p>
          </Reveal>
          <div className="mt-12 grid grid-cols-1 gap-10 lg:grid-cols-2 lg:items-start">
            <Reveal>
              <MockLabel>what a purchase kicks off</MockLabel>
              <PurchaseFanoutTrace />
            </Reveal>
            <Reveal delay={0.1}>
              <MockLabel>two days after you finish</MockLabel>
              <MockupFrame>
                <NpsEmailMock />
              </MockupFrame>
            </Reveal>
          </div>
          <div className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-3">
            {COURSE_SURFACES.map((surface, i) => (
              <Reveal key={surface.lead} delay={i * 0.05} className="h-full">
                <LeadCard
                  lead={surface.lead}
                  rest={surface.rest}
                  index={i + 1}
                />
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ---- Loop 3: the community ---------------------------------------- */}
      <section id="community" className="relative border-[#f6483826] border-t">
        <div className="container-page pt-16 pb-24">
          <Reveal>
            <Eyebrow>Loop 3 · The community</Eyebrow>
            <Headline
              lead="One identity across web, email, and Discord."
              tail="/link connects them."
            />
            <p className="mt-6 max-w-[680px] text-base text-white/55 leading-[24px] tracking-[-0.02em]">
              Verify with /link and the welcome reaches you twice — a DM in
              Discord, and a notification in the same bell at the top of this
              page. Both, because both now belong to one contact.
            </p>
          </Reveal>
          <div className="mt-12 grid grid-cols-1 gap-10 lg:grid-cols-2 lg:items-start">
            <Reveal>
              <MockLabel>in your Discord DMs</MockLabel>
              <DiscordDmMock />
            </Reveal>
            <Reveal delay={0.1}>
              <MockLabel>the same moment, in the web bell</MockLabel>
              <BellFeedMock />
            </Reveal>
          </div>
          <Reveal delay={0.1} className="mt-12 block">
            <MockLabel>
              the role ladder — every promotion is a journey
            </MockLabel>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
              {ROLE_LADDER.map((rung, i) => (
                <div
                  key={rung.role}
                  className="h-full p-5"
                  style={{
                    background:
                      i % 2 === 0
                        ? "rgba(255,255,255,0.04)"
                        : "rgba(246,72,56,0.07)",
                  }}
                >
                  <p className="flex items-center gap-2.5">
                    <span aria-hidden="true" className="text-[18px]">
                      {rung.emoji}
                    </span>
                    <span className="font-medium text-[15px] text-white tracking-[-0.02em]">
                      {rung.role}
                    </span>
                  </p>
                  <p className="mt-2 text-[13px] text-white/55 leading-5 tracking-[-0.02em]">
                    {rung.how}
                  </p>
                </div>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      {/* ---- Loop 4: referrals -------------------------------------------- */}
      <section
        id="referrals"
        className="relative overflow-visible border-[#f6483826] border-t"
      >
        <div className="container-page pt-16 pb-24">
          <ProcessSteps
            eyebrow="Loop 4 · Referrals"
            title="Ask the favour when it's earned"
            subtitle="We only ask people who told us things went well, at the end of the docs funnel. The credit is applied when the referred person verifies in Discord, so it always lands on a real, reachable contact."
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
        </div>
      </section>

      {/* ---- Go deeper ----------------------------------------------------- */}
      <section className="relative">
        <div className="container-page py-20">
          <div className="relative overflow-hidden rounded-2xl bg-[#070303]">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  "radial-gradient(70% 100% at 0% 60%, rgba(246,72,56,0.3), rgba(246,72,56,0.08) 45%, transparent 70%)",
              }}
            />
            <WaveLines
              className="absolute inset-y-0 right-0 h-full w-[58%] opacity-70"
              stroke="rgba(255,140,118,0.4)"
              count={9}
            />
            <div className="relative p-8 md:p-14">
              <Eyebrow light>Go deeper</Eyebrow>
              <h2
                className={cn(
                  "mt-6 max-w-[640px] font-normal text-[36px] text-white leading-[1.15] tracking-[-0.02em] md:text-[48px] md:leading-[56px]",
                  DISPLAY,
                )}
              >
                Read the loops, then run your own.
              </h2>
              <p className="mt-5 max-w-[560px] text-sm text-white/60 leading-[22px] tracking-[-0.02em]">
                The course loop has a journey-by-journey walkthrough in the docs
                — and everything on this page runs on the same code
                create-hogsend scaffolds.
              </p>
              <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-4">
                <Button href="/docs/dogfooding" variant="accent" icon>
                  The course-loop deep dive
                </Button>
                <Button href={GITHUB_URL} variant="outline" external>
                  Source on GitHub
                </Button>
              </div>
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
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
