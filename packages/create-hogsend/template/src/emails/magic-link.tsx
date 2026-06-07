// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Layout } from "./_components/layout.js";
import { Body, Button, Callout, Title } from "./_components/ui.js";
import type { MagicLinkEmailProps } from "./types.js";

// Transactional starter — CONTENT, yours to edit. Rendered for the
// `transactional/magic-link` key (see `./registry.ts`). Sent one-off from your
// auth handler via `hs.emails.send({ template: "transactional/magic-link", ... })`.
// Transactional sends skip list/category suppression — they always deliver.
export default function MagicLinkEmail({
  loginUrl = "https://app.example.com/auth/magic?token=...",
  expiresInMinutes = 15,
  name = "there",
}: MagicLinkEmailProps) {
  return (
    <Layout preview="Your sign-in link" eyebrow="Sign in">
      <Title>Sign in to {"{{APP_NAME}}"}</Title>
      <Body>
        Hey {name}, click the button below to sign in. This link expires in{" "}
        {expiresInMinutes} minutes and can only be used once.
      </Body>
      <Button href={loginUrl}>Sign in</Button>
      <Callout tone="default">
        <Body>
          Didn't request this? You can safely ignore this email — no one can
          sign in without the link.
        </Body>
      </Callout>
    </Layout>
  );
}
