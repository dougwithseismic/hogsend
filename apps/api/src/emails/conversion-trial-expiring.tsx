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
import type { ConversionTrialExpiringEmailProps } from "./types.js";

export default function ConversionTrialExpiringEmail({
  name = "there",
  daysLeft = 3,
  trialEndDate = "soon",
  valueSummary = [
    "4 journeys live in production",
    "1,300 emails delivered",
    "38% average open rate",
  ],
  upgradeUrl = `${BRAND.siteUrl}/pricing`,
  unsubscribeUrl,
}: ConversionTrialExpiringEmailProps) {
  return (
    <Layout
      preview={`Your Hogsend Cloud trial ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`}
      eyebrow="Trial ending"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>
        Your trial ends {daysLeft === 1 ? "tomorrow" : `in ${daysLeft} days`}
      </Title>
      <Body>
        Hey {name} — your Hogsend Cloud trial wraps up on {trialEndDate}. Before
        it does, here's what your journeys have shipped:
      </Body>

      <Callout tone="success">
        <Text className="m-0 text-xs font-semibold uppercase tracking-wide text-emerald-600">
          Your trial so far
        </Text>
        <Bullets items={valueSummary} marker="✓" />
      </Callout>

      <Divider />
      <Body>
        Keep it all running — your journeys, dashboard, and managed worker stay
        exactly as they are. No re-deploy, no migration.
      </Body>
      <Button href={upgradeUrl}>Keep my journeys live</Button>
    </Layout>
  );
}
