// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Button, Heading, Hr, Section, Text } from "react-email";
import { Footer } from "./_components/footer.js";
import { Layout } from "./_components/layout.js";
import type { ConversionUsageMilestoneEmailProps } from "./types.js";

export default function ConversionUsageMilestoneEmail({
  name = "there",
  productName = "our platform",
  usageCount = 5,
  usageLabel = "sessions",
  usageLimit,
  proFeatures = ["Unlimited usage", "Advanced analytics", "Priority support"],
  upgradeUrl = "https://app.example.com/upgrade",
  unsubscribeUrl,
}: ConversionUsageMilestoneEmailProps) {
  return (
    <Layout
      preview={`You've completed ${usageCount} ${usageLabel} — here's what's next`}
    >
      <Heading className="text-2xl font-bold text-gray-900">
        You're on a roll
      </Heading>
      <Text className="text-base text-gray-600">
        Hey {name}, you've hit {usageCount} {usageLabel}
        {usageLimit ? ` out of ${usageLimit} on the free plan` : ""}. Nice work.
      </Text>

      {usageLimit && (
        <Section className="mt-4 rounded-md bg-amber-50 px-4 py-3">
          <Text className="text-sm text-amber-800">
            You've used {usageCount} of {usageLimit} free {usageLabel}. Upgrade
            to keep going without interruption.
          </Text>
        </Section>
      )}

      <Hr className="my-6 border-gray-200" />

      <Text className="text-base font-semibold text-gray-800">
        What you unlock with {productName} Pro:
      </Text>
      {proFeatures.map((feature) => (
        <Text key={feature} className="my-1 text-base text-gray-600">
          &bull; {feature}
        </Text>
      ))}

      <Button
        href={upgradeUrl}
        className="mt-4 rounded-md bg-indigo-600 px-6 py-3 text-sm font-semibold text-white"
      >
        Upgrade Now
      </Button>
      <Footer unsubscribeUrl={unsubscribeUrl} />
    </Layout>
  );
}
