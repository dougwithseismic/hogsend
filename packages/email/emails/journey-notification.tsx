// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Heading, Text } from "react-email";
import type { JourneyNotificationEmailProps } from "../src/types.js";
import { Footer } from "./_components/footer.js";
import { Layout } from "./_components/layout.js";

export default function JourneyNotificationEmail({
  name = "there",
  journeyName = "Onboarding",
  eventName = "user_signed_up",
  body = "This is a journey notification.",
  unsubscribeUrl,
}: JourneyNotificationEmailProps) {
  return (
    <Layout preview={`${journeyName} — triggered by ${eventName}`}>
      <Heading className="text-2xl font-bold text-gray-900">
        {journeyName}
      </Heading>
      <Text className="text-base text-gray-600">Hey {name},</Text>
      <Text className="text-base text-gray-600">{body}</Text>
      <Footer unsubscribeUrl={unsubscribeUrl} />
    </Layout>
  );
}
