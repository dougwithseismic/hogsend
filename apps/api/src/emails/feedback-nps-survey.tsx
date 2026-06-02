// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Link, Section, Text } from "react-email";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Title } from "./_components/ui.js";
import type { FeedbackNpsSurveyEmailProps } from "./types.js";

export default function FeedbackNpsSurveyEmail({
  name = "there",
  surveyUrl = `${BRAND.siteUrl}/nps`,
  unsubscribeUrl,
}: FeedbackNpsSurveyEmailProps) {
  const scores = Array.from({ length: 11 }, (_, i) => i);

  return (
    <Layout
      preview="Quick question — how likely are you to recommend Hogsend?"
      eyebrow="One quick question"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>How are we doing?</Title>
      <Body>
        Hey {name} — how likely are you to recommend Hogsend to another
        developer or team? Tap a number; it takes one click.
      </Body>

      <Section className="my-6 text-center">
        {scores.map((score) => (
          <Link
            key={score}
            href={`${surveyUrl}?score=${score}`}
            className="mx-0.5 mb-1 inline-block h-9 w-9 rounded-lg border border-solid border-zinc-200 bg-white text-center text-sm font-semibold leading-9 text-zinc-700 no-underline"
          >
            {String(score)}
          </Link>
        ))}
        <Section className="mt-2">
          <Text className="m-0 text-xs text-zinc-400">
            0 = not likely&nbsp;&nbsp;·&nbsp;&nbsp;10 = extremely likely
          </Text>
        </Section>
      </Section>

      <Body>
        Whatever you pick, you'll get a chance to tell us why — and that's what
        actually shapes the roadmap. Thank you.
      </Body>
    </Layout>
  );
}
