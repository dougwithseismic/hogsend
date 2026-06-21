import type { Metadata } from "next";
import type { JSX, ReactNode } from "react";
import { Clip } from "@/components/clips/clip";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { CodeWindow } from "@/components/ds/code-window";
import { CodeMock, IntegrationGrid, MockupFrame } from "@/components/ds/mockup";
import { ProcessSteps } from "@/components/ds/process";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { TabbedShowcase } from "@/components/ds/tabs";

export const metadata: Metadata = {
  title: "How to do onboarding properly",
  description:
    "A guide to onboarding email that reacts to what users do, not how long they have been signed up — the activation event the sequence aims at, the durable wait that parks the journey, and the whole thing as one TypeScript file in your repo.",
};

const EVENTS_CODE = `// src/journeys/constants/events.ts
export const Events = {
  USER_CREATED: "user.created",       // they signed up
  SETUP_COMPLETED: "setup.completed", // they cleared the first step
  USER_ACTIVATED: "user.activated",   // they hit first value — the goal
  USER_DELETED: "user.deleted",
} as const;`;

const JOURNEY_CODE = `import { days, hours } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";
import { Events, Templates } from "./constants/index.js";

export const onboarding = defineJourney({
  meta: {
    id: "onboarding",
    name: "Onboarding",
    enabled: true,
    trigger: { event: Events.USER_CREATED }, // PostHog signup → enrol
    entryLimit: "once",                       // a re-signup never restarts it
    suppress: hours(12),                      // never two emails within 12h
    exitOn: [{ event: Events.USER_ACTIVATED }, { event: Events.USER_DELETED }],
  },

  run: async (user, ctx) => {
    // Welcome, immediately. One next step.
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.ACTIVATION_WELCOME,
      subject: "Welcome — here's your first step",
      journeyName: user.journeyName,
    });

    // Park — durably — until they set up, or 3 days pass.
    const { timedOut } = await ctx.waitForEvent({
      event: Events.SETUP_COMPLETED,
      timeout: days(3),
    });

    // Two people, two emails.
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: timedOut
        ? Templates.ACTIVATION_NUDGE            // stalled → specific help
        : Templates.ACTIVATION_FEATURE_HIGHLIGHT, // moved → first win
      subject: timedOut
        ? "Stuck on setup?"
        : "You're set up — here's what's next",
      journeyName: user.journeyName,
    });
  },
});`;

/* ── primitives ───────────────────────────────────────────────────────── */

function InlineCode({ children }: { children: ReactNode }): JSX.Element {
  return (
    <code className="rounded bg-white/[0.08] px-1.5 py-0.5 font-mono text-[13px] text-white/90">
      {children}
    </code>
  );
}

/**
 * A single rendered email card built from site tokens only. One sender line
 * (a real person), one subject, one preview line, exactly one accent CTA, and
 * a recipient footer — the structure the copy prescribes, shown as the artifact.
 */
