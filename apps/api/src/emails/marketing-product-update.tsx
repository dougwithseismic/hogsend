// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Button, Divider, Title } from "./_components/ui.js";
import type { MarketingProductUpdateProps } from "./types.js";

export default function MarketingProductUpdate({
  name = "there",
  headline = "What shipped in Hogsend this month",
  body = "A quick roundup of everything new — buckets, email tracking, and a brand-new public API for sending mail and managing contacts straight from your code.",
  ctaUrl = `${BRAND.siteUrl}/changelog`,
  ctaText = "Read the full changelog",
  unsubscribeUrl,
  preferencesUrl,
}: MarketingProductUpdateProps) {
  return (
    <Layout
      preview={headline}
      eyebrow="Product update"
      unsubscribeUrl={unsubscribeUrl}
      preferencesUrl={preferencesUrl}
    >
      <Title>{headline}</Title>
      <Body>Hey {name},</Body>
      <Body>{body}</Body>
      <Divider />
      <Button href={ctaUrl}>{ctaText}</Button>
      <Body>
        You're getting this because you opted in to product updates from{" "}
        {BRAND.name}. Not your thing anymore? Use the link below to update what
        you hear from us.
      </Body>
    </Layout>
  );
}
