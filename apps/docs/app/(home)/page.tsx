import type { Metadata } from "next";
import { BuildingBlocks } from "@/components/landing/building-blocks";
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
import { Pillars } from "@/components/landing/pillars";
import { PoweredByHatchet } from "@/components/landing/powered-by";
import { ProofGrid } from "@/components/landing/proof-grid";
import { ProofStrip } from "@/components/landing/proof-strip";
import { UseCases } from "@/components/landing/use-cases";

export const metadata: Metadata = {
  title: {
    absolute: "Hogsend — Lifecycle email, shipped like a feature",
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

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD built from our own constants
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />

      <Hero />
      <LiveDemo />
      <LogoStrip />
      <ProofStrip />
      <Manifesto />
      <UseCases />
      <BuildingBlocks />
      <FeatureCards />
      <HowItWorks />
      <GrowthLessons />
      <Pillars />
      <PoweredByHatchet />
      <Economics />
      <ProofGrid />
      <Faq />
      <ClosingCta />
    </main>
  );
}
