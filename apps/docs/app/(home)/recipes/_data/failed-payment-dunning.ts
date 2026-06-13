import type { RecipeLander } from "./types";

const JOURNEY_CODE = `export const dunning = defineJourney({
  meta: {
    id: "dunning",
    name: "Billing — failed payment dunning",
    enabled: true,
    trigger: { event: Events.INVOICE_PAYMENT_FAILED },
    // a card that keeps failing re-enters at most once a week
    entryLimit: "once_per_period",
    entryPeriod: days(7),
    suppress: hours(4),
    exitOn: [
      { event: Events.INVOICE_PAID },         // recovered — stop immediately
      { event: Events.SUBSCRIPTION_DELETED }, // cancelled — stop dunning
    ],
  },

  run: async (user, ctx) => {
    // Immediately: most failures are a stale card, not a churn decision.
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.BILLING_PAYMENT_FAILED,
      subject: "Your payment didn't go through",
      journeyName: user.journeyName,
    });

    // Stripe retries on its own schedule — give the first retry three days.
    const firstRetry = await ctx.waitForEvent({
      event: Events.INVOICE_PAID,
      timeout: days(3),
      label: "await-first-retry",
    });
    if (!firstRetry.timedOut) return; // recovered — exitOn already handled it
    if (!(await ctx.guard.isSubscribed())) return;

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.BILLING_UPDATE_CARD,
      subject: "Action needed: update your payment method",
      journeyName: user.journeyName,
    });

    const secondRetry = await ctx.waitForEvent({
      event: Events.INVOICE_PAID,
      timeout: days(4),
      label: "await-second-retry",
    });
    if (!secondRetry.timedOut) return;
    if (!(await ctx.guard.isSubscribed())) return;

    // Day 7: final notice to the customer…
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.BILLING_FINAL_NOTICE,
      subject: "Final notice: your subscription will be paused",
      journeyName: user.journeyName,
    });

    // …and the failure leaves the email channel: flag it for a human.
    await ctx.trigger({
      event: Events.DUNNING_EXHAUSTED,
      userId: user.id,
      userEmail: user.email,
      properties: { stage: "final-notice", source: "dunning" },
    });
  },
});`;

const ALERT_CODE = `// Picks up dunning.exhausted via onEvents — outside the journey,
// so an invoice.paid that cancels the run can't swallow the alert.
export const dunningAlertTask = hatchet.durableTask({
  name: "dunning-alert",
  onEvents: [Events.DUNNING_EXHAUSTED],
  retries: 2,
  executionTimeout: "10m",
  fn: async (input: {
    userId: string;
    userEmail: string;
    properties: Record<string, string | number | boolean | null>;
  }) => {
    const { emailService } = getContainer();

    const result = await emailService.send({
      template: Templates.INTERNAL_DUNNING_ALERT,
      to: process.env.BILLING_ALERT_EMAIL ?? "ops@example.com",
      subject: \`[Dunning] Recovery failed — \${input.userEmail}\`,
      props: {
        customerEmail: input.userEmail,
        stage: String(input.properties.stage ?? ""),
      },
      // Operator mail: the customer's unsubscribe must never gate it.
      skipPreferenceCheck: true,
      // A retry after a successful send reuses the prior email_sends row.
      idempotencyKey: \`dunning-alert:\${input.userId}:\${input.properties.stage}\`,
    });

    return { status: result.status, emailSendId: result.emailSendId };
  },
});`;

