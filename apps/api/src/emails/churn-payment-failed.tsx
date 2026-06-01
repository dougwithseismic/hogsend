// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Button, Heading, Hr, Section, Text } from "react-email";
import { Footer } from "./_components/footer.js";
import { Layout } from "./_components/layout.js";
import type { ChurnPaymentFailedEmailProps } from "./types.js";

export default function ChurnPaymentFailedEmail({
  name = "there",
  productName = "our platform",
  retryUrl = "https://app.example.com/billing/retry",
  updatePaymentUrl = "https://app.example.com/billing/payment-method",
  gracePeriodDays = 3,
  unsubscribeUrl,
}: ChurnPaymentFailedEmailProps) {
  return (
    <Layout preview="Your recent payment didn't go through">
      <Heading className="text-2xl font-bold text-gray-900">
        Payment issue
      </Heading>
      <Text className="text-base text-gray-600">
        Hey {name}, your most recent payment for {productName} didn't go
        through. This happens — expired cards, bank flags, the usual.
      </Text>

      <Section className="mt-4 rounded-md bg-red-50 px-4 py-3">
        <Text className="text-sm text-red-800">
          Your account will be downgraded in {gracePeriodDays} day
          {gracePeriodDays === 1 ? "" : "s"} if we can't process payment.
        </Text>
      </Section>

      <Section className="mt-4">
        <Button
          href={retryUrl}
          className="rounded-md bg-indigo-600 px-6 py-3 text-sm font-semibold text-white"
        >
          Retry Payment
        </Button>
      </Section>

      <Hr className="my-6 border-gray-200" />

      <Text className="text-sm text-gray-600">
        Need to update your card?{" "}
        <a
          href={updatePaymentUrl}
          className="font-semibold text-indigo-600 underline"
        >
          Update payment method
        </a>
      </Text>

      <Text className="mt-4 text-sm text-gray-400">
        If you think this is a mistake, just reply to this email and we'll sort
        it out.
      </Text>
      <Footer unsubscribeUrl={unsubscribeUrl} />
    </Layout>
  );
}
