// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Button, Heading, Section, Text } from "react-email";
import { Footer } from "./_components/footer.js";
import { Layout } from "./_components/layout.js";
import type { RetentionAchievementEmailProps } from "./types.js";

export default function RetentionAchievementEmail({
  name = "there",
  productName = "our platform",
  achievementName = "First Milestone",
  achievementDescription = "You've reached an impressive milestone!",
  stat,
  previousStat,
  shareUrl,
  ctaUrl = "https://app.example.com",
  ctaText = "Keep going",
  unsubscribeUrl,
}: RetentionAchievementEmailProps) {
  return (
    <Layout preview={`${achievementName} on ${productName} — congratulations!`}>
      <Section className="text-center">
        <Text className="text-4xl">&#127942;</Text>
        <Heading className="text-2xl font-bold text-gray-900">
          {achievementName}
        </Heading>
      </Section>

      <Text className="text-base text-gray-600">
        Hey {name}, {achievementDescription}
      </Text>

      {stat && (
        <Section className="mt-4 rounded-md bg-green-50 px-6 py-4 text-center">
          <Text className="text-2xl font-bold text-green-700">{stat}</Text>
          {previousStat && (
            <Text className="mt-1 text-sm text-green-600">
              Previous best: {previousStat}
            </Text>
          )}
        </Section>
      )}

      <Section className="mt-4 text-center">
        <Button
          href={ctaUrl}
          className="rounded-md bg-indigo-600 px-6 py-3 text-sm font-semibold text-white"
        >
          {ctaText}
        </Button>
      </Section>

      {shareUrl && (
        <Text className="mt-4 text-center text-sm text-gray-500">
          <a href={shareUrl} className="text-indigo-600 underline">
            Share this achievement
          </a>
        </Text>
      )}
      <Footer unsubscribeUrl={unsubscribeUrl} />
    </Layout>
  );
}
