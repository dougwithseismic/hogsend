// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Bullets, Button, Title } from "./_components/ui.js";
import type { WinbackWhatsNewEmailProps } from "./types.js";

export default function WinbackWhatsNewEmail({
  name = "there",
  monthsAway = 3,
  updates = [
    "First-party link + QR tracking — no more provider pixel guesswork",
    "Account-level groups, so team activity rolls up in one place",
    "Journey lift reports with a real holdout, not vibes",
  ],
  returnUrl = `${BRAND.appUrl}`,
  unsubscribeUrl,
}: WinbackWhatsNewEmailProps) {
  return (
    <Layout
      preview="What changed while you were away — the short version"
      eyebrow="Been a while"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>The product you left isn't the one that's here now</Title>
      <Body>
        Hey {name} — it's been about {monthsAway} months. Not a guilt trip;
        things genuinely changed, and some of it is the stuff you were missing
        when you drifted off:
      </Body>
      <Bullets items={updates} />
      <Body>
        Your workspace is still there, exactly as you left it. Log back in and
        it all still runs.
      </Body>
      <Button href={returnUrl}>See what's new</Button>
    </Layout>
  );
}
