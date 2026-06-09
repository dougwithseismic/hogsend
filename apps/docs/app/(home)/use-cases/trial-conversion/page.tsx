import type { Metadata } from "next";
import Link from "next/link";
import type { JSX } from "react";
import {
  ClosingCta,
  CodeWalkthrough,
  type FaqItem,
  MoreUseCases,
  PointsGrid,
  ProblemStatement,
  TemplatesStrip,
  UseCaseFaq,
  UseCaseHero,
} from "../_components/use-case-sections";

export const metadata: Metadata = {
  title: "Trial conversion emails in TypeScript",
  description:
    "Trial emails that react to product usage: durable waits, behavioral branching, timezone-aware sends, instant exit the moment they pay. Plain TypeScript.",
};

/* Mirrors apps/api/src/journeys/conversion-trial-upgrade.ts — string literals
   stand in for the scaffold's Events/Templates constants; every other shape
   is exact. */
const JOURNEY_CODE = `import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";

export const trialConversion = defineJourney({
  meta: {
    id: "trial-conversion",
    name: "Trial conversion",
    enabled: true,
    trigger: { event: "trial.started" },
    entryLimit: "once",
    exitOn: [
      // The built-in Stripe preset feeds this in — the journey is
      // cancelled the moment they pay, even mid-wait.
      { event: "subscription.created" },
      { event: "user.deleted" },
    ],
  },

  run: async (user, ctx) => {
    await ctx.sleep({ duration: days(3), label: "usage-check" });

    const { found: hitMilestone } = await ctx.history.hasEvent({
      userId: user.id,
      event: "usage.milestone_reached",
    });

    if (hitMilestone) {
      // The upgrade ask, at the moment of value — not the deadline.
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: "conversion-usage-milestone",
        subject: "You're on a roll — here's what the paid plan unlocks",
        journeyName: user.journeyName,
      });
    }

    await ctx.sleep({ duration: days(7), label: "trial-ending" });

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: "conversion-trial-expiring",
      subject: "Your trial ends in 3 days — don't lose your progress",
      journeyName: user.journeyName,
    });
  },
});`;

const FAQ_ITEMS: FaqItem[] = [
  {
    q: "How do I stop trial emails the moment someone pays?",
    a: 'Declare exitOn: [{ event: "subscription.created" }] in the journey meta. The built-in Stripe webhook preset feeds the event in, and Hogsend cancels the journey immediately — even if it\'s mid-wait.',
  },
  {
    q: "Can I send the trial-ending email at a good local time?",
    a: 'Yes — ctx.when resolves the user\'s timezone (PostHog person property → contact → default) and respects your configured send window, so "3 days before expiry at 9am" means their 9am.',
  },
  {
    q: "Does this work without Stripe?",
    a: "Yes. Any event source works — push subscription.created from your backend via the Data API or @hogsend/client, or from a custom webhook source.",
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

export default function TrialConversionUseCasePage(): JSX.Element {
  return (
    <main className="flex flex-1 flex-col">
      <script
        type="application/ld+json"
        // Static literal defined above — no user input flows in.
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD
        dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_JSON_LD) }}
      />

      <UseCaseHero
        eyebrow="Use case: trial conversion"
        title="Trial emails driven by usage, not days remaining"
        subhead="“Your trial ends in 3 days” converts nobody who hasn't found value. Branch on what they did; stop the second they pay."
      />

      <ProblemStatement label="Countdown spam is a state machine with one state">
        Every trial email tool can count down. The conversion question is
        behavioral: did they hit the milestone that predicts paying? If yes, ask
        early. If no, sell the milestone — not the deadline. That requires your
        email tool to see product usage, and to stop instantly when Stripe says
        they paid.
      </ProblemStatement>

      <CodeWalkthrough
        eyebrow="The journey"
        title="Branch on usage; exit on payment"
        subtitle="It mirrors the trial-upgrade journey that ships in the scaffold."
        blocks={[
          {
            filename: "src/journeys/trial-conversion.ts",
            code: JOURNEY_CODE,
            caption:
              "exitOn: subscription.created cancels the journey mid-wait — nobody gets a “trial ending!” email after their card was charged.",
          },
        ]}
        note={
          <>
            For “3 days before expiry at <em>their</em> 9am”, swap the fixed
            sleep for <code>ctx.sleepUntil(...)</code> with{" "}
            <code>ctx.when</code> — the timezone-aware fluent scheduler that
            respects your configured send window. See the{" "}
            <Link
              href="/docs/guides/journeys"
              className="text-white underline decoration-white/30 underline-offset-4 transition-colors hover:decoration-white"
            >
              journeys guide
            </Link>
            .
          </>
        }
      />

      <PointsGrid
        eyebrow="Measurement"
        title="Measure what matters"
        points={[
          {
            title: "Branch on behavior, not opens",
            body: "Clicks and conversion events are reliable; opens are directional — Apple Mail Privacy Protection inflates them. The milestone event is the signal worth branching on.",
          },
          {
            title: "Conversions, via PostHog",
            body: (
              <>
                Conversion events fan out to PostHog — and on to Meta or Google
                via PostHog's Destinations pipeline. See{" "}
                <Link
                  href="/docs/conversions"
                  className="text-white underline decoration-white/30 underline-offset-4 transition-colors hover:decoration-white"
                >
                  conversion tracking
                </Link>
                .
              </>
            ),
          },
          {
            title: (
              <>
                Chain journeys with <code>ctx.trigger</code>
              </>
            ),
            body: "ctx.trigger chains converts straight into onboarding and non-converts into win-back.",
          },
        ]}
      />

      <TemplatesStrip
        title="The emails it sends ship with the scaffold"
        subtitle="All 13 templates are React Email components in your repo. These three carry the conversion sequence."
        templates={[
          {
            slug: "conversion-usage-milestone",
            name: "Conversion — usage milestone",
          },
          {
            slug: "conversion-trial-expiring",
            name: "Conversion — trial expiring",
          },
          {
            slug: "conversion-winback-offer",
            name: "Conversion — win-back offer",
          },
        ]}
      />

      <UseCaseFaq
        items={FAQ_ITEMS}
        links={[
          { label: "Integration: Stripe", href: "/docs/integrations/stripe" },
          { label: "Guide: conditions", href: "/docs/guides/conditions" },
          {
            label: "Recipe: lifecycle journeys",
            href: "/docs/recipes/lifecycle-journeys",
          },
          { label: "Conversion tracking", href: "/docs/conversions" },
          { label: "All 13 email templates", href: "/emails" },
        ]}
      />

      <MoreUseCases current="trial-conversion" />

      <ClosingCta
        title={
          <>
            Trial emails that stop
            <br />
            when Stripe says stop
          </>
        }
        subtitle="The scaffold ships 10 journeys and 13 templates to start from — wire the Stripe preset and the upgrade sequence is one reviewable file."
      />
    </main>
  );
}
