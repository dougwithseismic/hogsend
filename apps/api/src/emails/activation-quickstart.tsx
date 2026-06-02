// biome-ignore lint/correctness/noUnusedImports: required for JSX runtime
import React from "react";
import { BRAND } from "./_components/brand.js";
import { Layout } from "./_components/layout.js";
import {
  Body,
  Button,
  CodeBlock,
  Divider,
  Step,
  Title,
} from "./_components/ui.js";
import type { ActivationQuickstartEmailProps } from "./types.js";

export default function ActivationQuickstartEmail({
  name = "there",
  quickstartUrl = BRAND.quickstartUrl,
  docsUrl = BRAND.docsUrl,
  unsubscribeUrl,
}: ActivationQuickstartEmailProps) {
  return (
    <Layout
      preview="Your Hogsend setup guide — first journey live in about five minutes."
      eyebrow="Setup guide"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>Let's get your first journey live</Title>
      <Body>
        Hey {name} — here's the fastest path from empty project to a working
        lifecycle email. Three steps, all in code.
      </Body>

      <Step index={1} title="Scaffold a Hogsend app">
        <CodeBlock
          code={
            "# spin up a new project\npnpm dlx create-hogsend@latest my-app\ncd my-app && pnpm install"
          }
        />
      </Step>

      <Step index={2} title="Define a journey">
        <CodeBlock
          code={
            'import { defineJourney, days } from "@hogsend/engine";\n\nexport const welcome = defineJourney({\n  meta: { trigger: { event: "user.created" } },\n  async run(user, ctx) {\n    await sendEmail({ to: user.email, template: "welcome" });\n    await ctx.sleep({ duration: days(2) });\n    // ...nudge, highlight, community\n  },\n});'
          }
        />
      </Step>

      <Step index={3} title="Send PostHog an event and watch it fire">
        <CodeBlock
          code={
            '# enroll a user from anywhere\ncurl -X POST $API_URL/v1/ingest \\\n  -d \'{ "event": "user.created", "userId": "u_1" }\''
          }
        />
      </Step>

      <Divider />
      <Button href={quickstartUrl}>Open the full quickstart</Button>
      <Body>
        Want the deep dive on triggers, sleeps and exit conditions? The{" "}
        <a href={docsUrl} className="font-semibold text-zinc-900 underline">
          docs
        </a>{" "}
        cover all of it — or just reply here and we'll help you wire it up.
      </Body>
    </Layout>
  );
}
