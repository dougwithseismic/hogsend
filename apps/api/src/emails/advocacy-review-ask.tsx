import { EmailAction } from "@hogsend/email";
// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Events } from "../journeys/constants/index.js";
import { Layout } from "./_components/layout.js";
import { Body, Title } from "./_components/ui.js";
import type { AdvocacyReviewAskEmailProps } from "./types.js";

// Post-win review ask. The CTA is a semantic link: the click itself lands as
// a `review.clicked` event with the platform, so the journey knows who
// followed through without a webhook from the review site.
export default function AdvocacyReviewAskEmail({
  name = "there",
  winDescription = "your first journey crossed 1,000 delivered emails",
  platformName = "G2",
  reviewUrl = "https://www.g2.com/products/hogsend/reviews",
  unsubscribeUrl,
}: AdvocacyReviewAskEmailProps) {
  return (
    <Layout
      preview="One favor, at a good moment"
      eyebrow="A small ask"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>While it's going well — a favor</Title>
      <Body>
        Hey {name} — {winDescription}. That's the moment we've learned to ask
        in, because asking right after a support ticket would be ridiculous.
      </Body>
      <Body>
        Would you leave a short review on {platformName}? Two honest sentences
        beat five stars and no words. It's the main way small tools get found.
      </Body>
      <EmailAction
        event={Events.REVIEW_CLICKED}
        properties={{ platform: platformName }}
        href={reviewUrl}
        className="box-border inline-block rounded-lg bg-zinc-900 px-5 py-3 text-sm font-semibold text-white no-underline"
      >
        Leave a review on {platformName}
      </EmailAction>
      <Body>
        And if now's not the time, ignoring this is completely fine — we won't
        re-ask for months.
      </Body>
    </Layout>
  );
}
