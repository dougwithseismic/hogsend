// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Button, Callout, Divider, Title } from "./_components/ui.js";
import type { ReengageTipBEmailProps } from "./types.js";

export default function ReengageTipBEmail({
  name = "there",
  useCase = "AI-driven journeys that decide which email to send next",
  useCaseDetail,
  ctaText = "See the example",
  ctaUrl = BRAND.docsUrl,
  unsubscribeUrl,
}: ReengageTipBEmailProps) {
  return (
    <Layout
      preview={`${name}, here's an advanced Hogsend pattern worth a look.`}
      eyebrow="Power user tip"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>An advanced pattern you might not have tried</Title>
      <Body>
        Hey {name} — based on your setup, we think this advanced use case could
        be exactly what you're looking for:
      </Body>

      <Callout tone="brand">
        <Body>{useCase}</Body>
        {useCaseDetail ? <Body>{useCaseDetail}</Body> : null}
      </Callout>

      <Body>
        Teams using this pattern report significantly tighter engagement loops
        with a fraction of the manual work.
      </Body>
      <Divider />
      <Button href={ctaUrl}>{ctaText}</Button>
      <Body>
        Want a walkthrough? Just reply — happy to show you how to set it up.
      </Body>
    </Layout>
  );
}
