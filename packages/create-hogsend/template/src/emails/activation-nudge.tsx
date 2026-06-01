// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Button, Heading, Section, Text } from "react-email";
import { Footer } from "./_components/footer.js";
import { Layout } from "./_components/layout.js";
import type { ActivationNudgeEmailProps } from "./types.js";

// Starter template — CONTENT, yours to edit. Rendered for the `activation/nudge`
// key (see `./registry.ts`). Delete or rewrite freely.
export default function ActivationNudgeEmail({
  name = "there",
  featureName = "the key feature",
  nudgeMessage = "Most users see results within their first session. Here's how to get started.",
  ctaUrl = "https://app.example.com",
  ctaText = "Try it now",
  helpUrl,
  unsubscribeUrl,
}: ActivationNudgeEmailProps) {
  return (
    <Layout preview={`You haven't tried ${featureName} yet`}>
      <Heading className="text-2xl font-bold text-gray-900">
        You haven't tried {featureName} yet
      </Heading>
      <Text className="text-base text-gray-600">Hey {name},</Text>
      <Text className="text-base text-gray-600">{nudgeMessage}</Text>

      <Button
        href={ctaUrl}
        className="mt-4 rounded-md bg-indigo-600 px-6 py-3 text-sm font-semibold text-white"
      >
        {ctaText}
      </Button>

      {helpUrl && (
        <Section className="mt-6 rounded-md bg-yellow-50 px-4 py-3">
          <Text className="text-sm text-yellow-800">
            Having trouble getting set up?{" "}
            <a
              href={helpUrl}
              className="font-semibold text-yellow-900 underline"
            >
              Check out our setup guide
            </a>{" "}
            or reply to this email — we're happy to help.
          </Text>
        </Section>
      )}
      <Footer unsubscribeUrl={unsubscribeUrl} />
    </Layout>
  );
}
