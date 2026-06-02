// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Text } from "react-email";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Bullets, Button, Callout, Title } from "./_components/ui.js";
import type { ActivationCommunityEmailProps } from "./types.js";

export default function ActivationCommunityEmail({
  name = "there",
  communityUrl = BRAND.communityUrl,
  communityName = BRAND.communityName,
  memberCount = "1,200+",
  highlights = [
    "A welcome series that drops a setup nudge only if no events arrive",
    "Trial-expiry sequences gated on real PostHog usage milestones",
    "Win-back offers that exit the moment someone comes back",
  ],
  unsubscribeUrl,
}: ActivationCommunityEmailProps) {
  return (
    <Layout
      preview={`See what ${memberCount} teams are shipping with Hogsend`}
      eyebrow="What others are doing"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>You don't have to start from a blank file</Title>
      <Body>
        Hey {name} — {memberCount} teams are already running lifecycle email on
        Hogsend, and most of them happily steal each other's journeys. A few
        patterns that show up again and again:
      </Body>

      <Callout tone="brand">
        <Text className="m-0 text-xs font-semibold uppercase tracking-wide text-orange-600">
          Popular journeys in the wild
        </Text>
        <Bullets items={highlights} />
      </Callout>

      <Body>
        They share the code, the gotchas, and the open rates in {communityName}.
        It's the fastest way to copy something that already works.
      </Body>
      <Button href={communityUrl}>Join {communityName}</Button>
    </Layout>
  );
}
