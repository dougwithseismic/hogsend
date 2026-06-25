import type { Metadata } from "next";
import type { JSX } from "react";
import { ReferralLanding } from "../_components/hey-sections";
import { displayNameFromSlug, sanitizeRefParam } from "../_components/name";

/**
 * Personalised referral landing — /hey/<first-name>, the URL printed in the
 * docs-referral-ask email. The raw segment never appears in metadata (PII +
 * garbage risk); an unusable segment falls back to the generic page body.
 */
export const metadata: Metadata = {
  title: "Are the lifecycle basics running?",
  description:
    "A note passed on by a builder you know — welcome series, trial nudges, win-backs, payment saves, running from your repo.",
  // Personalised page — never indexed.
  robots: { index: false, follow: false },
};

export default async function HeyNamePage(props: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ ref?: string | string[] }>;
}): Promise<JSX.Element> {
  const { name } = await props.params;
  const { ref } = await props.searchParams;
  return (
    <ReferralLanding
      name={displayNameFromSlug(name)}
      refKey={sanitizeRefParam(ref)}
    />
  );
}
