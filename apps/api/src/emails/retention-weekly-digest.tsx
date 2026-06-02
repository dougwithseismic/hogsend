// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Section, Text } from "react-email";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Button, Divider, Stat, Title } from "./_components/ui.js";
import type { RetentionWeeklyDigestEmailProps } from "./types.js";

export default function RetentionWeeklyDigestEmail({
  name = "there",
  periodLabel = "This week",
  stats = [
    { label: "Emails sent", value: "428", change: "+12% vs last week" },
    { label: "Open rate", value: "41%", change: "+3 pts" },
    { label: "Clicks", value: "96", change: "+18%" },
    { label: "Active journeys", value: "5" },
  ],
  tip = "Add an exit condition to your trial journey so users who upgrade stop getting nudges automatically — it's one line in the journey meta.",
  communityHighlight,
  dashboardUrl = BRAND.appUrl,
  unsubscribeUrl,
}: RetentionWeeklyDigestEmailProps) {
  return (
    <Layout
      preview={`${periodLabel} on Hogsend — your sends, opens and clicks`}
      eyebrow={periodLabel}
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>Your Hogsend week</Title>
      <Body>
        Hey {name} — here's how your lifecycle email performed over the last
        seven days.
      </Body>

      <Section className="my-5 rounded-2xl border border-solid border-zinc-200 bg-zinc-50 px-6 py-5">
        {stats.map((s) => (
          <Stat
            key={s.label}
            label={s.label}
            value={s.value}
            change={s.change}
          />
        ))}
      </Section>

      {tip && (
        <>
          <Divider />
          <Text className="m-0 mb-1 text-xs font-semibold uppercase tracking-wide text-orange-600">
            Tip of the week
          </Text>
          <Body>{tip}</Body>
        </>
      )}

      {communityHighlight && (
        <>
          <Divider />
          <Text className="m-0 mb-1 text-xs font-semibold uppercase tracking-wide text-orange-600">
            From the community
          </Text>
          <Body>{communityHighlight}</Body>
        </>
      )}

      <Button href={dashboardUrl}>Open your dashboard</Button>
    </Layout>
  );
}
