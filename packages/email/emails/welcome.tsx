// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Button, Heading, Text } from "react-email";
import type { WelcomeEmailProps } from "../src/types.js";
import { Footer } from "./_components/footer.js";
import { Layout } from "./_components/layout.js";

export default function WelcomeEmail({
  name = "there",
  dashboardUrl = "https://app.hogsend.com",
}: WelcomeEmailProps) {
  return (
    <Layout
      preview={`Welcome to Hogsend, ${name}! Connect PostHog events to Resend and send the right email at the right time.`}
    >
      <Heading className="text-2xl font-bold text-gray-900">
        Welcome to Hogsend
      </Heading>
      <Text className="text-base text-gray-600">
        Hey {name}, thanks for signing up. Hogsend connects your PostHog events
        to Resend so you can send the right email at the right time — without
        writing a single workflow.
      </Text>
      <Button
        href={dashboardUrl}
        className="rounded-md bg-indigo-600 px-6 py-3 text-sm font-semibold text-white"
      >
        Go to Dashboard
      </Button>
      <Footer />
    </Layout>
  );
}
