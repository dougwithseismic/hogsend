import { Survey } from "@hogsend/email";
// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Section, Text } from "react-email";
import { Events } from "../journeys/constants/index.js";
import { Layout } from "./_components/layout.js";
import { Body, Title } from "./_components/ui.js";
import type { FeedbackCsatEmailProps } from "./types.js";

// CSAT via the Survey component: five one-click anchors sharing one event.
// The chosen score arrives as `csat.submitted { score }` — the journey reads
// it straight from ctx.waitForEvent.
export default function FeedbackCsatEmail({
  name = "there",
  interactionLabel = "your support conversation yesterday",
  unsubscribeUrl,
}: FeedbackCsatEmailProps) {
  return (
    <Layout
      preview="One tap: how did we do?"
      eyebrow="30-second question"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>How was {interactionLabel}?</Title>
      <Body>
        Hey {name} — one tap and you're done. The answer goes straight to the
        person who helped you, not into a dashboard nobody opens.
      </Body>
      <Section className="my-6 text-center">
        <Survey
          event={Events.CSAT_SUBMITTED}
          mode="scale"
          property="score"
          min={1}
          max={5}
          className="mx-1 mb-1 inline-block h-10 w-10 rounded-lg border border-solid border-zinc-200 bg-white text-center text-sm font-semibold leading-10 text-zinc-700 no-underline"
        />
        <Text className="m-0 mt-2 text-xs text-zinc-400">
          1 = rough&nbsp;&nbsp;·&nbsp;&nbsp;5 = great
        </Text>
      </Section>
    </Layout>
  );
}
