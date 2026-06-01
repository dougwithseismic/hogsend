// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Button, Heading, Section, Text } from "react-email";
import { Footer } from "./_components/footer.js";
import { Layout } from "./_components/layout.js";
import type { ConversionWinbackOfferEmailProps } from "./types.js";

export default function ConversionWinbackOfferEmail({
  name = "there",
  productName = "our platform",
  discountPercent = 20,
  offerUrl = "https://app.example.com/offer",
  expiresIn = "48 hours",
  unsubscribeUrl,
}: ConversionWinbackOfferEmailProps) {
  return (
    <Layout
      preview={`${discountPercent}% off ${productName} — limited time offer`}
    >
      <Heading className="text-2xl font-bold text-gray-900">
        We'd love to have you back
      </Heading>
      <Text className="text-base text-gray-600">
        Hey {name}, your trial recently ended. We know timing isn't always right
        — so here's a little incentive.
      </Text>

      <Section className="mt-4 rounded-md bg-indigo-50 px-6 py-5 text-center">
        <Text className="text-3xl font-bold text-indigo-600">
          {discountPercent}% off
        </Text>
        <Text className="mt-1 text-sm text-indigo-800">
          your first month or annual plan
        </Text>
        <Text className="mt-1 text-xs text-indigo-600">
          Expires in {expiresIn}
        </Text>
      </Section>

      <Button
        href={offerUrl}
        className="mt-4 rounded-md bg-indigo-600 px-6 py-3 text-sm font-semibold text-white"
      >
        Claim Your Discount
      </Button>

      <Text className="mt-6 text-sm text-gray-400">
        If you have any questions, just reply to this email. We're here to help.
      </Text>
      <Footer unsubscribeUrl={unsubscribeUrl} />
    </Layout>
  );
}
