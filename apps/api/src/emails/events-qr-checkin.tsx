// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Img, Section, Text } from "react-email";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Button, Title } from "./_components/ui.js";
import type { EventsQrCheckinEmailProps } from "./types.js";

// The QR is a tracked link minted via the links API — every scan lands as a
// click event on the contact, so attendance shows up in the journey without
// anyone tapping a survey.
export default function EventsQrCheckinEmail({
  name = "there",
  eventTitle = "Hogsend meetup — London",
  eventDate = "Thursday, 24 July · 6:30 pm",
  venue = "The Trampery, Old Street",
  qrImageUrl = "https://quickchart.io/qr?text=https%3A%2F%2Fhogsend.com%2Fl%2Fcheckin&size=180",
  ticketUrl = `${BRAND.siteUrl}/l/ticket`,
  unsubscribeUrl,
}: EventsQrCheckinEmailProps) {
  return (
    <Layout
      preview={`Your check-in code for ${eventTitle}`}
      eyebrow="You're in"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>Your ticket for {eventTitle}</Title>
      <Body>
        Hey {name} — you're on the list. {eventDate}
        {venue ? `, at ${venue}` : ""}. Show this code at the door; scanning it
        checks you in.
      </Body>

      <Section className="my-6 rounded-xl border border-solid border-zinc-200 bg-zinc-50 px-5 py-6 text-center">
        <Img
          src={qrImageUrl}
          alt="Your check-in QR code"
          width="180"
          height="180"
          className="mx-auto rounded-lg bg-white p-2"
        />
        <Text className="m-0 mt-3 text-xs text-zinc-500">
          One scan, you're in — no app, no printout needed.
        </Text>
      </Section>

      <Button href={ticketUrl} variant="secondary">
        View ticket details
      </Button>
    </Layout>
  );
}
