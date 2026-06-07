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
import type { LifecycleWinBackProps } from "./types.js";

export default function LifecycleWinBack({
  name = "there",
  daysSinceActive = 30,
  whatsNew = [
    "Audience buckets — real-time segments as code",
    "Link-click and open tracking on every send",
    "A public data-plane API and the @hogsend/client SDK",
  ],
  returnUrl = BRAND.appUrl,
  incentive,
  unsubscribeUrl,
}: LifecycleWinBackProps) {
  return (
    <Layout
      preview={`It's been a while, ${name} — here's what's new in ${BRAND.name}.`}
      eyebrow="We miss you"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>It's been a while</Title>
      <Body>
        Hey {name} — it's been about {daysSinceActive} days since you last
        worked on your {BRAND.name} project. We've shipped a lot since then.
      </Body>
      <Bullets items={whatsNew} />

      {incentive ? (
        <Callout tone="brand">
          <Text className="m-0 text-sm leading-6 text-orange-900">
            {incentive}
          </Text>
        </Callout>
      ) : null}

      <Divider />
      <Button href={returnUrl}>Pick up where you left off</Button>
      <Body>
        Your journeys, templates and history are exactly where you left them.
        Jump back in any time — or reply and tell us what would make it worth
        your while.
      </Body>
    </Layout>
  );
}
