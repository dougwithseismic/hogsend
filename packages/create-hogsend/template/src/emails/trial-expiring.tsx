// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Text } from "react-email";
import { Layout } from "./_components/layout.js";
import {
  Body,
  Bullets,
  Button,
  Callout,
  Divider,
  Title,
} from "./_components/ui.js";
import type { TrialExpiringEmailProps } from "./types.js";

// Lifecycle starter — CONTENT, yours to edit. Rendered for the
// `lifecycle/trial-expiring` key (see `./registry.ts`). Sent from the bundled
// `trial-expiring` journey (see `src/journeys/trial-expiring.ts`), not one-off.
export default function TrialExpiringEmail({
  name = "there",
  daysLeft = 3,
  trialEndDate = "soon",
  valueSummary = [
    "3 journeys live",
    "1,200 emails delivered",
    "41% average open rate",
  ],
  upgradeUrl = "https://app.example.com/billing",
  unsubscribeUrl,
}: TrialExpiringEmailProps) {
  return (
    <Layout
      preview={`Your trial ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`}
      eyebrow="Trial ending"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>
        Your trial ends {daysLeft === 1 ? "tomorrow" : `in ${daysLeft} days`}
      </Title>
      <Body>
        Hey {name} — your trial wraps up on {trialEndDate}. Before it does,
        here's what you've shipped so far:
      </Body>

      <Callout tone="success">
        <Text className="m-0 text-xs font-semibold uppercase tracking-wide text-emerald-600">
          Your trial so far
        </Text>
        <Bullets items={valueSummary} marker="✓" />
      </Callout>

      <Divider />
      <Body>
        Upgrade now to keep everything running — no re-setup, no interruption.
      </Body>
      <Button href={upgradeUrl}>Upgrade and keep going</Button>
    </Layout>
  );
}
