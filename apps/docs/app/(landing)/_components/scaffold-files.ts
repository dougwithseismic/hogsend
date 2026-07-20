import type { EmailPreview } from "./minted-files";

/* ==========================================================================
 *  The scaffolded app the homepage explorer walks through — what
 *  `pnpm dlx create-hogsend@latest my-app` hands you, grown to show the
 *  range: journeys grouped by the team that owns them (product, billing,
 *  marketing, people), React Email templates, the Stripe webhook preset, a
 *  QR-link mint script, and the Hatchet-powered worker.
 *
 *  Journey/webhook files use the real engine API (same rules as the homepage
 *  code blocks; playbook names — dunning, event summon, pre-boarding, silver
 *  medalist — match hogsend.com/playbook). Email files carry BOTH source and
 *  a rendered `EmailPreview`: the explorer shows the code and floats the
 *  rendered message in a corner window.
 * ========================================================================== */

export type ScaffoldFile = {
  path: string;
  lang: "ts" | "tsx" | "ini" | "bash";
  source: string;
  /** When present, the explorer floats the rendered email beside the code. */
  email?: EmailPreview;
};

export const SCAFFOLD_FILES: ScaffoldFile[] = [
  /* ---- journeys/product -------------------------------------------------- */
  {
    path: "src/journeys/product/onboarding.ts",
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
    path: "src/journeys/product/winback.ts",
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

  /* ---- journeys/billing --------------------------------------------------- */
  {
    path: "src/journeys/billing/dunning.ts",
    lang: "ts",
    source: `import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";

// Triggered by the Stripe webhook source —
// src/webhook-sources/stripe.ts feeds the same pipeline.
export const dunning = defineJourney({
  meta: {
    id: "dunning",
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

  /* ---- journeys/marketing ------------------------------------------------- */
  {
    path: "src/journeys/marketing/event-summon.ts",
    lang: "ts",
    source: `import { hours } from "@hogsend/core";
import {
  defineJourney,
  sendConnectorAction,
  sendEmail,
} from "@hogsend/engine";

// Live-event summon: email everyone, then DM the Discord
// members where they actually are.
export const eventSummon = defineJourney({
  meta: {
    id: "event-summon",
    trigger: { event: "event.doors_open" },
    entryLimit: "once_per_period",
  },
  run: async (user, ctx) => {
    await sendEmail({ to: user.email, template: "doors-open" });

    if (user.properties.discordMemberId) {
      await sendConnectorAction({
        connectorId: "discord",
        action: "dmMember",
        args: {
          member: user.properties.discordMemberId,
          content: "Doors are open — we're live in #main-stage.",
        },
      });
    }

    await ctx.sleep({ duration: hours(2), label: "doors" });
  },
});`,
  },

  /* ---- journeys/people ---------------------------------------------------- */
  {
    path: "src/journeys/people/pre-boarding.ts",
    lang: "ts",
    source: `import { defineJourney, sendEmail } from "@hogsend/engine";

// Lifecycle isn't only customers — the people team runs the
// offer-signed → day-one stretch through the same engine.
export const preBoarding = defineJourney({
  meta: {
    id: "pre-boarding",
    trigger: { event: "offer.signed" },
    entryLimit: "once",
  },
  run: async (user, ctx) => {
    await sendEmail({ to: user.email, template: "pre-boarding-day-one" });

    // Sleep durably until the day before their start date.
    const dayBefore = new Date(String(user.properties.startDate));
    dayBefore.setDate(dayBefore.getDate() - 1);
    await ctx.sleepUntil(dayBefore, { label: "day-before" });

    await sendEmail({ to: user.email, template: "day-before-checklist" });
  },
});`,
  },
  {
    path: "src/journeys/people/silver-medalist.ts",
    lang: "ts",
    source: `import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";

// The runner-up you'd hire tomorrow: keep them warm, and
// reach back out the moment the role reopens.
export const silverMedalist = defineJourney({
  meta: {
    id: "silver-medalist",
    trigger: { event: "candidate.runner_up" },
    exitOn: [{ event: "candidate.hired" }],
  },
  run: async (user, ctx) => {
    await sendEmail({ to: user.email, template: "stay-in-touch" });

    const { timedOut } = await ctx.waitForEvent({
      event: "role.reopened",
      timeout: days(60),
    });

    if (!timedOut) {
      await sendEmail({ to: user.email, template: "role-reopened" });
    }
  },
});`,
  },

  /* ---- emails ------------------------------------------------------------- */
  {
    path: "src/emails/welcome.tsx",
    lang: "tsx",
    source: `// Powered by react-email — a template is just a component.
import { Button, Heading, Text } from "@react-email/components";
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
      footer:
        "Sent by the onboarding journey — src/journeys/product/onboarding.ts.",
    },
  },
  {
    path: "src/emails/winback-offer.tsx",
    lang: "tsx",
    source: `// Powered by react-email — versioned and reviewed like
// the journey that sends it.
import { Button, Heading, Text } from "@react-email/components";
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
      footer: "Sent by the winback journey — src/journeys/product/winback.ts.",
    },
  },
  {
    path: "src/emails/pre-boarding-day-one.tsx",
    lang: "tsx",
    source: `// Powered by react-email — the people team's templates live
// beside product's, in the same repo.
import { Button, Heading, Text } from "@react-email/components";
import { EmailLayout } from "./_layout";

export function PreBoardingDayOne({ name }: { name: string }) {
  return (
    <EmailLayout preview="We can't wait — here's everything for day one.">
      <Heading>You're in, {name} 🎉</Heading>
      <Text>
        Contract's signed — the whole team is excited. Your
        laptop ships this week; here's your day-one guide,
        your team, and where to show up.
      </Text>
      <Button href={docsUrl("/day-one")}>Read the day-one guide</Button>
    </EmailLayout>
  );
}`,
    email: {
      subject: "You're in! Here's day one",
      preheader: "We can't wait — everything you need for your first day.",
      heading: "You're in 🎉",
      body: [
        "Contract's signed — the whole team is excited. Your laptop ships this week.",
        "Here's your day-one guide, your team, and where to show up.",
      ],
      cta: { label: "Read the day-one guide" },
      footer: "Sent by pre-boarding — src/journeys/people/pre-boarding.ts.",
    },
  },

  /* ---- webhook sources ---------------------------------------------------- */
  {
    path: "src/webhook-sources/stripe.ts",
    lang: "ts",
    source: `import { stripeSource } from "@hogsend/engine";

// The built-in Stripe preset: signature-verified with node:crypto,
// events normalized (invoice.payment_failed, subscription.updated, …)
// so any of them can trigger a journey. Set STRIPE_WEBHOOK_SECRET
// and point Stripe at POST /v1/webhooks/stripe — that's the setup.
export const stripe = stripeSource;`,
  },

  /* ---- scripts ------------------------------------------------------------ */
  {
    path: "scripts/event-qr.sh",
    lang: "bash",
    source: `# Mint a tracked link for the event posters — vanity slug,
# first-party clicks, QR from the same API.
curl -X POST "$API_URL/v1/admin/links" \\
  -H "Authorization: Bearer $HOGSEND_SECRET_KEY" \\
  -d '{
    "url": "https://my-app.com/live",
    "slug": "doors-open"
  }'

# → vanity /l/doors-open · QR via /v1/admin/links/:id/qr
# The QR encodes the durable id, never the destination —
# a printed poster can be re-pointed after it ships.`,
  },

  /* ---- entry points -------------------------------------------------------- */
  {
    path: "src/worker.ts",
    lang: "ts",
    source: `// Powered by Hatchet — every journey runs as a durable task.
// A seven-day sleep survives deploys, restarts, and crashes.
import { createWorker } from "@hogsend/engine";
import { client } from "./client";
import { journeys } from "./journeys";

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

# Webhook sources auto-enable when their secret is set.
STRIPE_WEBHOOK_SECRET=whsec_...

# Connectors
DISCORD_BOT_TOKEN=...

# Optional: PostHog turns on identity + person properties.
POSTHOG_API_KEY=phc_...`,
  },
];
