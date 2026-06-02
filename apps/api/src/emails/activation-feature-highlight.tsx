// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Text } from "react-email";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Button, Callout, Divider, Title } from "./_components/ui.js";
import type { ActivationFeatureHighlightEmailProps } from "./types.js";

export default function ActivationFeatureHighlightEmail({
  name = "there",
  featureName = "journeys-as-code",
  featureDescription = "Most lifecycle tools make you click through a flowchart builder. In Hogsend, a journey is just a TypeScript function — so it lives in your repo, runs through code review, and diffs in a pull request like everything else you ship.",
  beforeText = "Drag boxes around a canvas, hope the export matches what's in staging, screenshot it for the next standup.",
  afterText = "Open an editor, write control flow you already understand, commit it. The journey is the source of truth.",
  ctaUrl = BRAND.docsUrl,
  ctaText = "See how journeys work",
  unsubscribeUrl,
}: ActivationFeatureHighlightEmailProps) {
  return (
    <Layout
      preview={`A Hogsend superpower: ${featureName}`}
      eyebrow="Worth a look"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>Have you tried {featureName}?</Title>
      <Body>Hey {name},</Body>
      <Body>{featureDescription}</Body>

      <Callout tone="danger">
        <Text className="m-0 text-xs font-semibold uppercase tracking-wide text-red-600">
          The old way
        </Text>
        <Text className="m-0 mt-1 text-sm leading-6 text-zinc-700">
          {beforeText}
        </Text>
      </Callout>
      <Callout tone="success">
        <Text className="m-0 text-xs font-semibold uppercase tracking-wide text-emerald-600">
          With Hogsend
        </Text>
        <Text className="m-0 mt-1 text-sm leading-6 text-zinc-700">
          {afterText}
        </Text>
      </Callout>

      <Divider />
      <Button href={ctaUrl}>{ctaText}</Button>
    </Layout>
  );
}
