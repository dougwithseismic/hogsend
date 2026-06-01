// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Button, Heading, Hr, Section, Text } from "react-email";
import { Footer } from "./_components/footer.js";
import { Layout } from "./_components/layout.js";
import type { RetentionWeeklyDigestEmailProps } from "./types.js";

export default function RetentionWeeklyDigestEmail({
  name = "there",
  productName = "our platform",
  periodLabel = "This Week",
  stats = [
    { label: "Sessions", value: "12", change: "+3 vs last week" },
    { label: "Actions completed", value: "48", change: "+15%" },
    { label: "Best result", value: "N/A" },
  ],
  tip = "Try exploring the analytics dashboard to uncover trends in your data.",
  communityHighlight,
  dashboardUrl = "https://app.example.com/dashboard",
  unsubscribeUrl,
}: RetentionWeeklyDigestEmailProps) {
  return (
    <Layout preview={`${periodLabel} — your ${productName} snapshot`}>
      <Heading className="text-2xl font-bold text-gray-900">
        {periodLabel} Snapshot
      </Heading>
      <Text className="text-base text-gray-600">
        Hey {name}, here's what happened this week.
      </Text>

      <Section className="mt-4 rounded-md bg-gray-50 px-4 py-3">
        {stats.map((s) => (
          <Section key={s.label} className="my-2">
            <Text className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              {s.label}
            </Text>
            <Text className="text-lg font-bold text-gray-900">{s.value}</Text>
            {s.change && (
              <Text className="text-xs text-gray-500">{s.change}</Text>
            )}
          </Section>
        ))}
      </Section>

      {tip && (
        <>
          <Hr className="my-6 border-gray-200" />
          <Text className="text-sm font-semibold text-gray-800">
            Tip of the week
          </Text>
          <Text className="text-sm text-gray-600">{tip}</Text>
        </>
      )}

      {communityHighlight && (
        <>
          <Hr className="my-6 border-gray-200" />
          <Text className="text-sm font-semibold text-gray-800">
            Community spotlight
          </Text>
          <Text className="text-sm text-gray-600">{communityHighlight}</Text>
        </>
      )}

      <Button
        href={dashboardUrl}
        className="mt-4 rounded-md bg-indigo-600 px-6 py-3 text-sm font-semibold text-white"
      >
        View Dashboard
      </Button>
      <Footer unsubscribeUrl={unsubscribeUrl} />
    </Layout>
  );
}
