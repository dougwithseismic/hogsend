// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Section, Text } from "react-email";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Button, Title } from "./_components/ui.js";
import type { RetentionAchievementEmailProps } from "./types.js";

export default function RetentionAchievementEmail({
  name = "there",
  achievementName = "10,000 emails delivered",
  achievementDescription = "Your journeys just crossed a serious milestone — that's ten thousand on-time, on-trigger emails sent without you touching a thing.",
  stat = "10,000",
  previousStat,
  shareUrl,
  ctaUrl = BRAND.appUrl,
  ctaText = "Open your dashboard",
  unsubscribeUrl,
}: RetentionAchievementEmailProps) {
  return (
    <Layout
      preview={`${achievementName} — nice work`}
      eyebrow="Milestone unlocked"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Section className="text-center">
        <Text className="m-0 text-[40px] leading-none">&#127881;</Text>
      </Section>
      <Title>{achievementName}</Title>
      <Body>
        Hey {name} — {achievementDescription}
      </Body>

      {stat && (
        <Section className="my-6 rounded-2xl border border-solid border-zinc-200 bg-zinc-50 px-6 py-6 text-center">
          <Text className="m-0 text-[34px] font-bold leading-none text-zinc-900">
            {stat}
          </Text>
          {previousStat && (
            <Text className="m-0 mt-2 text-sm text-zinc-500">
              Previous best: {previousStat}
            </Text>
          )}
        </Section>
      )}

      <Section className="text-center">
        <Button href={ctaUrl}>{ctaText}</Button>
      </Section>

      {shareUrl && (
        <Text className="mt-5 text-center text-sm text-zinc-500">
          <a href={shareUrl} className="font-semibold text-zinc-900 underline">
            Share the milestone
          </a>
        </Text>
      )}
    </Layout>
  );
}
