// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Text } from "react-email";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Button, Callout, Title } from "./_components/ui.js";
import type { BillingUpcomingPaymentEmailProps } from "./types.js";

export default function BillingUpcomingPaymentEmail({
  name = "there",
  planName = "Team plan",
  amount = "$49.00",
  renewalDate = "August 1",
  cardLast4 = "4242",
  manageBillingUrl = `${BRAND.appUrl}/billing`,
  unsubscribeUrl,
}: BillingUpcomingPaymentEmailProps) {
  return (
    <Layout
      preview={`${amount} on ${renewalDate} — no action needed`}
      eyebrow="Upcoming payment"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>
        Your {planName} renews on {renewalDate}
      </Title>
      <Body>
        Hey {name} — a heads-up before we charge anything: your subscription
        renews on {renewalDate}. No action needed if everything below looks
        right.
      </Body>

      <Callout>
        <Text className="m-0 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          What you'll be charged
        </Text>
        <Text className="m-0 mt-1 text-[22px] font-bold leading-tight text-zinc-900">
          {amount}
        </Text>
        <Text className="m-0 mt-1 text-sm text-zinc-600">
          {planName} · card ending {cardLast4}
        </Text>
      </Callout>

      <Body>
        Card expired, or the plan no longer fits? Sort it now and the renewal
        just works — no failed-payment emails, no service interruption.
      </Body>
      <Button href={manageBillingUrl}>Review plan &amp; payment method</Button>
    </Layout>
  );
}
