// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { Layout } from "./_components/layout.js";
import { Body, Button, Divider, Title } from "./_components/ui.js";
import type { WelcomeEmailProps } from "./types.js";

// Starter template — CONTENT, yours to edit. Rendered for the `activation/welcome`
// key (see `./registry.ts`). Delete or rewrite freely.
export default function WelcomeEmail({
  name = "there",
  dashboardUrl = "https://app.example.com",
  unsubscribeUrl,
}: WelcomeEmailProps) {
  return (
    <Layout
      preview={`Welcome to my-first-hogsend, ${name}!`}
      eyebrow="Welcome aboard"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>Welcome to {"my-first-hogsend"}</Title>
      <Body>
        Hey {name}, thanks for signing up. We're glad you're here — let's get
        you up and running.
      </Body>
      <Divider />
      <Button href={dashboardUrl}>Go to your dashboard</Button>
    </Layout>
  );
}
