// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Text } from "react-email";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Button, Callout, Divider, Title } from "./_components/ui.js";
import type { ChurnPaymentFailedEmailProps } from "./types.js";

export default function ChurnPaymentFailedEmail({
  name = "there",
  retryUrl = `${BRAND.appUrl}/billing/retry`,
  updatePaymentUrl = `${BRAND.appUrl}/billing/payment-method`,
  gracePeriodDays = 3,
  unsubscribeUrl,
}: ChurnPaymentFailedEmailProps) {
  return (
    <Layout
      preview="Your recent Hogsend Cloud payment didn't go through"
      eyebrow="Billing"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>We couldn't process your payment</Title>
      <Body>
        Hey {name} — the latest charge for Hogsend Cloud didn't go through. This
        is almost always something small: an expired card, a bank flag, a new
        billing address.
      </Body>

      <Callout tone="danger">
        <Text className="m-0 text-sm leading-6 text-red-800">
          To avoid interruption, please update your payment within{" "}
          {gracePeriodDays} day{gracePeriodDays === 1 ? "" : "s"}. After that
          your journeys pause until billing is sorted.
        </Text>
      </Callout>

      <Button href={retryUrl}>Retry payment</Button>

      <Divider />
      <Body>
        Need to use a different card?{" "}
        <a
          href={updatePaymentUrl}
          className="font-semibold text-zinc-900 underline"
        >
          Update your payment method
        </a>
        . Think this is a mistake? Just reply and we'll sort it out with you.
      </Body>
    </Layout>
  );
}
