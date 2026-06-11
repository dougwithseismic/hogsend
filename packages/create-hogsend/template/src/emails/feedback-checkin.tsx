import { EmailAction } from "@hogsend/email";
// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Section } from "react-email";
import { Events } from "../journeys/constants/index.js";
import { Layout } from "./_components/layout.js";
import { Body, Title } from "./_components/ui.js";
import type { FeedbackCheckinEmailProps } from "./types.js";

// Starter template — CONTENT, yours to edit. Demonstrates SEMANTIC LINKS:
// each answer is an `EmailAction` — an anchor whose click fires a real event
// (`checkin.answered { answer }`) through the full ingest pipeline. The
// engine lifts the metadata at send time and the journey reacts via
// `ctx.waitForEvent` (see `src/journeys/feedback-checkin.ts`). First answer
// per send wins; scanner click-bursts are suppressed automatically.
export default function FeedbackCheckinEmail({
  name = "there",
  landingUrl = "https://app.example.com/thanks",
  unsubscribeUrl,
}: FeedbackCheckinEmailProps) {
  const buttonClass =
    "mx-1 inline-block rounded-lg border border-solid border-zinc-200 bg-white px-5 py-2 text-sm font-semibold text-zinc-700 no-underline";

  return (
    <Layout
      preview="One-tap question: how's it going so far?"
      eyebrow="Quick check-in"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>How's it going so far?</Title>
      <Body>
        Hey {name} — one tap, honest answer. Are you getting what you came
        for?
      </Body>

      <Section className="my-6 text-center">
        <EmailAction
          event={Events.CHECKIN_ANSWERED}
          properties={{ answer: "yes" }}
          href={landingUrl}
          className={buttonClass}
        >
          Going great
        </EmailAction>
        <EmailAction
          event={Events.CHECKIN_ANSWERED}
          properties={{ answer: "no" }}
          href={landingUrl}
          className={buttonClass}
        >
          I'm stuck
        </EmailAction>
      </Section>

      <Body>Whichever you pick, we read every answer. Thank you.</Body>
    </Layout>
  );
}
