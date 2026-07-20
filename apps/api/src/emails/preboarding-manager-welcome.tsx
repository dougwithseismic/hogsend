// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Layout } from "./_components/layout.js";
import { Body, Bullets, Button, Divider, Title } from "./_components/ui.js";
import type { PreboardingManagerWelcomeEmailProps } from "./types.js";

// Pre-boarding: sent between offer-signed and day one, "from" the manager.
// The CTA is a reply, because a reply is the point.
export default function PreboardingManagerWelcomeEmail({
  name = "there",
  managerName = "Sam",
  managerEmail = "sam@example.com",
  teamName = "the platform team",
  startDate = "Monday, 4 August",
  unsubscribeUrl,
}: PreboardingManagerWelcomeEmailProps) {
  return (
    <Layout
      preview={`A note from ${managerName} before your first day`}
      eyebrow="Before day one"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>We're glad you said yes</Title>
      <Body>
        Hi {name} — {managerName} here. You join {teamName} on {startDate}, and
        between now and then you don't need to do anything. This note is just so
        day one isn't the first time you hear from me.
      </Body>
      <Body>What's already sorted for you:</Body>
      <Bullets
        items={[
          "Your laptop ships this week — nothing to order",
          "Accounts and access get provisioned before you arrive",
          "Your first week has a plan; you won't be guessing what to do",
        ]}
        marker="✓"
      />
      <Divider />
      <Body>
        If anything's on your mind before you start — logistics, the work,
        anything — just hit reply. It comes straight to me.
      </Body>
      <Button href={`mailto:${managerEmail}`} variant="secondary">
        Reply to {managerName}
      </Button>
    </Layout>
  );
}
