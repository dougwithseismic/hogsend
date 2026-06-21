// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Layout } from "./_components/layout.js";
import { Body, Button, Callout, Divider, Title } from "./_components/ui.js";
import type { OnboardingPersonalizedEmailProps } from "./types.js";

// AI-personalised onboarding template. The subject line and body copy are
// drafted by the onboarding-concierge agent in `src/agents/`; the template
// owns the markup, layout, and chrome — the model only fills typed slots.
export default function OnboardingPersonalizedEmail({
  name = "there",
  subject: _subject,
  body,
  tips,
  ctaText = "Get started",
  ctaUrl = "https://app.example.com",
  unsubscribeUrl,
}: OnboardingPersonalizedEmailProps) {
  return (
    <Layout
      preview={`Hey ${name} — a quick note personalized for you.`}
      eyebrow="Welcome"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>
        Welcome to {"{{APP_NAME}}"}, {name}
      </Title>
      {body ? (
        <Body>{body}</Body>
      ) : (
        <Body>
          We put together a few things based on what we know about your setup —
          here's where we'd suggest you start.
        </Body>
      )}

      {tips && tips.length > 0 ? (
        <Callout tone="brand">
          {tips.map((tip, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static tip list
            <Body key={i}>{tip}</Body>
          ))}
        </Callout>
      ) : null}

      <Divider />
      <Button href={ctaUrl}>{ctaText}</Button>
      <Body>
        Questions? Reply to this email — a real person reads every one.
      </Body>
    </Layout>
  );
}
