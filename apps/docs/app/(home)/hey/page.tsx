import type { Metadata } from "next";
import type { JSX } from "react";
import { ReferralLanding } from "./_components/hey-sections";

/**
 * Bare /hey — someone will type it. Renders the generic (unpersonalised)
 * referral landing; same noindex posture as /hey/[name].
 */
export const metadata: Metadata = {
  title: "Are the lifecycle basics running?",
  description:
    "A note passed on by a builder you know — welcome series, trial nudges, win-backs, payment saves, running from your repo.",
  // Personalised page family — never indexed.
  robots: { index: false, follow: false },
};

export default function HeyPage(): JSX.Element {
  return <ReferralLanding name={null} />;
}
