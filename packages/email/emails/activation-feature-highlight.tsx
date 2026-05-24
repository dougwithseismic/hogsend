// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Button, Heading, Hr, Section, Text } from "react-email";
import type { ActivationFeatureHighlightEmailProps } from "../src/types.js";
import { Footer } from "./_components/footer.js";
import { Layout } from "./_components/layout.js";

export default function ActivationFeatureHighlightEmail({
  name = "there",
  productName = "our platform",
  featureName = "the key feature",
  featureDescription = "This feature helps you work smarter, not harder.",
  beforeText = "Before: Manually tracking everything in spreadsheets.",
  afterText = "After: Automated insights delivered to your inbox.",
  ctaUrl = "https://app.example.com",
  ctaText = "Try it now",
  unsubscribeUrl,
}: ActivationFeatureHighlightEmailProps) {
  return (
    <Layout
      preview={`${featureName} on ${productName} — see what it can do for you`}
    >
      <Heading className="text-2xl font-bold text-gray-900">
        Have you tried {featureName}?
      </Heading>
      <Text className="text-base text-gray-600">Hey {name},</Text>
      <Text className="text-base text-gray-600">{featureDescription}</Text>

      <Section className="mt-4 rounded-md bg-gray-50 px-4 py-3">
        <Text className="text-sm font-semibold text-red-600">Before</Text>
        <Text className="mt-1 text-sm text-gray-600">{beforeText}</Text>
      </Section>
      <Section className="mt-2 rounded-md bg-gray-50 px-4 py-3">
        <Text className="text-sm font-semibold text-green-600">After</Text>
        <Text className="mt-1 text-sm text-gray-600">{afterText}</Text>
      </Section>

      <Hr className="my-6 border-gray-200" />

      <Button
        href={ctaUrl}
        className="rounded-md bg-indigo-600 px-6 py-3 text-sm font-semibold text-white"
      >
        {ctaText}
      </Button>
      <Footer unsubscribeUrl={unsubscribeUrl} />
    </Layout>
  );
}
