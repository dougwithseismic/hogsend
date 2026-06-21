// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Button, Callout, Divider, Title } from "./_components/ui.js";
import type { ChurnSaveEmailProps } from "./types.js";

export default function ChurnSaveEmail({
  name = "there",
  offerHeadline = "We'd love to keep you",
  offerDetail,
  ctaText = "Let's talk",
  ctaUrl = BRAND.appUrl,
  unsubscribeUrl,
}: ChurnSaveEmailProps) {
  return (
    <Layout
      preview={`${name}, we noticed you might be leaving — here's what we can do.`}
      eyebrow="A note from the team"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>{offerHeadline}</Title>
      <Body>
        Hey {name} — we saw some signals that things might not be working for
        you right now, and we didn't want to just let you go without reaching
        out.
      </Body>

      {offerDetail ? (
        <Callout tone="brand">
          <Body>{offerDetail}</Body>
        </Callout>
      ) : null}

      <Body>
        Whether it's a pricing concern, a missing feature, or just bad timing —
        we're genuinely interested in understanding what's not landing, and what
        we can do about it.
      </Body>

      <Divider />
      <Button href={ctaUrl}>{ctaText}</Button>
      <Body>
        No pressure. And if now's not the right time, we understand — we'll
        leave you to it.
      </Body>
    </Layout>
  );
}
