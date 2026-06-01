// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Button, Heading, Section, Text } from "react-email";
import { Footer } from "./_components/footer.js";
import { Layout } from "./_components/layout.js";
import type { ReactivationCheckinEmailProps } from "./types.js";

export default function ReactivationCheckinEmail({
  name = "there",
  productName = "our platform",
  daysSinceActive = 14,
  highlights = [
    "New features shipped since you've been away",
    "Your data is still here — pick up where you left off",
  ],
  returnUrl = "https://app.example.com",
  unsubscribeUrl,
}: ReactivationCheckinEmailProps) {
  return (
    <Layout
      preview={`We haven't seen you in ${daysSinceActive} days — everything okay?`}
    >
      <Heading className="text-2xl font-bold text-gray-900">
        We haven't seen you in a while
      </Heading>
      <Text className="text-base text-gray-600">
        Hey {name}, it's been {daysSinceActive} days since your last session on{" "}
        {productName}. No pressure — just checking in.
      </Text>

      <Section className="mt-4 rounded-md bg-blue-50 px-4 py-3">
        <Text className="text-sm font-semibold text-blue-900">
          While you've been away:
        </Text>
        {highlights.map((h) => (
          <Text key={h} className="my-1 text-sm text-blue-800">
            &bull; {h}
          </Text>
        ))}
      </Section>

      <Button
        href={returnUrl}
        className="mt-4 rounded-md bg-indigo-600 px-6 py-3 text-sm font-semibold text-white"
      >
        Jump Back In
      </Button>

      <Text className="mt-6 text-sm text-gray-400">
        If something isn't working right, just reply to this email. We read
        every response.
      </Text>
      <Footer unsubscribeUrl={unsubscribeUrl} />
    </Layout>
  );
}