export const failedPaymentDunning: RecipeLander = {
  slug: "failed-payment-dunning",
  category: "conversion",
  title: "Failed payment dunning",
  metaDescription:
    "A dunning journey in TypeScript triggered by Stripe's invoice.payment_failed: immediate notice, retry-window waits on invoice.paid, escalating reminders, and an operator alert task when recovery fails.",
  cardDescription:
    "Notify, wait through Stripe's retries, escalate twice, and stop the instant the invoice is paid.",
  eyebrow: "Recipe — Trial, billing & upgrades",
  subhead:
    "One durable journey paces the whole recovery: invoice.payment_failed in via the signature-verified Stripe source, each wait resolved the instant invoice.paid lands, and a final failure routed to a human by a separate Hatchet task.",
  problem: {
    label: "The dunning problem",
    statement:
      'Dunning is usually a daily cron over the invoices table: query past-due accounts, join the unsubscribe list, and send. Stripe retries on its own schedule and your reminders fire on yours, so nothing connects them — the customer who paid an hour ago still gets "your payment failed", a webhook redelivery enrolls the same invoice twice, and the account that finally exhausts every retry fails silently with no human told.',
  },
  walkthrough: {
    eyebrow: "The journey",
    title: "The retry window is a wait, not a poll",
    subtitle:
      "Trigger, both retry-window waits, both escalations, and the exit rules live in one defineJourney() — Stripe's invoice.paid resolves a wait the moment it arrives.",
    note: "Both waits are durable Hatchet primitives that survive deploys and restarts, and invoice.paid or subscription.deleted in exitOn ends the run mid-wait with no further sends.",
  },
  code: [
    {
      filename: "src/journeys/dunning.ts",
      code: JOURNEY_CODE,
      caption:
        "waitForEvent paces the reminders; exitOn guarantees a recovered payment — or a cancellation — kills the run at any point, even mid-wait.",
    },
    {
      filename: "src/workflows/dunning-alert.ts",
      code: ALERT_CODE,
      caption:
        "The operator alert is a separate durable task registered via extraWorkflows — it holds its own copy of the event and sends with skipPreferenceCheck.",
    },
  ],
  points: [
    {
      title: "The retry window is a wait, not a poll",
      body: 'ctx.waitForEvent({ event: "invoice.paid", timeout: days(3) }) resolves the instant Stripe\'s retry succeeds — no cron sweeping past-due invoices, no gap between recovery and the next reminder being cancelled.',
    },
    {
      title: "exitOn ends the run mid-anything",
      body: "A recovered payment or a cancellation cancels the durable run even mid-wait, so the paid-then-dunned race structurally can't happen. A cancelled subscriber stops getting payment reminders the moment subscription.deleted arrives.",
    },
    {
      title: "Signature-verified ingestion with dedupe built in",
      body: 'The Stripe preset verifies the stripe-signature header with node:crypto (5-minute tolerance, rotation-safe) and uses the Stripe event id as the idempotencyKey — an at-least-once redelivery is a no-op, and entryLimit: "once_per_period" backstops it at the journey level.',
    },
    {
      title: "The final alert can't be lost",
      body: "dunning.exhausted is a real ingested event consumed by a separate durable task. The task holds its own copy, retries independently, sends operator mail with skipPreferenceCheck (the customer's unsubscribe never gates it), and idempotency-keys the send against task retries.",
    },
  ],
  faq: [
    {
      q: "Do I need the Stripe SDK?",
      a: "No. The built-in Stripe source verifies the stripe-signature header itself using node:crypto and maps invoice events into the pipeline. Setting STRIPE_WEBHOOK_SECRET is the whole integration; with the secret unset the route fails closed with 401.",
    },
    {
      q: "What happens if the customer pays while a reminder is queued?",
      a: "invoice.paid is in meta.exitOn, so the event cancels the journey's durable run immediately — including mid-wait — and no further sends fire. The wait also resolves with timedOut: false, so the code path returns early as well.",
    },
    {
      q: "Why is the operator alert a separate task instead of a send in the journey?",
      a: "Two reasons. An invoice.paid arriving seconds after the trigger cancels the journey's run, but the task already holds the event, so the alert still sends. And operator mail needs skipPreferenceCheck via emailService.send — journey-side sendEmail deliberately can't bypass the customer's preferences.",
    },
    {
      q: "What about customers who unsubscribed from email?",
      a: "Journey sends respect the global unsubscribe — that's what the guard checks enforce. If your policy treats a final notice as must-deliver, send it from your billing system with hs.emails.send and skipPreferenceCheck: true, which requires a full-admin key (see /docs/recipes/transactional-emails).",
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/failed-payment-dunning",
    },
    {
      label: "Stripe integration — event mapping",
      href: "/docs/integrations/stripe",
    },
    {
      label: "Webhook sources guide — the IngestEvent contract",
      href: "/docs/guides/webhook-sources",
    },
  ],
  related: [
    "cancellation-save",
    "trial-conversion-sequence",
    "usage-limit-upgrade",
  ],
};
