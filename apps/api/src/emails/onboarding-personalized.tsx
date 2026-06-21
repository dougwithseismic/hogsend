// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Button, Callout, Divider, Title } from "./_components/ui.js";
import type { OnboardingPersonalizedEmailProps } from "./types.js";

export default function OnboardingPersonalizedEmail({
  name = "there",
  subject: _subject,
  body,
  ctaText = "Get started",
  ctaUrl = BRAND.quickstartUrl,
  tips,
  unsubscribeUrl,
}: OnboardingPersonalizedEmailProps) {
  return (
    <Layout
      preview={`Hey ${name} — a quick note personalized for you.`}
      eyebrow="Welcome"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>Welcome to Hogsend, {name}</Title>
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
