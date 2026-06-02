// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Section, Text } from "react-email";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Button, Title } from "./_components/ui.js";
import type { ConversionWinbackOfferEmailProps } from "./types.js";

export default function ConversionWinbackOfferEmail({
  name = "there",
  discountPercent = 20,
  offerUrl = `${BRAND.siteUrl}/pricing`,
  expiresIn = "48 hours",
  unsubscribeUrl,
}: ConversionWinbackOfferEmailProps) {
  return (
    <Layout
      preview={`${discountPercent}% off Hogsend Cloud — for a limited time`}
      eyebrow="A little nudge"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>Come back to Hogsend?</Title>
      <Body>
        Hey {name} — your trial ended without upgrading, and that's completely
        fair. Timing matters. If it was the price, here's something to make the
        decision easier.
      </Body>

      <Section className="my-6 rounded-2xl border border-solid border-orange-200 bg-orange-50 px-6 py-7 text-center">
        <Text className="m-0 text-[40px] font-bold leading-none text-orange-600">
          {discountPercent}% off
        </Text>
        <Text className="m-0 mt-2 text-sm text-orange-900">
          your first year of Hogsend Cloud
        </Text>
        <Text className="m-0 mt-1 text-xs font-medium uppercase tracking-wide text-orange-500">
          Expires in {expiresIn}
        </Text>
      </Section>

      <Section className="text-center">
        <Button href={offerUrl}>Claim the discount</Button>
      </Section>

      <Body>
        Your journeys and data are exactly where you left them — claiming this
        just turns the lights back on. Questions? Reply anytime.
      </Body>
    </Layout>
  );
}
