import type { Metadata } from "next";
import type { JSX } from "react";
import {
  ClosingCta,
  CodeWalkthrough,
  type FaqItem,
  JourneyRun,
  MoreUseCases,
  PointsGrid,
  ProblemStatement,
  TemplatesStrip,
  UseCaseFaq,
  UseCaseHero,
} from "../_components/use-case-sections";

export const metadata: Metadata = {
  title: "Win-back email automation in code",
  description:
    "Turn silence into a trigger: real-time inactivity buckets enroll a durable win-back journey that stops the instant users return. Self-hosted, your provider.",
};

/* Mirrors apps/api/src/buckets/went-dormant.ts — string literals stand in for
   the scaffold's Events constants; every other shape is exact. */
const BUCKET_CODE = `import { days, defineBucket } from "@hogsend/engine";

export const wentDormant = defineBucket({
  meta: {
    id: "went-dormant",
    name: "Went dormant",
    enabled: true,
    timeBased: true,
    criteria: (b) =>
      b.all(
        b.event("app.active").exists(),
        b.event("app.active").within(days(7)).notExists(),
      ),
  },
});`;

/* Mirrors apps/api/src/journeys/reactivation-dormancy.ts. */
const JOURNEY_CODE = `import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";
import { wentDormant } from "../buckets/went-dormant.js";

export const winback = defineJourney({
  meta: {
    id: "winback",
    name: "Win-back",
    enabled: true,
    trigger: { event: wentDormant.entered }, // typed ref — typos are compile errors
    entryLimit: "once_per_period",
    entryPeriod: days(60),
    exitOn: [
      { event: wentDormant.left }, // came back → exit immediately
      { event: "user.deleted" },
    ],
  },

  run: async (user, ctx) => {
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: "reactivation-checkin",
      subject: "We haven't seen you in a while",
      journeyName: user.journeyName,
    });

    await ctx.sleep({ duration: days(7), label: "offer" });

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: "conversion-winback-offer",
      subject: "See what you've been missing",
      journeyName: user.journeyName,
    });

    await ctx.sleep({ duration: days(7), label: "final" });

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: "reactivation-final-nudge",
      subject: "One last note from us",
      journeyName: user.journeyName,
    });
  },
});`;

const FAQ_ITEMS: FaqItem[] = [
  {
    q: "How do I trigger an email when a user goes inactive?",
    a: 'Define a bucket whose criteria are "was active, but no activity event within 7 days." Hogsend evaluates membership in real time, and the bucket\'s enter event triggers the win-back journey — no nightly cohort export.',
  },
  {
    q: "What if they come back mid-sequence?",
    a: "The journey declares the bucket's typed leave ref in exitOn, so the moment they're active again the run is cancelled — even mid-sleep. For a welcome-back branch instead of a silent exit, use ctx.waitForEvent({ event: \"app.active\", timeout: days(7) }) and branch on timedOut.",
  },
  {
    q: "How is this different from a PostHog cohort?",
    a: "PostHog cohorts recalculate in roughly 24-hour batches; Hogsend buckets update membership in real time and fire first-class enter/leave events that journeys can trigger on. They're complementary — a bucket can optionally mirror into a PostHog person property (off by default).",
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

export default function WinbackUseCasePage(): JSX.Element {
  return (
    <main className="flex flex-1 flex-col">
      <script
        type="application/ld+json"
        // Static literal defined above — no user input flows in.
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD
        dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_JSON_LD) }}
      />

      <UseCaseHero
        eyebrow="Use case: win-back"
        title="Win-back that knows when someone actually left"
        subhead="Inactivity isn't an event your app fires — it's the absence of one. Buckets turn “no activity for 7 days” into a trigger."
      />

      <ProblemStatement label="You can't webhook on silence">
        Webhooks tell you what happened, never what stopped happening. Most
        tools solve this with batch segments that update daily — PostHog cohorts
        recalculate in roughly 24-hour batches. A Hogsend bucket is code,
        evaluated in real time: membership changes fire first-class enter/leave
        events the moment someone crosses the line. (Buckets are segments, not a
        CDP — which is exactly enough here.)
      </ProblemStatement>

      <CodeWalkthrough
        eyebrow="The code"
        title="A bucket detects silence; a journey answers it"
        subtitle="Both mirror the dormancy pair that ships in the scaffold."
        blocks={[
          {
            filename: "src/buckets/went-dormant.ts",
            code: BUCKET_CODE,
            caption:
              "The bucket: was active once, silent for 7 days. The cron sweep owns the time-based flip — no event signals dormancy.",
          },
          {
            filename: "src/journeys/winback.ts",
            code: JOURNEY_CODE,
            caption:
              "The instant they come back, the bucket's left event matches exitOn and cancels the run — mid-sleep, mid-anything.",
          },
        ]}
      />

      <JourneyRun
        title="The same file, executing"
        subtitle="Dormancy detected, the check-in email, the plan check picking the offer — and the send that wins them back."
        clip="journey-winback"
      />

      <PointsGrid
        eyebrow="Deliverability"
        title="Know when to stop"
        points={[
          {
            title: "Suppression is built in",
            body: "Unsubscribes, bounces, and complaints hard-stop the sequence; frequency caps keep win-back from stacking on other journeys.",
          },
          {
            title: <code>once_per_period</code>,
            body: "A flapping user isn't “won back” monthly — one enrollment per 60 days, enforced by the engine.",
          },
          {
            title: "The final nudge is final",
            body: "The fastest way to lose a domain reputation is emailing people who left — and it's your domain, because it's your provider.",
          },
        ]}
      />

      <TemplatesStrip
        title="The emails it sends ship with the scaffold"
        subtitle="All 13 templates are React Email components in your repo. These three carry the win-back sequence."
        templates={[
          { slug: "reactivation-checkin", name: "Reactivation — check-in" },
          {
            slug: "conversion-winback-offer",
            name: "Conversion — win-back offer",
          },
          {
            slug: "reactivation-final-nudge",
            name: "Reactivation — final nudge",
          },
        ]}
      />

      <UseCaseFaq
        items={FAQ_ITEMS}
        links={[
          { label: "Guide: buckets", href: "/docs/guides/buckets" },
          { label: "Concept: buckets", href: "/docs/concepts/buckets" },
          { label: "Guide: lists", href: "/docs/guides/lists" },
          { label: "All 13 email templates", href: "/emails" },
        ]}
      />

      <MoreUseCases current="winback" />

      <ClosingCta
        title={
          <>
            Turn silence
            <br />
            into a trigger
          </>
        }
        subtitle="Buckets, journeys, and suppression ship in the scaffold — no nightly cohort export, and it stops the instant they return."
      />
    </main>
  );
}
