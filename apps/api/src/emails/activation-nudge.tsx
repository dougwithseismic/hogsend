// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Text } from "react-email";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import {
  Body,
  Bullets,
  Button,
  Callout,
  Divider,
  Title,
} from "./_components/ui.js";
import type { ActivationNudgeEmailProps } from "./types.js";

export default function ActivationNudgeEmail({
  name = "there",
  daysSinceSignup = 3,
  setupUrl = BRAND.quickstartUrl,
  docsUrl = BRAND.docsUrl,
  helpUrl,
  unsubscribeUrl,
}: ActivationNudgeEmailProps) {
  return (
    <Layout
      preview="We haven't seen any events from your project yet — everything okay?"
      eyebrow="Checking in"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>We haven't seen any events yet</Title>
      <Body>
        Hey {name} — it's been {daysSinceSignup} days and Hogsend hasn't
        received a single event from your project. Nothing's wrong with the
        account; it just means nothing has been wired up to send us data yet.
      </Body>
      <Body>That's usually one of these:</Body>
      <Bullets
        items={[
          "The app is installed but no journey is enrolling users yet",
          "Events are firing in PostHog but not being forwarded to /v1/ingest",
          "You're testing locally and the worker isn't running",
        ]}
      />

      <Callout tone="warn">
        <Text className="m-0 text-sm leading-6 text-amber-900">
          The fastest sanity check: send one test event and watch your dashboard
          light up. If it shows, you're connected.
        </Text>
      </Callout>

      <Divider />
      <Button href={setupUrl}>Send a test event</Button>
      <Body>
        Stuck on a step? The{" "}
        <a href={docsUrl} className="font-semibold text-zinc-900 underline">
          setup docs
        </a>{" "}
        walk through it,{" "}
        {helpUrl ? (
          <>
            or grab the{" "}
            <a href={helpUrl} className="font-semibold text-zinc-900 underline">
              troubleshooting guide
            </a>
            .{" "}
          </>
        ) : null}
        Or just reply to this email — a real person reads every one.
      </Body>
    </Layout>
  );
}
