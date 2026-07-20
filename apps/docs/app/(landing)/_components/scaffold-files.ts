import type { EmailPreview } from "./minted-files";

/* ==========================================================================
 *  The scaffolded app the homepage explorer walks through — what
 *  `pnpm dlx create-hogsend@latest my-app` actually hands you, trimmed to the
 *  files that tell the story: journeys are TypeScript, emails are React,
 *  webhook sources feed the same pipeline, the worker runs it all.
 *
 *  Journey/webhook sources use the real engine API (same rules as the
 *  homepage code blocks). Email files carry BOTH their source and a rendered
 *  `EmailPreview` — the explorer shows the code and floats the rendered
 *  message in a corner window, because a template file answers two questions
 *  at once: "what's the code" and "what lands in the inbox".
 * ========================================================================== */

export type ScaffoldFile = {
  path: string;
  lang: "ts" | "tsx" | "ini";
  source: string;
  /** When present, the explorer floats the rendered email beside the code. */
  email?: EmailPreview;
};

export const SCAFFOLD_FILES: ScaffoldFile[] = [
  {
    path: "src/journeys/onboarding.ts",
    lang: "ts",
    source: `import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";

export const onboarding = defineJourney({
  meta: {
    id: "onboarding",
    trigger: { event: "user.signed_up" },
    entryLimit: "once",
  },
  run: async (user, ctx) => {
    await sendEmail({ to: user.email, template: "welcome" });

    // Park durably until THIS user creates a project — or 3 days pass.
    const { timedOut } = await ctx.waitForEvent({
      event: "project.created",
      timeout: days(3),
    });

    await sendEmail({
      to: user.email,
      template: timedOut ? "activation-nudge" : "first-win",
    });
  },
});`,
  },
  {
    path: "src/journeys/winback.ts",
    lang: "ts",
    source: `import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";

export const winback = defineJourney({
  meta: {
    id: "winback",
    trigger: { event: "bucket.went_dormant" },
    exitOn: [{ event: "contact.active" }],
  },
  run: async (user, ctx) => {
    await sendEmail({ to: user.email, template: "winback-check-in" });

    await ctx.sleep({ duration: days(7), label: "cool-off" });

    await sendEmail({ to: user.email, template: "winback-offer" });
  },
});`,
  },
  {
    path: "src/journeys/payment-failed.ts",
    lang: "ts",
    source: `import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";

export const paymentFailed = defineJourney({
  meta: {
    id: "payment-failed",
    trigger: { event: "invoice.payment_failed" },
    exitOn: [{ event: "invoice.paid" }],
  },
  run: async (user, ctx) => {
    await sendEmail({ to: user.email, template: "card-trouble" });

    // Three quiet days before the second ask — exitOn cancels
    // the journey the moment the invoice clears.
    await ctx.sleep({ duration: days(3), label: "grace" });

    await sendEmail({ to: user.email, template: "final-notice" });
  },
});`,
  },
  {
    path: "src/emails/welcome.tsx",
    lang: "tsx",
    source: `import { Button, Heading, Text } from "@react-email/components";
import { EmailLayout } from "./_layout";

export function WelcomeEmail({ name }: { name?: string }) {
  return (
    <EmailLayout preview="Your workspace is ready.">
      <Heading>Welcome{name ? \`, \${name}\` : ""} 👋</Heading>
      <Text>
        Your workspace is ready. Connect your repo and your
        first journey ships with your next deploy.
      </Text>
      <Button href={appUrl("/start")}>Open your workspace</Button>
    </EmailLayout>
  );
}`,
    email: {
      subject: "Welcome to my-app",
      preheader: "Your workspace is ready.",
      heading: "Welcome 👋",
      body: [
        "Your workspace is ready. Connect your repo and your first journey ships with your next deploy.",
      ],
      cta: { label: "Open your workspace" },
      footer: "Sent by the onboarding journey — src/journeys/onboarding.ts.",
    },
  },
  {
    path: "src/emails/winback-offer.tsx",
    lang: "tsx",
    source: `import { Button, Heading, Text } from "@react-email/components";
import { EmailLayout } from "./_layout";

export function WinbackOffer() {
  return (
    <EmailLayout preview="20% off your next three months.">
      <Heading>We kept your workspace warm</Heading>
      <Text>
        Everything is where you left it — journeys, templates,
        contacts. If budget was the sticking point, here's 20%
        off your next three months.
      </Text>
      <Button href={appUrl("/reactivate")}>
        Reactivate my workspace
      </Button>
    </EmailLayout>
  );
}`,
    email: {
      subject: "Still thinking it over?",
      preheader: "20% off your next three months — expires Friday.",
      heading: "We kept your workspace warm",
      body: [
        "Everything is where you left it — journeys, templates, contacts.",
        "If budget was the sticking point, here's 20% off your next three months.",
      ],
      cta: { label: "Reactivate my workspace", note: "Offer expires Friday" },
      footer: "Sent by the winback journey — src/journeys/winback.ts.",
    },
  },
  {
    path: "src/webhook-sources/billing.ts",
    lang: "ts",
    source: `import { defineWebhookSource } from "@hogsend/engine";
import { z } from "zod";

export const billing = defineWebhookSource({
  meta: { id: "billing", name: "Billing" },
  auth: {
    type: "match",
    header: "x-webhook-secret",
    envKey: "BILLING_WEBHOOK_SECRET",
  },
  schema: z.object({
    type: z.string(),
    customer: z.object({ id: z.string(), email: z.string() }),
  }),
  async transform(payload) {
    // Whatever lands here can trigger a journey —
    // invoice.payment_failed starts payment-failed.ts.
    return {
      userId: payload.customer.id,
      email: payload.customer.email,
      event: payload.type,
    };
  },
});`,
  },
  {
    path: "src/worker.ts",
    lang: "ts",
    source: `import { createWorker } from "@hogsend/engine";
import { client } from "./client";
import { journeys } from "./journeys";

// One long-running process executes every journey durably —
// sleeps survive deploys, waits survive restarts.
const worker = await createWorker({ container: client, journeys });

await worker.start();`,
  },
  {
    path: ".env",
    lang: "ini",
    source: `DATABASE_URL=postgres://localhost:5432/my-app

# Provider is config, not journey code — swap without a rewrite.
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_...

# Optional: PostHog turns on identity + person properties.
POSTHOG_API_KEY=phc_...`,
  },
];
