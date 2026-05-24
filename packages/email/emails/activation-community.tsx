// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Button, Heading, Section, Text } from "react-email";
import type { ActivationCommunityEmailProps } from "../src/types.js";
import { Footer } from "./_components/footer.js";
import { Layout } from "./_components/layout.js";

export default function ActivationCommunityEmail({
  name = "there",
  productName = "our platform",
  communityUrl = "https://discord.gg/example",
  communityName = "our Discord",
  memberCount = "2,000+",
  highlights = [
    "Get help from other users and the team",
    "Share tips, strategies, and feedback",
    "Be the first to hear about new features",
  ],
  unsubscribeUrl,
}: ActivationCommunityEmailProps) {
  return (
    <Layout preview={`Join ${memberCount} members in ${communityName}`}>
      <Heading className="text-2xl font-bold text-gray-900">
        Join the {productName} community
      </Heading>
      <Text className="text-base text-gray-600">
        Hey {name}, you're not in this alone. {memberCount} people are already
        hanging out in {communityName}.
      </Text>

      <Section className="mt-4 rounded-md bg-indigo-50 px-4 py-3">
        <Text className="text-sm font-semibold text-indigo-900">
          What happens there:
        </Text>
        {highlights.map((h) => (
          <Text key={h} className="my-1 text-sm text-indigo-800">
            &bull; {h}
          </Text>
        ))}
      </Section>

      <Button
        href={communityUrl}
        className="mt-4 rounded-md bg-indigo-600 px-6 py-3 text-sm font-semibold text-white"
      >
        Join {communityName}
      </Button>
      <Footer unsubscribeUrl={unsubscribeUrl} />
    </Layout>
  );
}
