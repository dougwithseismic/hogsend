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
import type { ConversionUsageMilestoneEmailProps } from "./types.js";

export default function ConversionUsageMilestoneEmail({
  name = "there",
  usageCount = 100,
  usageLabel = "emails",
  usageLimit,
  proFeatures = [
    "Unlimited sends and journeys",
    "Hosted dashboard with delivery, open & click analytics",
    "Managed worker — no infra to babysit",
    "Priority support from the team",
  ],
  upgradeUrl = `${BRAND.siteUrl}/pricing`,
  unsubscribeUrl,
}: ConversionUsageMilestoneEmailProps) {
  return (
    <Layout
      preview={`You've sent ${usageCount} ${usageLabel} through Hogsend`}
      eyebrow="Milestone"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>
        That's {usageCount} {usageLabel} sent 🎉
      </Title>
      <Body>
        Hey {name} — your journeys have now delivered {usageCount} {usageLabel}
        {usageLimit ? ` of your ${usageLimit} on the free plan` : ""}. Hogsend
        is clearly doing real work for you.
      </Body>

      {usageLimit && (
        <Callout tone="warn">
          <Text className="m-0 text-sm leading-6 text-amber-900">
            You've used {usageCount} of {usageLimit} free {usageLabel}. Upgrade
            to keep your journeys running without hitting the cap.
          </Text>
        </Callout>
      )}

      <Divider />
      <Body>What Hogsend Cloud adds on top of the open-source engine:</Body>
      <Bullets items={proFeatures} />
      <Button href={upgradeUrl}>See Hogsend Cloud</Button>
    </Layout>
  );
}
