// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Text } from "react-email";
import { Layout } from "./_components/layout.js";
import { Body, Callout, Title } from "./_components/ui.js";
import type { JourneyNotificationEmailProps } from "./types.js";

// Generic fallback used when a journey sends without a dedicated template — it
// surfaces the journey + triggering event so the message is still useful.
export default function JourneyNotificationEmail({
  name = "there",
  journeyName = "Onboarding",
  eventName = "user.created",
  body = "This is a journey notification.",
  unsubscribeUrl,
}: JourneyNotificationEmailProps) {
  return (
    <Layout
      preview={`${journeyName} — triggered by ${eventName}`}
      eyebrow={journeyName}
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>{journeyName}</Title>
      <Body>Hey {name},</Body>
      <Body>{body}</Body>
      <Callout>
        <Text className="m-0 font-mono text-xs text-zinc-500">
          triggered by {eventName}
        </Text>
      </Callout>
    </Layout>
  );
}
