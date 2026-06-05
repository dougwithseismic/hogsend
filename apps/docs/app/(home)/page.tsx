import type { Metadata } from "next";
import { BuildingBlocks } from "@/components/landing/building-blocks";
import { Faq } from "@/components/landing/faq";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { LogoStrip } from "@/components/landing/logo-strip";
import { SelfHosted } from "@/components/landing/self-hosted";
import { Studio } from "@/components/landing/studio";
import { UseCases } from "@/components/landing/use-cases";

export const metadata: Metadata = {
  title: "Hogsend — code-first lifecycle email for PostHog + Resend",
  description:
    "The lifecycle email automation that PostHog teams actually need. Journeys and buckets as plain TypeScript functions — not YAML, not a drag-and-drop canvas. Self-hosted, open source.",
};

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <Hero />
      <LogoStrip />
      <BuildingBlocks />
      <UseCases />
      <HowItWorks />
      <Studio />
      <SelfHosted />
      <Faq />
    </main>
  );
}
