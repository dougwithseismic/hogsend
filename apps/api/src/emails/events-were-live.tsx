// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Button, Title } from "./_components/ui.js";
import type { EventsWereLiveEmailProps } from "./types.js";

// Deliberately short — this races the event itself. One line, one button.
export default function EventsWereLiveEmail({
  name = "there",
  eventTitle = "Hogsend Live: your first journey in production",
  joinUrl = `${BRAND.siteUrl}/live`,
  unsubscribeUrl,
}: EventsWereLiveEmailProps) {
  return (
    <Layout
      preview={`${eventTitle} just started`}
      eyebrow="Happening now"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>We're live</Title>
      <Body>
        {name} — "{eventTitle}" just started. You registered for this one; the
        room's open now.
      </Body>
      <Button href={joinUrl}>Join now</Button>
    </Layout>
  );
}
