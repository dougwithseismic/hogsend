// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Layout } from "./_components/layout.js";
import { Body, Button, Divider, Title } from "./_components/ui.js";
import type { OnboardingNudgeEmailProps } from "./types.js";

// Day-3 nudge sent when the user hasn't activated their key feature yet.
// The feature name is set by the onboarding-concierge agent at send time.
export default function OnboardingNudgeEmail({
  name = "there",
  featureName = "the key feature",
  ctaText = "Try it now",
  ctaUrl = "https://app.example.com",
  unsubscribeUrl,
}: OnboardingNudgeEmailProps) {
  return (
    <Layout
      preview={`${name}, you haven't tried ${featureName} yet — here's a nudge.`}
      eyebrow="Quick nudge"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>Still haven't tried {featureName}?</Title>
      <Body>
        Hey {name} — it's been a few days and we noticed you haven't activated{" "}
        {featureName} yet. It's usually the thing that makes everything click.
      </Body>
      <Body>Takes less than five minutes. Want to give it a shot?</Body>
      <Divider />
      <Button href={ctaUrl}>{ctaText}</Button>
      <Body>If you've hit a snag, just reply — we're happy to help.</Body>
    </Layout>
  );
}
