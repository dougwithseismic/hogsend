// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Layout } from "./_components/layout.js";
import { Body, Bullets, Button, Divider, Title } from "./_components/ui.js";
import type { ProductUpdateEmailProps } from "./types.js";

// Marketing starter — CONTENT, yours to edit. Rendered for the
// `marketing/product-update` key (see `./registry.ts`). Its `category` is
// `product-updates`, matching the `productUpdates` list in `src/lists/index.ts`,
// so a broadcast via `hs.campaigns.send({ list: "product-updates", ... })` only
// reaches contacts subscribed to that list.
export default function ProductUpdateEmail({
  name = "there",
  headline = "What's new this month",
  intro = "A few things we shipped recently that we think you'll like.",
  highlights = [
    "Faster journey enrollment",
    "A redesigned preference center",
    "New webhook sources",
  ],
  ctaUrl = "https://app.example.com/changelog",
  ctaText = "See the full changelog",
  unsubscribeUrl,
}: ProductUpdateEmailProps) {
  return (
    <Layout
      preview={headline}
      eyebrow="Product update"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>{headline}</Title>
      <Body>Hey {name},</Body>
      <Body>{intro}</Body>

      <Bullets items={highlights} />

      <Divider />
      <Button href={ctaUrl}>{ctaText}</Button>
    </Layout>
  );
}
