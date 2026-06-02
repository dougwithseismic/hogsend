// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import { Body, Bullets, Button, Divider, Title } from "./_components/ui.js";
import type { WelcomeEmailProps } from "./types.js";

export default function WelcomeEmail({
  name = "there",
  dashboardUrl = BRAND.appUrl,
  docsUrl = BRAND.quickstartUrl,
  unsubscribeUrl,
}: WelcomeEmailProps) {
  return (
    <Layout
      preview="Welcome to Hogsend — turn PostHog events into the right email at the right time."
      eyebrow="Welcome aboard"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>Lifecycle email, as code.</Title>
      <Body>
        Hey {name} — welcome to Hogsend. You now have a place to turn your
        PostHog events into Resend emails, with journeys written in TypeScript
        and version-controlled like the rest of your app. No drag-and-drop
        builder, no marketing seat required.
      </Body>
      <Body>
        Over the next few days we'll help you ship your first journey:
      </Body>
      <Bullets
        items={[
          "Connect PostHog and Resend, then send a test email",
          "Define your first journey in code — a bare-bones welcome series",
          "Watch enrollments, sends, opens and clicks land in your dashboard",
        ]}
      />
      <Divider />
      <Button href={docsUrl}>Open the 5-minute quickstart</Button>
      <Body>
        Prefer to poke around first?{" "}
        <a
          href={dashboardUrl}
          className="font-semibold text-zinc-900 underline"
        >
          Head to your dashboard
        </a>
        . And yes — this email was sent by Hogsend, through a journey defined in
        code. That's the whole idea.
      </Body>
    </Layout>
  );
}
