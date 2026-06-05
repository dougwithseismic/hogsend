import type { Metadata } from "next";
import { JsonLd } from "@/components/json-ld";
import { BuildingBlocks } from "@/components/landing/building-blocks";
import { Faq } from "@/components/landing/faq";
import { FinalCta } from "@/components/landing/final-cta";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { LogoStrip } from "@/components/landing/logo-strip";
import { PoweredByHatchet } from "@/components/landing/powered-by";
import { SelfHosted } from "@/components/landing/self-hosted";
import { Studio } from "@/components/landing/studio";
import { UseCases } from "@/components/landing/use-cases";
import { FAQ_ITEMS } from "@/lib/faq-data";
import { OG_IMAGE, SITE_NAME } from "@/lib/site";
import {
  faqPage,
  organization,
  softwareApplication,
  website,
} from "@/lib/structured-data";

const HOME_TITLE = "Hogsend — code-first lifecycle email for PostHog + Resend";
const HOME_DESCRIPTION =
  "The lifecycle email automation that PostHog teams actually need. Journeys and buckets as plain TypeScript functions — not YAML, not a drag-and-drop canvas. Self-hosted, open source.";

export const metadata: Metadata = {
  title: HOME_TITLE,
  description: HOME_DESCRIPTION,
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: "/",
    siteName: SITE_NAME,
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    images: [
      {
        url: OG_IMAGE,
        width: 1200,
        height: 630,
        alt: HOME_TITLE,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    images: [OG_IMAGE],
  },
};

export default function HomePage() {
  return (
    <main id="main-content" className="flex flex-1 flex-col">
      <JsonLd data={organization()} />
      <JsonLd data={website()} />
      <JsonLd data={softwareApplication()} />
      <JsonLd data={faqPage(FAQ_ITEMS)} />
      <Hero />
      <LogoStrip />
      <BuildingBlocks />
      <PoweredByHatchet />
      <UseCases />
      <HowItWorks />
      <Studio />
      <SelfHosted />
      <Faq />
      <FinalCta />
    </main>
  );
}
