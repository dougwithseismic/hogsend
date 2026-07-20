// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Link, Section, Text } from "react-email";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Button, Divider, Title } from "./_components/ui.js";
import type { ContentWeeklyArticlesEmailProps } from "./types.js";

export default function ContentWeeklyArticlesEmail({
  name = "there",
  periodLabel = "this week",
  articles = [
    {
      title: "Prove the journey moved the metric",
      url: `${BRAND.siteUrl}/articles/prove-the-journey-worked`,
      minutes: 6,
    },
    {
      title: "Hold five percent out of everything",
      url: `${BRAND.siteUrl}/articles/program-level-holdout`,
      minutes: 4,
    },
    {
      title: "Close the loop on direct mail with QR codes",
      url: `${BRAND.siteUrl}/articles/direct-mail-qr-codes`,
      minutes: 5,
    },
  ],
  browseUrl = `${BRAND.siteUrl}/articles`,
  unsubscribeUrl,
}: ContentWeeklyArticlesEmailProps) {
  return (
    <Layout
      preview={`${articles.length} reads worth your time ${periodLabel}`}
      eyebrow="Worth reading"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>What we published {periodLabel}</Title>
      <Body>
        Hey {name} — the short list. Each one is a pattern you can lift straight
        into your own lifecycle code.
      </Body>

      {articles.map((article) => (
        <Section key={article.url} className="mb-4">
          <Link
            href={article.url}
            className="text-[15px] font-semibold text-zinc-900 underline"
          >
            {article.title}
          </Link>
          {article.minutes && (
            <Text className="m-0 mt-0.5 text-xs text-zinc-500">
              {article.minutes} min read
            </Text>
          )}
        </Section>
      ))}

      <Divider />
      <Button href={browseUrl} variant="secondary">
        Browse all articles
      </Button>
    </Layout>
  );
}
