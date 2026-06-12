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
  title: "Onboarding emails in TypeScript",
  description:
    "Behavior-driven onboarding from PostHog events: durable TypeScript journeys that wait for activation and nudge only the users who actually stall.",
};

/* Mirrors apps/api/src/journeys/activation-welcome.ts — string literals stand
   in for the scaffold's Events/Templates constants; every other shape is
   exact. */
const JOURNEY_CODE = `import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";

export const onboarding = defineJourney({
  meta: {
    id: "onboarding",
    name: "Onboarding",
    enabled: true,
    trigger: { event: "user.signed_up" },
    entryLimit: "once",
    exitOn: [{ event: "user.deleted" }],
  },

  run: async (user, ctx) => {
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: "activation-quickstart",
      subject: "Welcome — here's the shortest path to a first win",
      journeyName: user.journeyName,
    });

    // Park the journey — durably — until THIS user creates a project,
    // or 3 days pass. Survives deploys, restarts, and crashes.
    const { timedOut } = await ctx.waitForEvent({
      event: "project.created",
      timeout: days(3),
    });

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: timedOut ? "activation-nudge" : "activation-feature-highlight",
      subject: timedOut
        ? "Stuck? Here's the 2-minute version"
        : "Nice — here's what to try next",
      journeyName: user.journeyName,
    });

    await ctx.sleep({ duration: days(4), label: "pre-community" });

    // Re-check after the long wait — unsubscribes don't exit a journey.
    if (await ctx.guard.isSubscribed()) {
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: "activation-community",
        subject: "Join the community",
        journeyName: user.journeyName,
      });
    }
  },
});`;

const FAQ_ITEMS: FaqItem[] = [
  {
    q: "How do I trigger onboarding emails from PostHog?",
    a: "Point a PostHog webhook destination at your Hogsend ingest endpoint; the user.signed_up event enrolls users in the journey automatically. Signup events can also come from Clerk or Supabase via built-in signed presets, or from your own backend via the Data API.",
  },
  {
    q: "Can the sequence skip users who already activated?",
    a: "Yes — ctx.waitForEvent resolves the moment the activation event fires and the journey branches, and ctx.history.hasEvent checks whether it already happened before the wait began. Activated users get the next-step email instead of the nudge.",
  },
  {
    q: "What happens if I deploy mid-sequence?",
    a: "Nothing bad. Journeys are Hatchet durable tasks, so a user on day 2 of a 3-day wait keeps waiting across deploys and restarts and resumes exactly where they were.",
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

export default function OnboardingUseCasePage(): JSX.Element {
  return (
    <main className="flex flex-1 flex-col">
      <script
        type="application/ld+json"
        // Static literal defined above — no user input flows in.
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD
        dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_JSON_LD) }}
      />

      <UseCaseHero
        eyebrow="Use case: onboarding"
        title="Onboarding that waits for behavior, not the calendar"
        subhead="Day-2, day-4, day-7 drips email everyone the same. A journey watches what each user actually does — in TypeScript you can read."
      />

      <ProblemStatement label="The drip problem">
        A timed sequence sends “how's it going?” to someone who's been in the
        product all morning, and “just checking in!” to someone who churned at
        signup. Both are the same bug: the sequence can't see product events —
        and your product events are in PostHog. The fix isn't better copy. It's
        branching, and branching is code.
      </ProblemStatement>

      <CodeWalkthrough
        eyebrow="The journey"
        title="The whole sequence is one file"
        subtitle="It mirrors the welcome journey that ships in the scaffold — trigger, durable wait, branch, exit."
        blocks={[
          {
            filename: "src/journeys/onboarding.ts",
            code: JOURNEY_CODE,
            caption:
              "Trigger, durable wait, branch — one file, one reviewable diff.",
          },
        ]}
      />

      <JourneyRun
        title="The same file, executing"
        subtitle="Enrol, send, a durable wait that resolves when the project lands, branch, write-back to PostHog."
        clip="journey-onboarding"
      />

      <PointsGrid
        eyebrow="In production"
        title="Why it holds up"
        points={[
          {
            title: <code>ctx.waitForEvent</code>,
            body: "Parks the journey durably until the user acts — or doesn't. The branch is an if statement.",
          },
          {
            title: <code>exitOn</code>,
            body: "Removes anyone who deletes their account mid-sequence, even mid-wait.",
          },
          {
            title: "Entry limits",
            body: (
              <>
                <code>entryLimit: "once"</code> means re-signups don't get
                re-welcomed.
              </>
            ),
          },
          {
            title: <code>ctx.when</code>,
            body: "Times any send to 9am in their timezone, inside your send window — timezone auto-resolved from PostHog person properties, then the contact, then your default.",
          },
        ]}
      />

      <TemplatesStrip
        title="The emails it sends ship with the scaffold"
        subtitle="All 13 templates are React Email components in your repo. These four cover activation — edit them like any other component."
        templates={[
          { slug: "activation-quickstart", name: "Activation — quickstart" },
          { slug: "activation-nudge", name: "Activation — nudge" },
          {
            slug: "activation-feature-highlight",
            name: "Activation — feature highlight",
          },
          { slug: "activation-community", name: "Activation — community" },
        ]}
      />

      <UseCaseFaq
        items={FAQ_ITEMS}
        links={[
          {
            label: "Recipe: lifecycle journeys",
            href: "/docs/recipes/lifecycle-journeys",
          },
          { label: "Guide: journeys", href: "/docs/guides/journeys" },
          {
            label: "Integration: Clerk",
            href: "/docs/integrations/clerk",
          },
          { label: "All 13 email templates", href: "/emails" },
        ]}
      />

      <MoreUseCases current="onboarding" />

      <ClosingCta
        title={
          <>
            Onboarding your team
            <br />
            can code-review
          </>
        }
        subtitle="The scaffold ships 10 journeys and 13 templates to start from — including a welcome sequence shaped like this one."
      />
    </main>
  );
}
