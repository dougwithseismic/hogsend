import type { Metadata } from "next";
import { getEngineVersion } from "@/lib/engine-version";
import { LandingHero } from "./landing-hero";

/**
 * Spike — the homepage hero on the day-field.
 * The real Hogsend hero (nav, agent terminal, install, works-with) moved onto
 * the hour-lit vista. Not linked from nav; noindex.
 */
export const metadata: Metadata = {
  title: "Spike — homepage hero on the day-field",
  robots: { index: false, follow: false },
};

export default async function SpikeLandingPage() {
  const engineVersion = await getEngineVersion();
  return <LandingHero engineVersion={engineVersion} />;
}
