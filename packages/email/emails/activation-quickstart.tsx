// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Button, Heading, Text } from "react-email";
import type { ActivationQuickstartEmailProps } from "../src/types.js";
import { Footer } from "./_components/footer.js";
import { Layout } from "./_components/layout.js";

export default function ActivationQuickstartEmail({
  name = "there",
  productName = "our platform",
  quickstartUrl = "https://app.example.com/quickstart",
  setupSteps = [
    "Connect your data source",
    "Configure your first workflow",
    "Send a test email",
  ],
  unsubscribeUrl,
}: ActivationQuickstartEmailProps) {
  return (
    <Layout
      preview={`Welcome to ${productName}! Get set up in under 5 minutes.`}
    >
      <Heading className="text-2xl font-bold text-gray-900">
        Welcome to {productName}
      </Heading>
      <Text className="text-base text-gray-600">
        Hey {name}, thanks for signing up. Let's get you up and running — it
        takes less than 5 minutes.
      </Text>
      <Text className="text-base font-semibold text-gray-800">
        Here's what to do first:
      </Text>
      {setupSteps.map((step, i) => (
        <Text key={step} className="my-1 text-base text-gray-600">
          {i + 1}. {step}
        </Text>
      ))}
      <Button
        href={quickstartUrl}
        className="mt-4 rounded-md bg-indigo-600 px-6 py-3 text-sm font-semibold text-white"
      >
        Get Started
      </Button>
      <Text className="mt-6 text-sm text-gray-400">
        You'll receive a few more emails over the next week to help you get the
        most out of {productName}. You can unsubscribe at any time.
      </Text>
      <Footer unsubscribeUrl={unsubscribeUrl} />
    </Layout>
  );
}
