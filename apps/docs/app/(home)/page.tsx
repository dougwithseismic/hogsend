import type { Metadata } from "next";
import { CodeHighlight } from "@/components/ds/code-highlight";
import { BuildingBlocks } from "@/components/landing/building-blocks";
import { BuiltFor } from "@/components/landing/built-for";
import { ClosingCta } from "@/components/landing/closing-cta";
import { Economics } from "@/components/landing/economics";
import { FAQ_ITEMS, Faq } from "@/components/landing/faq";
import { FeatureCards } from "@/components/landing/feature-cards";
import { GrowthLessons } from "@/components/landing/growth-lessons";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { LiveDemo } from "@/components/landing/live-demo";
import { LogoStrip } from "@/components/landing/logo-strip";
import { Manifesto } from "@/components/landing/manifesto";
import { MoreOutOfPostHog } from "@/components/landing/more-out-of-posthog";
import { Pillars } from "@/components/landing/pillars";
import { PoweredByHatchet } from "@/components/landing/powered-by";
import { ProofGrid } from "@/components/landing/proof-grid";
import { ProofStrip } from "@/components/landing/proof-strip";
import {
  type ProviderValue,
  UseCasePicker,
  type UseCaseValue,
} from "@/components/landing/use-case-picker";
import { UseCases } from "@/components/landing/use-cases";
import { WhyThisMatters } from "@/components/landing/why-this-matters";

export const metadata: Metadata = {
  title: {
    absolute: "Hogsend — The lifecycle email layer PostHog doesn't have yet",
  },
  description:
    "Welcome series, trial nudges, win-backs, payment saves — running from your repo on PostHog and product events, sent through your own Resend or Postmark account. Free to self-host.",
};

// FAQPage structured data mirrors the visible FAQ copy verbatim (it reads
// from the same FAQ_ITEMS array the accordion renders).
const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ_ITEMS.map((item) => ({
    "@type": "Question",
    name: item.q,
    acceptedAnswer: {
      "@type": "Answer",
      text: item.a,
    },
  })),
};

/* Journey samples for the use-case picker — shortened from the use-case
   pages' JOURNEY_CODE constants, faithful to the real API (defineJourney,
   ctx.waitForEvent, ctx.sleep, ctx.history, sendEmail, days()). */
const JOURNEY_SAMPLES: Record<UseCaseValue, string> = {
  onboarding: `import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";

export const onboarding = defineJourney({
  meta: {
    id: "onboarding",
    trigger: { event: "user.signed_up" },
    entryLimit: "once",
    exitOn: [{ event: "user.deleted" }],
  },
  run: async (user, ctx) => {
    await sendEmail({ to: user.email, template: "activation-quickstart" });

    // Park durably until THIS user creates a project — or 3 days pass.
    const { timedOut } = await ctx.waitForEvent({
      event: "project.created",
      timeout: days(3),
    });

    await sendEmail({
      to: user.email,
      template: timedOut ? "activation-nudge" : "activation-feature-highlight",
    });
  },
});`,
  trial_conversion: `import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";

export const trialConversion = defineJourney({
  meta: {
    id: "trial-conversion",
    trigger: { event: "trial.started" },
    entryLimit: "once",
    // Paid? The journey is cancelled — even mid-wait.
    exitOn: [{ event: "subscription.created" }],
  },
  run: async (user, ctx) => {
    await ctx.sleep({ duration: days(3), label: "usage-check" });

    const { found } = await ctx.history.hasEvent({
      userId: user.id,
      event: "usage.milestone_reached",
    });
    if (found) {
      // They've found value — ask while it's fresh.
      await sendEmail({ to: user.email, template: "conversion-usage-milestone" });
    }

    await ctx.sleep({ duration: days(7), label: "trial-ending" });
    await sendEmail({ to: user.email, template: "conversion-trial-expiring" });
  },
});`,
  winback: `import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";
import { wentDormant } from "../buckets/went-dormant.js";

export const winback = defineJourney({
  meta: {
    id: "winback",
    trigger: { event: wentDormant.entered }, // typed bucket ref
    entryLimit: "once_per_period",
    entryPeriod: days(60),
    // Came back? Exit immediately — even mid-sleep.
    exitOn: [{ event: wentDormant.left }],
  },
  run: async (user, ctx) => {
    await sendEmail({ to: user.email, template: "reactivation-checkin" });

    await ctx.sleep({ duration: days(7), label: "offer" });
    await sendEmail({ to: user.email, template: "conversion-winback-offer" });

    await ctx.sleep({ duration: days(7), label: "final" });
    await sendEmail({ to: user.email, template: "reactivation-final-nudge" });
  },
});`,
};

/* Provider choice is config, not journey code — the toggle swaps only this. */
const ENV_SAMPLES: Record<ProviderValue, string> = {
  resend: `# provider is config, not journey code
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_…`,
  postmark: `# provider is config, not journey code
EMAIL_PROVIDER=postmark
POSTMARK_SERVER_TOKEN=…`,
};

/** Renders the async CodeHighlight RSC nodes and hands them to the client
 * picker — the same composition pattern as BuildingBlocks → TabbedShowcase. */
async function UseCasePickerSection() {
  const [onboarding, trialConversion, winback, resendEnv, postmarkEnv] =
    await Promise.all([
      CodeHighlight({ code: JOURNEY_SAMPLES.onboarding, lang: "ts" }),
      CodeHighlight({ code: JOURNEY_SAMPLES.trial_conversion, lang: "ts" }),
      CodeHighlight({ code: JOURNEY_SAMPLES.winback, lang: "ts" }),
      CodeHighlight({ code: ENV_SAMPLES.resend, lang: "bash" }),
      CodeHighlight({ code: ENV_SAMPLES.postmark, lang: "bash" }),
    ]);

  return (
    <UseCasePicker
      journeys={{
        onboarding,
        trial_conversion: trialConversion,
        winback,
      }}
      envs={{ resend: resendEnv, postmark: postmarkEnv }}
    />
  );
}

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD built from our own constants
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />

      <Hero />
      <LogoStrip />
      <ProofStrip />
      <Manifesto />
      <WhyThisMatters />
      <UseCases />
      <UseCasePickerSection />
      <LiveDemo />
      <MoreOutOfPostHog />
      <BuildingBlocks />
      <FeatureCards />
      <HowItWorks />
      <GrowthLessons />
      <Pillars />
      <PoweredByHatchet />
      <Economics />
      <ProofGrid />
      <BuiltFor />
      <Faq />
      <ClosingCta />
    </main>
  );
}
