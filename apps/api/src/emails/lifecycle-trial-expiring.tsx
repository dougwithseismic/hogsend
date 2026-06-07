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
import type { LifecycleTrialExpiringProps } from "./types.js";

export default function LifecycleTrialExpiring({
  name = "there",
  daysLeft = 3,
  upgradeUrl = `${BRAND.appUrl}/billing/upgrade`,
  valueSummary = [
    "Your journeys are live and enrolling real users",
    "Sends, opens and clicks are flowing into your dashboard",
    "Everything stays in code — nothing to migrate later",
  ],
  unsubscribeUrl,
}: LifecycleTrialExpiringProps) {
  return (
    <Layout
      preview={`Your ${BRAND.name} Cloud trial ends in ${daysLeft} days.`}
      eyebrow="Trial ending"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>Your trial ends in {daysLeft} days</Title>
      <Body>
        Hey {name} — your {BRAND.name} Cloud trial wraps up in {daysLeft} days.
        Add a plan to keep your journeys running without interruption.
      </Body>
      <Body>Here's what's already working for you:</Body>
      <Bullets items={valueSummary} />

      <Callout tone="warn">
        <Text className="m-0 text-sm leading-6 text-amber-900">
          When the trial ends, sends pause until a plan is active. Your code,
          journeys and history stay exactly where they are.
        </Text>
      </Callout>

      <Divider />
      <Button href={upgradeUrl}>Choose a plan</Button>
      <Body>
        Not ready, or have questions about pricing? Reply to this email and
        we'll walk you through the options.
      </Body>
    </Layout>
  );
}
