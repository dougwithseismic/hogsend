// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Button, Heading, Hr, Section, Text } from "react-email";
import type { ConversionTrialExpiringEmailProps } from "../src/types.js";
import { Footer } from "./_components/footer.js";
import { Layout } from "./_components/layout.js";

export default function ConversionTrialExpiringEmail({
  name = "there",
  productName = "our platform",
  daysLeft = 3,
  trialEndDate = "soon",
  valueSummary = [
    "12 sessions completed",
    "3 reports generated",
    "2 automations running",
  ],
  upgradeUrl = "https://app.example.com/upgrade",
  unsubscribeUrl,
}: ConversionTrialExpiringEmailProps) {
  return (
    <Layout
      preview={`Your ${productName} trial ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`}
    >
      <Heading className="text-2xl font-bold text-gray-900">
        Your trial ends {daysLeft === 1 ? "tomorrow" : `in ${daysLeft} days`}
      </Heading>
      <Text className="text-base text-gray-600">
        Hey {name}, your {productName} trial wraps up on {trialEndDate}. Here's
        what you've accomplished so far:
      </Text>

      <Section className="mt-4 rounded-md bg-green-50 px-4 py-3">
        <Text className="text-sm font-semibold text-green-900">
          Your progress
        </Text>
        {valueSummary.map((item) => (
          <Text key={item} className="my-1 text-sm text-green-800">
            &bull; {item}
          </Text>
        ))}
      </Section>

      <Hr className="my-6 border-gray-200" />

      <Text className="text-base text-gray-600">
        Don't lose your progress. Upgrade now to keep everything running.
      </Text>

      <Button
        href={upgradeUrl}
        className="rounded-md bg-indigo-600 px-6 py-3 text-sm font-semibold text-white"
      >
        Upgrade Now
      </Button>
      <Footer unsubscribeUrl={unsubscribeUrl} />
    </Layout>
  );
}
