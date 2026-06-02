// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Text } from "react-email";
import { Layout } from "./_components/layout.js";
import { Body, Button, Callout, Title } from "./_components/ui.js";
import type { ActivationNudgeEmailProps } from "./types.js";

// Starter template — CONTENT, yours to edit. Rendered for the `activation/nudge`
// key (see `./registry.ts`). Delete or rewrite freely.
export default function ActivationNudgeEmail({
  name = "there",
  featureName = "the key feature",
  nudgeMessage = "Most users see results within their first session. Here's how to get started.",
  ctaUrl = "https://app.example.com",
  ctaText = "Try it now",
  helpUrl,
  unsubscribeUrl,
}: ActivationNudgeEmailProps) {
  return (
    <Layout
      preview={`You haven't tried ${featureName} yet`}
      eyebrow="A quick nudge"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>You haven't tried {featureName} yet</Title>
      <Body>Hey {name},</Body>
      <Body>{nudgeMessage}</Body>
      <Button href={ctaUrl}>{ctaText}</Button>

      {helpUrl && (
        <Callout tone="warn">
          <Text className="m-0 text-sm leading-6 text-amber-900">
            Having trouble getting set up?{" "}
            <a
              href={helpUrl}
              className="font-semibold text-amber-950 underline"
            >
              Check out our setup guide
            </a>{" "}
            or reply to this email — we're happy to help.
          </Text>
        </Callout>
      )}
    </Layout>
  );
}
