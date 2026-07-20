// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Text } from "react-email";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Button, Callout, Title } from "./_components/ui.js";
import type { SalesProposalOpenedEmailProps } from "./types.js";

// Internal alert — sent to the REP, not the prospect. Fired by the
// proposal-opened playbook play when link tracking sees the proposal URL
// clicked.
export default function SalesProposalOpenedEmail({
  name = "there",
  prospectName = "Acme",
  proposalTitle = "Q3 rollout proposal",
  openCount = 3,
  openedAt = "2 minutes ago",
  dealUrl = `${BRAND.appUrl}/studio/links`,
}: SalesProposalOpenedEmailProps) {
  return (
    <Layout
      preview={`${prospectName} opened "${proposalTitle}" ${openedAt}`}
      eyebrow="Buying signal"
    >
      <Title>{prospectName} just opened your proposal</Title>
      <Body>
        Hey {name} — the tracked link on "{proposalTitle}" fired {openedAt}.
        You're reading this while they're reading that.
      </Body>

      <Callout tone="brand">
        <Text className="m-0 text-sm font-semibold text-zinc-900">
          {openCount === 1
            ? "First open."
            : `Opened ${openCount} times so far.`}
        </Text>
        <Text className="m-0 mt-1 text-sm text-zinc-600">
          Repeat opens usually mean it's being shared around the room — a good
          moment for a short, specific follow-up.
        </Text>
      </Callout>

      <Button href={dealUrl}>See the click trail</Button>
    </Layout>
  );
}
