import { Survey } from "@hogsend/email";
// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Section } from "react-email";
import { Events } from "../journeys/constants/index.js";
import { Layout } from "./_components/layout.js";
import { Body, Title } from "./_components/ui.js";
import type { FeedbackDidThisHelpEmailProps } from "./types.js";

// The smallest possible survey: yes/no, one event, answer readable by the
// journey that sent it (`help.answered { helped: true|false }`).
export default function FeedbackDidThisHelpEmail({
  name = "there",
  subjectLabel = "the setup guide we sent",
  unsubscribeUrl,
}: FeedbackDidThisHelpEmailProps) {
  return (
    <Layout
      preview="Yes or no — that's the whole survey"
      eyebrow="One click"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>Did {subjectLabel} actually help?</Title>
      <Body>
        Hey {name} — honest answer, one click, no follow-up form. "No" is just
        as useful to us as "yes".
      </Body>
      <Section className="my-6 text-center">
        <Survey
          event={Events.HELP_ANSWERED}
          mode="yesno"
          property="helped"
          className="mx-2 mb-1 inline-block rounded-lg border border-solid border-zinc-200 bg-white px-8 py-3 text-sm font-semibold text-zinc-800 no-underline"
        />
      </Section>
      <Body>
        If it's a no, the journey that sent this routes you to a human next —
        that's the point of asking.
      </Body>
    </Layout>
  );
}
