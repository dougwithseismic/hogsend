import type { Metadata } from "next";
import type { JSX } from "react";
import { ClosingCta } from "../use-cases/_components/use-case-sections";
import { GrowthExplainer } from "./_components/growth-explainer";
import { GrowthHero } from "./_components/growth-hero";

export const metadata: Metadata = {
  title: "Growth metrics: interactive calculators & glossary",
  description:
    "Interactive calculators for LTV, CAC, NRR, K-factor and the rest — plus a practitioner glossary and the lifecycle lever behind every metric. Drag an input and watch the others move.",
};

/* FAQ + glossary structured data — drawn straight from the page's calculators
   and cheatsheet so the rich result mirrors what a reader sees. */
const FAQ_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "What is a good LTV:CAC ratio?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Around 3:1 is the healthy band. Below 1:1 you are lighting money on fire — each customer costs more than they are worth. Above 5:1 usually means you are under-investing in growth and could afford to spend more to acquire. Always use gross-margin LTV, not revenue LTV.",
      },
    },
    {
      "@type": "Question",
      name: "Why is blended CAC misleading?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Blended CAC folds free organic customers into the denominator, so it understates the cost of the customer your next budget actually buys. It is fine as a board headline, but budget on marginal (paid) CAC — the cost of the next customer, which rises with saturation. As you scale paid spend, blended drifts up to meet paid.",
      },
    },
    {
      "@type": "Question",
      name: "What is net revenue retention (NRR) and what is a good benchmark?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "NRR is revenue from your existing customers over time: (start + expansion − contraction − churn) ÷ start MRR. Above 100% means you grow even if you acquire no new logos, because expansion outpaces churn. Elite SaaS companies run 120%+.",
      },
    },
    {
      "@type": "Question",
      name: "How does K-factor lower CAC?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "K-factor is invites per user × invite-to-signup conversion. It injects free customers, so your effective CAC ≈ paid CAC × (1 − K). Even a sub-viral loop (K below 1) amplifies every paid cohort by 1 ÷ (1 − K); at K = 1 growth becomes self-sustaining and exponential.",
      },
    },
    {
      "@type": "Question",
      name: "How does lifecycle email improve these metrics?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Every metric here has a lifecycle lever. Behaviour-driven onboarding lifts the activation rate, which cascades into retention, referral and LTV; win-back and dunning cut churn, which sits in the denominator of LTV and raises your affordable-CAC ceiling. In Hogsend each lever is one durable TypeScript journey triggered by your PostHog events.",
      },
    },
  ],
};

const TERMS_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "DefinedTermSet",
  name: "Growth metrics glossary",
  hasDefinedTerm: [
    {
      "@type": "DefinedTerm",
      name: "CAC",
      description:
        "Customer acquisition cost — fully-loaded sales-and-marketing spend ÷ new customers. Fully-loaded means salaries, tools and overhead, not just media.",
    },
    {
      "@type": "DefinedTerm",
      name: "Blended CAC",
      description:
        "CAC across paid and organic together (total spend ÷ all new customers). Always ≤ paid CAC because free customers dilute the denominator; good for a board headline, dangerous for budgeting.",
    },
    {
      "@type": "DefinedTerm",
      name: "LTV",
      description:
        "Lifetime value — the gross-margin value of a customer over their lifetime: ARPA × gross margin ÷ churn. Churn sits in the denominator, so LTV is hypersensitive to it.",
    },
    {
      "@type": "DefinedTerm",
      name: "LTV:CAC",
      description:
        "The return on each acquired customer (LTV ÷ CAC). About 3:1 is healthy, below 1:1 is unsustainable, and above 5:1 signals under-investment in growth.",
    },
    {
      "@type": "DefinedTerm",
      name: "CAC payback",
      description:
        "Months to recoup acquisition cost: CAC ÷ (ARPA × gross margin). The cash-velocity question, separate from LTV:CAC — under 12 months is strong for SMB, 18–24 months tolerable for enterprise.",
    },
    {
      "@type": "DefinedTerm",
      name: "NRR",
      description:
        "Net revenue retention — (start + expansion − contraction − churn) ÷ start MRR. Above 100% you grow with zero new logos; 120%+ is elite.",
    },
    {
      "@type": "DefinedTerm",
      name: "GRR",
      description:
        "Gross revenue retention — (start − contraction − churn) ÷ start MRR. Caps at 100% and shows the true leakage rate with no upsell masking; best-in-class is above 90%.",
    },
    {
      "@type": "DefinedTerm",
      name: "K-factor",
      description:
        "Virality coefficient — invites per user × invite-to-signup conversion. K above 1 is self-sustaining exponential growth; K below 1 still amplifies every paid cohort.",
    },
  ],
};

export default function GrowthMetricsPage(): JSX.Element {
  return (
    <main className="flex flex-1 flex-col">
      <script
        type="application/ld+json"
        // Static literal defined above — no user input flows in.
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD
        dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_JSON_LD) }}
      />
      <script
        type="application/ld+json"
        // Static literal defined above — no user input flows in.
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD
        dangerouslySetInnerHTML={{ __html: JSON.stringify(TERMS_JSON_LD) }}
      />

      <GrowthHero />
      <GrowthExplainer />

      <ClosingCta
        title="Ship the lever, not just the metric"
        subtitle="The scaffold ships 10 journeys and 13 templates — onboarding, win-back, dunning, digests — every one a durable TypeScript file you can review in a PR."
      />
    </main>
  );
}
