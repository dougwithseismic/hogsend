// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Column, Row, Section, Text } from "react-email";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Button, Callout, Divider, Title } from "./_components/ui.js";
import type { ImpactJourneyLiftReportEmailProps } from "./types.js";

// Stakeholder-facing: the uplift study as an email. Numbers come from the
// holdout comparison (computeJourneyLift), not open rates.
export default function ImpactJourneyLiftReportEmail({
  name = "there",
  journeyName = "Trial upgrade",
  periodLabel = "last 30 days",
  liftPercent = "+18%",
  winProbability = "96%",
  holdoutPercent = "5%",
  enrolledConversion = "12.4%",
  holdoutConversion = "10.5%",
  reportUrl = `${BRAND.appUrl}/studio/impact`,
  unsubscribeUrl,
}: ImpactJourneyLiftReportEmailProps) {
  return (
    <Layout
      preview={`${journeyName}: ${liftPercent} lift vs holdout, ${periodLabel}`}
      eyebrow="Impact report"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>Did "{journeyName}" actually move the metric?</Title>
      <Body>
        Hey {name} — here's the {periodLabel} readout. A {holdoutPercent}{" "}
        holdout never got the journey, so the comparison below is causal, not
        correlation with opens.
      </Body>

      <Callout tone="success">
        <Row>
          <Column>
            <Text className="m-0 text-xs font-semibold uppercase tracking-wide text-emerald-700">
              Measured lift
            </Text>
            <Text className="m-0 text-[26px] font-bold leading-tight text-zinc-900">
              {liftPercent}
            </Text>
          </Column>
          <Column>
            <Text className="m-0 text-xs font-semibold uppercase tracking-wide text-emerald-700">
              Win probability
            </Text>
            <Text className="m-0 text-[26px] font-bold leading-tight text-zinc-900">
              {winProbability}
            </Text>
          </Column>
        </Row>
      </Callout>

      <Section className="mb-2">
        <Text className="m-0 text-sm text-zinc-600">
          Enrolled contacts converted at{" "}
          <span className="font-semibold text-zinc-900">
            {enrolledConversion}
          </span>{" "}
          vs{" "}
          <span className="font-semibold text-zinc-900">
            {holdoutConversion}
          </span>{" "}
          for the holdout.
        </Text>
      </Section>

      <Divider />
      <Body>
        The full study has the confidence interval, the sample sizes, and the
        per-week breakdown — worth a look before anyone quotes the headline
        number in a deck.
      </Body>
      <Button href={reportUrl}>Open the full study</Button>
    </Layout>
  );
}
