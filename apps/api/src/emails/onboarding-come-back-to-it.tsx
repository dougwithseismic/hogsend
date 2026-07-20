// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Text } from "react-email";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Button, Callout, Title } from "./_components/ui.js";
import type { OnboardingComeBackToItEmailProps } from "./types.js";

// Second-session rescue: signed up, started, never came back. Names the exact
// spot they stopped so resuming feels small.
export default function OnboardingComeBackToItEmail({
  name = "there",
  lastStepLabel = "connecting your first event source",
  resumeUrl = `${BRAND.appUrl}/setup`,
  unsubscribeUrl,
}: OnboardingComeBackToItEmailProps) {
  return (
    <Layout
      preview="Your setup is saved exactly where you left it"
      eyebrow="Pick it back up"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>You stopped at the right-before-it-works part</Title>
      <Body>
        Hey {name} — you got partway through setup and life presumably happened.
        Nothing's lost: everything you did is saved.
      </Body>
      <Callout>
        <Text className="m-0 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Where you left off
        </Text>
        <Text className="m-0 mt-1 text-[15px] font-semibold text-zinc-900">
          {lastStepLabel}
        </Text>
      </Callout>
      <Body>
        That step usually takes a couple of minutes, and it's the one where the
        product starts doing something visible.
      </Body>
      <Button href={resumeUrl}>Resume where I left off</Button>
    </Layout>
  );
}