function EmailCard({
  from,
  subject,
  preview,
  cta,
}: {
  from: string;
  subject: string;
  preview: string;
  cta: string;
}): JSX.Element {
  return (
    <div className="text-left">
      <p className="font-mono text-[11px] text-white/40">From: {from}</p>
      <h3 className="mt-2 font-medium text-[16px] text-white">{subject}</h3>
      <p className="mt-3 text-[14px] text-white/70 leading-6">{preview}</p>
      <button
        type="button"
        className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2.5 font-medium text-[#050101] text-sm"
      >
        {cta} →
      </button>
      <p className="mt-8 text-[12px] text-white/40">
        Sent to user@example.com · Unsubscribe
      </p>
    </div>
  );
}

/* ── purpose-built diagrams ───────────────────────────────────────────── */

/**
 * Activation funnel: one continuous silhouette drawn as three centered bands
 * joined by filled taper wedges. Accent red is spent only on the terminal
 * Activated band and its percentage.
 */
function ActivationFunnel(): JSX.Element {
  return (
    <svg
      viewBox="0 0 520 300"
      width="100%"
      height="auto"
      role="img"
      aria-label="Activation funnel: 100% signed up narrows to about 62% set up and 37% activated"
    >
      {/* Taper wedges — one continuous funnel silhouette behind the bands. */}
      <path
        d="M40 80 L246.5 80 L406.5 98 L113.5 98 Z"
        fill="rgba(255,255,255,0.02)"
      />
      <path
        d="M113.5 154 L406.5 154 L356 172 L164 172 Z"
        fill="rgba(255,255,255,0.02)"
      />

      {/* Band 1 — Signed up. */}
      <rect
        x="40"
        y="24"
        width="440"
        height="56"
        rx="10"
        fill="rgba(255,255,255,0.04)"
        stroke="rgba(255,255,255,0.10)"
        strokeWidth="1"
      />
      <text x="260" y="56" fill="#fff" fontSize="13" textAnchor="middle">
        Signed up
      </text>
      <text
        x="500"
        y="56"
        fill="rgba(255,255,255,0.4)"
        fontSize="12"
        fontFamily="monospace"
        textAnchor="end"
      >
        100%
      </text>

      {/* Band 2 — Set up (62%). */}
      <rect
        x="123.5"
        y="98"
        width="273"
        height="56"
        rx="10"
        fill="rgba(255,255,255,0.04)"
        stroke="rgba(255,255,255,0.10)"
        strokeWidth="1"
      />
      <text x="260" y="130" fill="#fff" fontSize="13" textAnchor="middle">
        Set up
      </text>
      <text
        x="500"
        y="130"
        fill="rgba(255,255,255,0.4)"
        fontSize="12"
        fontFamily="monospace"
        textAnchor="end"
      >
        62%
      </text>

      {/* Band 3 — Activated (37%, accent). */}
      <rect
        x="164"
        y="172"
        width="192"
        height="56"
        rx="10"
        fill="rgba(246,72,56,0.12)"
        stroke="rgba(246,72,56,0.45)"
        strokeWidth="1"
      />
      <text x="260" y="204" fill="#fff" fontSize="13" textAnchor="middle">
        Activated
      </text>
      <text
        x="500"
        y="204"
        fill="#f64838"
        fontSize="12"
        fontFamily="monospace"
        textAnchor="end"
      >
        37%
      </text>
    </svg>
  );
}

/**
 * The branch as a decision diagram: an entry node, a rhombus decision, and two
 * email cards joined by curved bezier elbows. Accent red is reserved for the
 * single activated (Yes) path, its card, its envelope glyph, and its label.
 */
function BranchDecision(): JSX.Element {
  return (
    <svg
      viewBox="0 0 640 320"
      width="100%"
      height="auto"
      role="img"
      aria-label="Decision: if setup.completed arrives within 3 days send the feature highlight, otherwise send the nudge"
    >
      {/* Connectors first, so nodes sit on top. */}
      <path
        d="M174 160 C214 160 224 160 256 160"
        stroke="rgba(255,255,255,0.18)"
        strokeWidth="1.5"
        fill="none"
      />
      <path
        d="M392 132 C440 110 450 102 470 102"
        stroke="rgba(255,255,255,0.18)"
        strokeWidth="1.5"
        fill="none"
      />
      <path
        d="M392 188 C440 210 450 222 470 222"
        stroke="#f64838"
        strokeWidth="1.5"
        fill="none"
      />

      {/* Entry node. */}
      <rect
        x="24"
        y="132"
        width="150"
        height="56"
        rx="10"
        fill="rgba(255,255,255,0.03)"
        stroke="rgba(255,255,255,0.10)"
        strokeWidth="1"
      />
      <text x="99" y="156" fill="#fff" fontSize="13" textAnchor="middle">
        user.created
      </text>
      <text
        x="99"
        y="172"
        fill="rgba(255,255,255,0.4)"
        fontSize="10"
        fontFamily="monospace"
        textAnchor="middle"
      >
        enrol
      </text>

      {/* Decision rhombus. */}
      <path
        d="M330 104 L404 160 L330 216 L256 160 Z"
        fill="rgba(255,255,255,0.02)"
        stroke="rgba(255,255,255,0.12)"
        strokeWidth="1"
      />
      <text fill="#fff" fontSize="12" textAnchor="middle">
        <tspan x="330" y="157">
          setup.completed
        </tspan>
        <tspan x="330" y="173">
          within 3 days?
        </tspan>
      </text>

      {/* Edge labels. */}
      <text
        x="430"
        y="118"
        fill="rgba(255,255,255,0.4)"
        fontSize="10"
        fontFamily="monospace"
        textAnchor="middle"
      >
        timedOut: true
      </text>
      <text
        x="430"
        y="240"
        fill="#f64838"
        fontSize="10"
        fontFamily="monospace"
        textAnchor="middle"
      >
        timedOut: false
      </text>

      {/* Top (No) email card — the nudge. */}
      <rect
        x="470"
        y="70"
        width="146"
        height="64"
        rx="10"
        fill="rgba(255,255,255,0.03)"
        stroke="rgba(255,255,255,0.10)"
        strokeWidth="1"
      />
      <rect
        x="484"
        y="86"
        width="16"
        height="12"
        rx="1.5"
        fill="none"
        stroke="rgba(255,255,255,0.4)"
        strokeWidth="1"
      />
      <path
        d="M484 87 L492 93 L500 87"
        fill="none"
        stroke="rgba(255,255,255,0.4)"
        strokeWidth="1"
      />
      <text
        x="484"
        y="120"
        fill="rgba(255,255,255,0.8)"
        fontSize="11"
        fontFamily="monospace"
      >
        ACTIVATION_NUDGE
      </text>

      {/* Bottom (Yes) email card — the feature highlight (accent). */}
      <rect
        x="470"
        y="190"
        width="146"
        height="64"
        rx="10"
        fill="rgba(246,72,56,0.10)"
        stroke="rgba(246,72,56,0.45)"
        strokeWidth="1"
      />
      <rect
        x="484"
        y="206"
        width="16"
        height="12"
        rx="1.5"
        fill="none"
        stroke="#f64838"
        strokeWidth="1"
      />
      <path
        d="M484 207 L492 213 L500 207"
        fill="none"
        stroke="#f64838"
        strokeWidth="1"
      />
      <text fill="rgba(255,255,255,0.9)" fontSize="10" fontFamily="monospace">
        <tspan x="484" y="234">
          ACTIVATION_FEATURE
        </tspan>
        <tspan x="484" y="246">
          _HIGHLIGHT
        </tspan>
      </text>
    </svg>
  );
}

/* ── code-mock line data ──────────────────────────────────────────────── */

const BRANCH_CODEMOCK_LINES = [
  {
    text: "// the wait resolves the instant the event arrives",
    tone: "comment" as const,
  },
  {
    text: "const { timedOut } = await ctx.waitForEvent({",
    tone: "keyword" as const,
  },
  { text: "  event: Events.SETUP_COMPLETED,", tone: "string" as const },
  { text: "  timeout: days(3),", tone: "plain" as const },
  { text: "})", tone: "keyword" as const },
  { text: "", tone: "plain" as const },
  {
    text: "if (timedOut) sendNudge()      // stalled",
    tone: "keyword" as const,
  },
  { text: "else          sendNextStep()  // moved", tone: "keyword" as const },
];

const BUILD_DECISION_LINES = [
  {
    text: "// park until setup, or 3 days — durably",
    tone: "comment" as const,
  },
  {
    text: "const { timedOut } = await ctx.waitForEvent({",
    tone: "keyword" as const,
  },
  { text: "  event: Events.SETUP_COMPLETED,", tone: "string" as const },
  { text: "  timeout: days(3),", tone: "plain" as const },
  { text: "})", tone: "keyword" as const },
];

const HASEVENT_LINES = [
  { text: "// has this user already activated?", tone: "comment" as const },
  {
    text: "const { found } = await ctx.history.hasEvent({",
    tone: "keyword" as const,
  },
  { text: "  userId: user.id,", tone: "plain" as const },
  { text: "  event: Events.USER_ACTIVATED,", tone: "string" as const },
  { text: "  within: days(3),", tone: "plain" as const },
  { text: "})", tone: "keyword" as const },
];

const TIMING_LINES = [
  { text: "// civil hour in the user own timezone", tone: "comment" as const },
  {
    text: 'await ctx.sleepUntil(ctx.when.tomorrow().at("09:00"))',
    tone: "keyword" as const,
  },
  { text: "", tone: "plain" as const },
  {
    text: "// floor between any two sends, in the journey meta",
    tone: "comment" as const,
  },
  { text: "suppress: hours(12),", tone: "string" as const },
];

/* ── data ─────────────────────────────────────────────────────────────── */

const WHY_STATS: { big: string; label: string }[] = [
  {
    big: "37%",
    label: "average SaaS activation rate — most signups never reach value",
  },
  {
    big: "40–60%",
    label: "of trial users never return after the first session",
  },
  {
    big: "23%",
    label: "of customer churn is blamed on weak onboarding",
  },
];

const ACTIVATION_EXAMPLES: { company: string; metric: string }[] = [
  { company: "Slack", metric: "2,000 messages → ~93% retained" },
  { company: "Facebook", metric: "7 friends in 10 days" },
  { company: "Twitter", metric: "~30 follows" },
];

const RESTRAINT_CARDS: { token: string; body: string }[] = [
  {
    token: "ctx.when",
    body: "Resolves the send time at a civil hour in the user own timezone inside a window you set, so nothing lands at 3am.",
  },
  {
    token: "suppress: hours(12)",
    body: "A hard floor under the gap between any two sends, so a burst of activity cannot fire two emails in an hour.",
  },
  {
    token: "exitOn",
    body: "Removes a user the instant they activate, even mid-wait, so the journey never congratulates someone for what it was about to nudge them about.",
  },
];

const MISTAKES: { label: string; body: ReactNode }[] = [
  {
    label: "A timed drip",
    body: "A day-3 email to everyone reaches someone active all morning with a generic check-in. Trigger on the event instead.",
  },
  {
    label: "A feature tour",
    body: "Six links produces near-zero clicks — emails with three or more CTAs convert worse. One email, one job.",
  },
  {
    label: "Never stopping",
    body: (
      <>
        Blasting non-activators forever burns your sending domain against the
        under-0.3-percent complaint rule. <InlineCode>exitOn</InlineCode> and a
        finite sequence end it at activation.
      </>
    ),
  },
  {
    label: "A no-reply sender",
    body: (
      <>
        A <InlineCode>no-reply@</InlineCode> address kills the reply signals
        providers read as engagement and hurts deliverability. Send from a
        person who reads replies.
      </>
    ),
  },
];

const FIRST_STEPS = [
  {
    n: "01",
    title: "The welcome email",
    description:
      "Your best-performing send — about 4x the opens and 8x the revenue of a bulk message. One CTA, from a person who reads replies.",
    media: (
      <MockupFrame>
        <EmailCard
          from="ada@yourapp.com"
          subject="Welcome — here's your first step"
          preview="You signed up. The fastest path to a first win is one step away."
          cta="Finish setup"
        />
      </MockupFrame>
    ),
  },
  {
    n: "02",
    title: "An activation event",
    description:
      "The single moment a user got value — a first project, message, or teammate invited. The durable wait watches for it and exitOn removes the user when it fires. Instrument it in PostHog as a typed constant so every branch reads a stable name.",
    media: <CodeMock filename="check" lines={HASEVENT_LINES} />,
  },
  {
    n: "03",
    title: "One triggered nudge",
    description:
      "Fires only for people who stalled. A single behavioral nudge beats another batch — triggered email is about 2 percent of volume but a third of revenue.",
    media: (
      <MockupFrame>
        <EmailCard
          from="ada@yourapp.com"
          subject="Stuck on setup?"
          preview="You haven't cleared the first step yet — here's the 2-minute version."
          cta="Finish setup"
        />
      </MockupFrame>
    ),
  },
  {
    n: "04",
    title: "The branch",
    description:
      "Plain TypeScript — an if/else on the timedOut flag. Stalled users get ACTIVATION_NUDGE; moving users get ACTIVATION_FEATURE_HIGHLIGHT. One file, two emails from the same wait. Sending different emails to different people roughly doubles clicks.",
    media: (
      <CodeMock
        lines={[
          {
            text: "template: timedOut ? ACTIVATION_NUDGE : ACTIVATION_FEATURE_HIGHLIGHT",
            tone: "keyword" as const,
          },
        ]}
      />
    ),
  },
  {
    n: "05",
    title: "Timing and a stop",
    description:
      "ctx.when sends at a civil hour in their timezone; suppress floors the gap between sends; exitOn stops the instant they activate. Then measure activation, not opens.",
    media: (
      <IntegrationGrid
        items={[
          { label: "PostHog identify" },
          { label: "suppress floor" },
          { label: "civil-hour window" },
          { label: "exitOn at activation" },
        ]}
      />
    ),
  },
];

const VARIANT_TABS = [
  {
    id: "stalled",
    label: "Stalled",
    title: "The timeout elapsed",
    description:
      "timedOut is true, so the journey sends ACTIVATION_NUDGE — one concrete next step and the single CTA that unblocks them.",
    tags: ["ctx.waitForEvent", "timeout: days(3)"],
    media: (
      <MockupFrame>
        <EmailCard
          from="ada@yourapp.com"
          subject="Stuck on setup?"
          preview="You haven't cleared the one blocking step yet — here's the 2-minute version."
          cta="Finish setup"
        />
      </MockupFrame>
    ),
  },
  {
    id: "moving",
    label: "Moving",
    title: "The event arrived",
    description:
      "timedOut is false, so the journey sends ACTIVATION_FEATURE_HIGHLIGHT — the next win, not a repeat of the first.",
    tags: ["ctx.waitForEvent", "resolves on the event"],
    media: (
      <MockupFrame>
        <EmailCard
          from="ada@yourapp.com"
          subject="You're set up — here's what's next"
          preview="Nice work. Here's the next thing worth trying."
          cta="Invite a teammate"
        />
      </MockupFrame>
    ),
  },
];

/* ── page ─────────────────────────────────────────────────────────────── */

export default function OnboardingGuidePage(): JSX.Element {
  return (
    <main className="flex flex-1 flex-col">
      {/* Hero — plain section, no divider. */}
      <section className="relative overflow-hidden text-white">
        <div className="container-page pt-32 pb-20">
          <Reveal>
            <SectionHeading
              eyebrow="Guide"
              title="How to do onboarding properly"
              subtitle="The onboarding sequence runs between signup and a user's first real value. This guide covers the one event to aim at, why it reacts to behavior instead of the clock, what to ship first, and how it all reads as one TypeScript file."
            />
          </Reveal>
        </div>
      </section>

      {/* Why it matters — funnel + stats. */}
      <Section id="why">
        <Reveal>
          <SectionHeading
            eyebrow="Why it matters"
            title="Most signups never reach the point of the product"
            subtitle="The average SaaS activation rate is about 37 percent. The drop is front-loaded into the first session, and weak onboarding is blamed for roughly 23 percent of churn — the largest leak in the funnel."
          />
        </Reveal>
        <Reveal delay={0.05} className="mt-6 max-w-2xl">
          <p className="text-base text-white/60 leading-6">
            It is also the highest-leverage email you send — a welcome earns
            about four times the opens and eight times the revenue of a bulk
            message — so a little work returns a lot.
          </p>
        </Reveal>
        <div className="mt-12 grid grid-cols-1 gap-10 lg:grid-cols-2 lg:items-center">
          <Reveal>
            <MockupFrame>
              <ActivationFunnel />
            </MockupFrame>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.02] sm:grid-cols-3 lg:grid-cols-1">
              {WHY_STATS.map((stat) => (
                <div key={stat.big} className="bg-[#050101] p-5">
                  <div className="font-display text-3xl text-white tracking-[-0.03em]">
                    {stat.big}
                  </div>
                  <p className="mt-1.5 text-[13px] text-white/55 leading-5">
                    {stat.label}
                  </p>
                </div>
              ))}
            </div>
          </Reveal>
        </div>
      </Section>

      {/* Start here — the activation event. */}
      <Section id="activation">
        <Reveal>
          <SectionHeading
            eyebrow="Start here"
            title="Onboard toward one activation event"
            subtitle="Before any email, name the single event that means a user got value — a first project, message, or teammate invited. The sequence watches for it, and exits on it."
          />
        </Reveal>
        <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {ACTIVATION_EXAMPLES.map((example, index) => (
            <Reveal key={example.company} delay={index * 0.05}>
              <Card>
                <span className="font-medium text-white tracking-[-0.02em]">
                  {example.company}
                </span>
                <span className="mt-1 block text-[15px] text-accent">
                  {example.metric}
                </span>
              </Card>
            </Reveal>
          ))}
        </div>
        <Reveal delay={0.15} className="mt-6 max-w-2xl">
          <p className="text-[15px] text-white/55 leading-6">
            Round figures picked where each retention curve bends — a place to
            aim, not a law. Find your bend and make that event the target.
          </p>
        </Reveal>
        <Reveal delay={0.2} className="mt-8">
          <CodeWindow
            filename="src/journeys/constants/events.ts"
            code={EVENTS_CODE}
          />
        </Reveal>
      </Section>

      {/* The core mechanic — react to the event. */}
      <Section id="triggered">
        <Reveal>
          <SectionHeading
            eyebrow="The core mechanic"
            title="React to the event, not the clock"
            subtitle="A fixed schedule can't see the product, so a day-3 email treats the all-morning power user and the no-show identically. Behavior-triggered email waits for what the user did — ctx.waitForEvent parks the journey until the event lands or the timeout passes."
          />
        </Reveal>
        <div className="mt-12 grid grid-cols-1 gap-8 lg:grid-cols-[1fr_minmax(0,540px)] lg:items-center">
          <Reveal>
            <p className="text-[15px] text-white/60 leading-6">
              It resolves the instant the event arrives, so the branch is an
              ordinary <InlineCode>if</InlineCode> on the returned{" "}
              <InlineCode>timedOut</InlineCode> flag. The wait survives restarts
              and deploys, so a user three days in is never dropped.
            </p>
          </Reveal>
          <Reveal delay={0.1}>
            <MockupFrame>
              <BranchDecision />
            </MockupFrame>
          </Reveal>
        </div>
        <Reveal delay={0.15} className="mt-8 max-w-2xl">
          <CodeMock filename="branch" lines={BRANCH_CODEMOCK_LINES} />
        </Reveal>
      </Section>

      {/* The build — one file. */}
      <Section id="build">
        <Reveal>
          <SectionHeading
            eyebrow="The build"
            title="The whole sequence is one file"
            subtitle="One file: enrol on the signup event, send the welcome, park on a durable wait for setup, branch on whether the user moved, and exit at activation. entryLimit, suppress, and exitOn handle re-signups, spacing between sends, and stopping."
          />
        </Reveal>
        <div className="mt-12 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
          <Reveal>
            <div className="flex flex-col gap-5">
              <MockupFrame>
                <EmailCard
                  from="ada@yourapp.com"
                  subject="Welcome — here's your first step"
                  preview="You signed up. The fastest path to a first win is one step away."
                  cta="Finish setup"
                />
              </MockupFrame>
              <CodeMock filename="wait + branch" lines={BUILD_DECISION_LINES} />
              <MockupFrame>
                <EmailCard
                  from="ada@yourapp.com"
                  subject="You're set up — here's what's next"
                  preview="Nice work. Here's the next thing worth trying."
                  cta="Invite a teammate"
                />
              </MockupFrame>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <CodeWindow
              filename="src/journeys/onboarding.ts"
              code={JOURNEY_CODE}
            />
          </Reveal>
        </div>
        <Reveal delay={0.15} className="mt-6 max-w-2xl">
          <p className="text-[15px] text-white/55 leading-6">
            The bare minimum is the first two stages — a welcome, then one nudge
            to whoever stalls. Ship just those; it already beats a timed drip,
            because it can see the product.
          </p>
        </Reveal>
      </Section>

      {/* In motion — the clip. */}
      <Section id="run">
        <Reveal>
          <SectionHeading
            eyebrow="In motion"
            title="The same file, executing"
            subtitle="The journey above, running as a trace — the signup enrols, the welcome sends, the durable wait parks until the setup event or the timeout, the branch picks the next email, and the result writes back to PostHog. The code on the left is the same file."
          />
        </Reveal>
        <Reveal delay={0.1} className="mt-12">
          <Clip
            clip="journey-onboarding"
            title="An onboarding journey executing: trigger, welcome send, durable wait, branch on the result, write-back to PostHog."
          />
        </Reveal>
      </Section>

      {/* What to build first — the spine. overflow-visible + no Reveal wrapper
          so the sticky left intro inside ProcessSteps actually pins. */}
      <Section id="first" className="overflow-visible">
        <ProcessSteps
          eyebrow="What to build first"
          title="Build it in this order"
          subtitle="Highest leverage first — get through the first three and you've captured most of the result. Each step names what to build and shows the artifact you're adding."
          steps={FIRST_STEPS}
        />
      </Section>

      {/* Two people, two emails — the variants. */}
      <Section id="variants">
        <Reveal>
          <SectionHeading
            eyebrow="Two people, two emails"
            title="The same wait, two outcomes"
            subtitle="One journey, two experiences from the same parked wait. Stalled users get ACTIVATION_NUDGE with one concrete next step; moving users get ACTIVATION_FEATURE_HIGHLIGHT pointing at the next win, not a repeat of the first."
          />
        </Reveal>
        <Reveal delay={0.1} className="mt-12">
          <TabbedShowcase tabs={VARIANT_TABS} />
        </Reveal>
      </Section>

      {/* Timing and restraint. */}
      <Section id="restraint">
        <Reveal>
          <SectionHeading
            eyebrow="Timing and restraint"
            title="Send at a civil hour, then stop"
            subtitle="Frequency doesn't by itself raise unsubscribes — irrelevance does. Send more, but only to people still moving. Gmail and Yahoo now require a complaint rate under about 0.3 percent, so blasting quiet users is a deliverability liability. The three controls below make stopping the default."
          />
        </Reveal>
        <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-3">
          {RESTRAINT_CARDS.map((item, index) => (
            <Reveal key={item.token} delay={index * 0.05}>
              <Card>
                <InlineCode>{item.token}</InlineCode>
                <p className="mt-3 text-[15px] text-white/60 leading-6">
                  {item.body}
                </p>
              </Card>
            </Reveal>
          ))}
        </div>
        <Reveal delay={0.2} className="mt-8">
          <CodeMock filename="timing" lines={TIMING_LINES} />
        </Reveal>
      </Section>

      {/* What to avoid. */}
      <Section id="mistakes">
        <Reveal>
          <SectionHeading
            eyebrow="What to avoid"
            title="Four ways it goes wrong"
            subtitle="The failure modes the mechanics above are built to prevent."
          />
        </Reveal>
        <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2">
          {MISTAKES.map((item, index) => (
            <Reveal key={item.label} delay={index * 0.05}>
              <Card>
                <h3 className="font-medium text-lg text-white leading-[1.3] tracking-[-0.02em]">
                  {item.label}
                </h3>
                <p className="mt-2.5 text-[15px] text-white/60 leading-6">
                  {item.body}
                </p>
              </Card>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* Closing CTA. */}
      <Section id="cta">
        <Reveal>
          <SectionHeading
            align="center"
            eyebrow="Start"
            title="Build it in your repo"
            subtitle="The journey on this page is a real Hogsend file. Scaffold a project, define your activation event in PostHog, and the welcome-then-branch minimum runs against your own data."
          />
        </Reveal>
        <Reveal
          delay={0.1}
          className="mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-4"
        >
          <Button href="/docs/getting-started" variant="accent" icon>
            Start building
          </Button>
          <Button href="/use-cases/onboarding" variant="outline">
            See the onboarding use case
          </Button>
        </Reveal>
      </Section>
    </main>
  );
}
