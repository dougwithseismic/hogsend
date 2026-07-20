// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Column, Row, Section, Text } from "react-email";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Button, Divider, Title } from "./_components/ui.js";
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

      <Section className="my-5 rounded-xl border border-solid border-zinc-200 bg-zinc-50 px-5 py-4">
        <Row>
          {stats.map((stat) => (
            <Column key={stat.label} className="pr-4 align-top">
              <Text className="m-0 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                {stat.label}
              </Text>
              <Text className="m-0 text-[20px] font-bold leading-tight text-zinc-900">
                {stat.value}
              </Text>
              {stat.change && (
                <Text className="m-0 text-xs font-medium text-emerald-600">
                  {stat.change}
                </Text>
              )}
            </Column>
          ))}
        </Row>
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
