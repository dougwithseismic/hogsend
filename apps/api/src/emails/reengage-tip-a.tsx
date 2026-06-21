// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Button, Callout, Divider, Title } from "./_components/ui.js";
import type { ReengageTipAEmailProps } from "./types.js";

export default function ReengageTipAEmail({
  name = "there",
  tip = "Set up frequency caps so your journeys never over-mail a contact",
  tipDetail,
  ctaText = "Try it now",
  ctaUrl = BRAND.docsUrl,
  unsubscribeUrl,
}: ReengageTipAEmailProps) {
  return (
    <Layout
      preview={`${name}, here's a quick win to get more out of Hogsend.`}
      eyebrow="Quick win"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>A quick win while you were away</Title>
      <Body>
        Hey {name} — it's been a little while. Here's one thing that teams like
        yours find immediately useful:
      </Body>

      <Callout tone="brand">
        <Body>{tip}</Body>
        {tipDetail ? <Body>{tipDetail}</Body> : null}
      </Callout>

      <Divider />
      <Button href={ctaUrl}>{ctaText}</Button>
      <Body>Questions? Reply here — a real person reads every message.</Body>
    </Layout>
  );
}
