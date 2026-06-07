// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Bullets, Button, Divider, Title } from "./_components/ui.js";
import type { LifecycleFeatureAnnouncementProps } from "./types.js";

export default function LifecycleFeatureAnnouncement({
  name = "there",
  featureName = "Audience buckets",
  featureDescription = "Define a real-time segment in code and trigger journeys the moment a user enters or leaves it.",
  benefits = [
    "Segments update live as events arrive — no nightly recompute",
    "Use bucket.entered / bucket.left as journey triggers and exits",
    "Member access (count / has / iterate) right from your code",
  ],
  ctaUrl = `${BRAND.docsUrl}/buckets`,
  ctaText = "Read the buckets guide",
  unsubscribeUrl,
}: LifecycleFeatureAnnouncementProps) {
  return (
    <Layout
      preview={`New in ${BRAND.name}: ${featureName}.`}
      eyebrow="New feature"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>{featureName} is here</Title>
      <Body>
        Hey {name} — we just shipped something we think you'll get a lot out of.
      </Body>
      <Body>{featureDescription}</Body>
      <Bullets items={benefits} />
      <Divider />
      <Button href={ctaUrl}>{ctaText}</Button>
      <Body>
        It's already available in your account — no upgrade needed. Give it a
        spin and let us know what you build.
      </Body>
    </Layout>
  );
}
