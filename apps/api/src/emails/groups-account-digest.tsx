// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Section } from "react-email";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Button, Divider, Stat, Title } from "./_components/ui.js";
import type { GroupsAccountDigestEmailProps } from "./types.js";

// Account-level digest for the workspace owner — group analytics, not
// person analytics. One email per account, not per seat.
export default function GroupsAccountDigestEmail({
  name = "there",
  groupName = "Acme",
  periodLabel = "This week",
  stats = [
    { label: "Emails delivered", value: "2,140", change: "+12% vs last week" },
    { label: "Journeys active", value: "6" },
    { label: "Seats active", value: "4 of 6" },
  ],
  quietSeats = 2,
  dashboardUrl = `${BRAND.appUrl}/studio/groups`,
  unsubscribeUrl,
}: GroupsAccountDigestEmailProps) {
  return (
    <Layout
      preview={`${groupName}: ${periodLabel.toLowerCase()} across the whole account`}
      eyebrow={periodLabel}
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>How {groupName} used Hogsend</Title>
      <Body>
        Hey {name} — the account-level view, not just your own activity.
        Everything below rolls up across every seat on {groupName}.
      </Body>

      <Section className="my-5">
        {stats.map((stat) => (
          <Stat
            key={stat.label}
            label={stat.label}
            value={stat.value}
            change={stat.change}
          />
        ))}
      </Section>

      {quietSeats > 0 && (
        <Body>
          {quietSeats} seat{quietSeats === 1 ? " hasn't" : "s haven't"} logged
          in this period — usually worth a nudge before renewal, not after.
        </Body>
      )}

      <Divider />
      <Button href={dashboardUrl}>View your team's usage</Button>
    </Layout>
  );
}
