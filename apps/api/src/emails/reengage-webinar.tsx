// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Button, Callout, Divider, Title } from "./_components/ui.js";
import type { ReengageWebinarEmailProps } from "./types.js";

export default function ReengageWebinarEmail({
  name = "there",
  webinarTitle = "Hogsend Live: Get Your First Journey Running",
  webinarDate,
  webinarDescription = "A 30-minute live session where we walk through setting up your first journey from scratch — with time for your questions.",
  registerUrl = BRAND.appUrl,
  ctaText = "Save my spot",
  unsubscribeUrl,
}: ReengageWebinarEmailProps) {
  return (
    <Layout
      preview={`${name}, join us for a live onboarding session — get your first journey live.`}
      eyebrow="Live session"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>Get your first journey live — join us</Title>
      <Body>
        Hey {name} — we're running a live onboarding session and wanted to
        personally invite you. It's a great way to get unstuck and see the full
        picture in 30 minutes.
      </Body>

      <Callout tone="brand">
        <Body>
          <strong>{webinarTitle}</strong>
          {webinarDate ? ` — ${webinarDate}` : ""}
        </Body>
        <Body>{webinarDescription}</Body>
      </Callout>

      <Body>
        You'll leave with a working journey, live events flowing, and a clear
        plan for your next steps.
      </Body>
      <Divider />
      <Button href={registerUrl}>{ctaText}</Button>
      <Body>
        Can't make it? Reply and we'll send you the recording afterward.
      </Body>
    </Layout>
  );
}
