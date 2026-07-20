// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Button, Divider, Title } from "./_components/ui.js";
import type { SalesWhitepaperFollowUpEmailProps } from "./types.js";

export default function SalesWhitepaperFollowUpEmail({
  name = "there",
  whitepaperTitle = "Lifecycle email, in your repo",
  pricingUrl = `${BRAND.siteUrl}/pricing`,
  caseStudyUrl,
  unsubscribeUrl,
}: SalesWhitepaperFollowUpEmailProps) {
  return (
    <Layout
      preview="You read the whole thing — here's the practical next step"
      eyebrow="Following up"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>You finished "{whitepaperTitle}"</Title>
      <Body>
        Hey {name} — most people skim the first page. You read it through, so
        we'll skip the pitch and get to the part people usually ask about next:
        what it costs and how teams roll it out.
      </Body>
      <Body>
        Pricing is public — no "book a demo to see numbers." If it doesn't fit,
        you'll know in two minutes.
      </Body>
      <Button href={pricingUrl}>See pricing</Button>
      {caseStudyUrl && (
        <>
          <Divider />
          <Body>
            Prefer to see it running first? There's a written walkthrough of a
            production setup — real journeys, real numbers.
          </Body>
          <Button href={caseStudyUrl} variant="secondary">
            Read the case study
          </Button>
        </>
      )}
    </Layout>
  );
}
