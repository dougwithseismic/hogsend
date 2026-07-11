import type { Metadata } from "next";
import type { JSX } from "react";
import { LiveDemo } from "@/components/landing/live-demo";
import {
  AgentSection,
  FinalCta,
  FireForgetHero,
  Gotchas,
  Premise,
  ThePath,
} from "./_components/fire-and-forget-sections";

export const metadata: Metadata = {
  title: "Fire and forget — lifecycle marketing built for agents",
  description:
    "Fresh domain to production lifecycle email in about thirty minutes — no mailbox provider, no Google account. Every step is a command with a checkable result, so an agent can run the whole thing.",
  alternates: { canonical: "/fire-and-forget" },
  keywords: [
    "lifecycle email",
    "marketing automation for developers",
    "email automation",
    "ai agents",
    "agentic marketing",
    "self-hosted",
    "code-first",
    "resend",
  ],
};

export default function FireAndForgetPage(): JSX.Element {
  return (
    <main className="flex flex-1 flex-col">
      <FireForgetHero />
      <Premise />
      <ThePath />
      <Gotchas />
      <AgentSection />
      <LiveDemo />
      <FinalCta />
    </main>
  );
}
