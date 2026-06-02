// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Text } from "react-email";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Bullets, Button, Callout, Title } from "./_components/ui.js";
import type { ReactivationCheckinEmailProps } from "./types.js";

export default function ReactivationCheckinEmail({
  name = "there",
  daysSinceActive = 14,
  highlights = [
    "Frequency caps so journeys never over-mail a contact",
    "First-party open & click tracking baked into every send",
    "Agentic-ready journeys you can drive from an LLM or script",
  ],
  returnUrl = BRAND.appUrl,
  unsubscribeUrl,
}: ReactivationCheckinEmailProps) {
  return (
    <Layout
      preview={`Your Hogsend project has been quiet for ${daysSinceActive} days`}
      eyebrow="Checking in"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>Your project's gone quiet</Title>
      <Body>
        Hey {name} — Hogsend hasn't processed an event from your project in
        about {daysSinceActive} days. No pressure at all; just making sure
        nothing broke on your side.
      </Body>

      <Callout tone="brand">
        <Text className="m-0 text-xs font-semibold uppercase tracking-wide text-orange-600">
          Shipped while you were away
        </Text>
        <Bullets items={highlights} />
      </Callout>

      <Body>
        Your journeys and contacts are all still here — pick up exactly where
        you left off.
      </Body>
      <Button href={returnUrl}>Jump back in</Button>
      <Body>
        If something did break, reply to this email and we'll dig in with you.
      </Body>
    </Layout>
  );
}
