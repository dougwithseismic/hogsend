/* ==========================================================================
 *  The engine files behind the system map's IDE stage.
 *
 *  Every snippet is the real authoring API (defineJourney, ctx.digest,
 *  ctx.waitForEvent, refineContact, ctx.variant, holdout/goal, groups,
 *  defineWebhookSource, defineBucket + typed transition refs, campaigns,
 *  flags, MCP) trimmed to fit one editor pane — the same shapes the
 *  dogfood app ships.
 *
 *  Files are grouped per pillar via `step` (matches ENGINE_STEPS keys in
 *  system-map.tsx). `notes` is the right-rail narration — documentation
 *  voice: plain sentences a non-engineer can read, every one a checkable
 *  fact.
 * ========================================================================== */

export type EngineCodeFile = {
  key: string;
  /** ENGINE_STEPS key this file belongs to. */
  step: "measure" | "react" | "prove" | "steer";
  /** Editor tab label. */
  file: string;
  lang: string;
  source: string;
  /** Right-rail narration — what's actually happening in this file. */
  notes: string[];
};

export const ENGINE_CODE: EngineCodeFile[] = [
  /* ------------------------------------------------------------- measure -- */
  {
    key: "high-fit",
    step: "measure",
    file: "journeys/high-fit-welcome.ts",
    lang: "ts",
    source: `import { refineContact } from "@hogsend/engine";
import { defineJourney, sendEmail } from "@hogsend/engine";

export const highFitWelcome = defineJourney({
  meta: {
    id: "high-fit-welcome",
    trigger: { event: "user.signed_up" },
  },
  run: async (user, ctx) => {
    // Apollo fills title, company, size — only where your
    // own data has gaps. Cached, budget-capped, never throws.
    const { status, properties } = await refineContact({
      userId: user.id,
      email: user.email,
    });

    const bigTeam = (properties?.company_employees ?? 0) >= 50;

    await sendEmail({
      to: user.email,
      template: bigTeam ? "team-welcome" : "welcome",
    });
  },
});`,
    notes: [
      "The moment someone signs up, enrichment looks them up: job title, company, company size.",
      "It only fills the blanks — anything you already know about a person is never overwritten.",
      "Lookups are cached and budget-capped, and a failed lookup never breaks the journey.",
      "So the very first email can already tell a 50-person team apart from a solo founder.",
    ],
  },
  {
    key: "lead-form",
    step: "measure",
    file: "webhook-sources/lead-form.ts",
    lang: "ts",
    source: `import { defineWebhookSource } from "@hogsend/engine";
import { z } from "zod";

// Any form vendor's webhook becomes a source —
// Heyflow, Webflow, Framer, or your own backend.
export const leadForm = defineWebhookSource({
  meta: { id: "lead-form", name: "Lead form" },
  auth: {
    header: "x-lead-form-secret",
    envKey: "LEAD_FORM_WEBHOOK_SECRET",
    type: "match",
  },
  schema: z
    .object({
      email: z.string().email(),
      name: z.string().optional(),
      value: z.number().finite().optional(),
    })
    .catchall(z.unknown()),
  async transform(payload) {
    return {
      event: "lead.submitted",
      userEmail: payload.email,
      properties: payload,
    };
  },
});`,
    notes: [
      "Any tool that can send a webhook — a form builder, your billing system, anything — becomes a source with one small file like this.",
      "The payload is checked against a schema first, so junk never reaches your data.",
      "The event it produces joins the same stream as everything else — and can start journeys on its own.",
    ],
  },
  {
    key: "accounts",
    step: "measure",
    file: "lib/accounts.ts",
    lang: "ts",
    source: `import { Hogsend } from "@hogsend/client";

const hs = new Hogsend({
  baseUrl: process.env.HOGSEND_API_URL!,
  apiKey: process.env.HOGSEND_DATA_KEY!,
});

// The company behind the person — properties live
// on the account, not just the contact.
await hs.groups.identify({
  groupType: "company",
  groupKey: "acme.dev",
  displayName: "Acme",
  properties: { plan: "scale", seats: 14 },
});

await hs.groups.addMember({
  groupType: "company",
  groupKey: "acme.dev",
  contactId: contact.id,
  role: "admin",
});`,
    notes: [
      "Groups track the company behind the person — things like plan and seat count live on the account itself.",
      "Add people to the group and their activity rolls up to the account.",
      "If PostHog is connected, all of it forwards as group analytics automatically. Without it, groups still work on their own.",
    ],
  },
  {
    key: "went-dormant",
    step: "measure",
    file: "buckets/went-dormant.ts",
    lang: "ts",
    source: `import { days, defineBucket } from "@hogsend/engine";

// The segment behind the winback journey — going dormant
// IS the trigger.
export const wentDormant = defineBucket({
  meta: {
    id: "went-dormant",
    enabled: true,
    timeBased: true,
    criteria: (b) =>
      b.all(
        b.event("app.active").exists(),
        b.event("app.active").within(days(7)).notExists(),
      ),
  },
});`,
    notes: [
      "This file describes who counts as dormant: they were active once, and have been silent for a week.",
      "Membership updates itself as events arrive — there's no nightly job and no stale list.",
      "Falling in, or climbing back out, fires an event that other code can react to.",
    ],
  },

  /* --------------------------------------------------------------- react -- */
  {
    key: "onboarding",
    step: "react",
    file: "journeys/onboarding.ts",
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

    // Park durably until THIS user creates a project —
    // or 3 days pass. Survives every deploy in between.
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
    notes: [
      "Someone signs up and this journey picks them up. It runs once per person — the engine makes sure of that.",
      "The welcome email is a React component living in this same repo, right next to this file.",
      "Then it waits up to three days for them to create a project. The wait is durable — deploys, restarts, and crashes don't lose their place.",
      "One plain if/else decides the next email: a nudge if they stalled, a congratulations if they got there.",
    ],
  },
  {
    key: "welcome-template",
    step: "react",
    file: "emails/welcome.tsx",
    lang: "tsx",
    source: `import { Layout } from "./_components/layout";
import { Body, Button, Title } from "./_components/ui";
import type { WelcomeEmailProps } from "./types";

export default function WelcomeEmail({
  name = "there",
  setupUrl,
  unsubscribeUrl,
}: WelcomeEmailProps) {
  return (
    <Layout
      preview="You're in — here's the fastest path to a first win."
      eyebrow="Welcome"
      unsubscribeUrl={unsubscribeUrl}
    >
      <Title>Welcome, {name}</Title>
      <Body>
        Your workspace is ready. The fastest way to see value
        is to send one event and watch a journey pick it up.
      </Body>
      <Button href={setupUrl}>Send your first event</Button>
    </Layout>
  );
}`,
    notes: [
      "Emails are React components — you build them the same way you build the rest of your product.",
      "Props are typed, so a journey passing the wrong data fails the build, not the send.",
      "The same component previews in Studio and renders to HTML at send time.",
    ],
  },
  {
    key: "nps",
    step: "react",
    file: "journeys/nps.ts",
    lang: "ts",
    source: `import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";

export const nps = defineJourney({
  meta: {
    id: "feedback-nps",
    trigger: { event: "user.activated" },
    entryLimit: "once",
  },
  run: async (user, ctx) => {
    await ctx.sleep({ duration: days(14), label: "day-14" });

    // The 0–10 buttons in this email are links that fire
    // a real nps.submitted event with the score attached.
    await sendEmail({
      to: user.email,
      template: "nps-survey",
      idempotencyLabel: "nps-survey",
    });

    let answer = await ctx.waitForEvent({
      event: "nps.submitted",
      timeout: days(3),
      label: "await-score",
    });

    if (answer.timedOut) {
      await sendEmail({
        to: user.email,
        template: "nps-survey",
        idempotencyLabel: "nps-reminder",
      });
      answer = await ctx.waitForEvent({
        event: "nps.submitted",
        timeout: days(7),
        label: "await-score-reminder",
      });
    }

    const score = answer.properties?.score;
    if (typeof score !== "number") return;

    if (score <= 6) {
      // Another journey picks the save attempt up from here.
      await ctx.trigger({
        event: "nps.detractor",
        userId: user.id,
        properties: { score },
      });
    }
  },
});`,
    notes: [
      "Two weeks in, the survey goes out. The 0–10 buttons are just links — clicking one fires a real event with the score attached.",
      "The journey waits for that click and reads the score straight off it. No form to build, no webhook to wire.",
      "No answer after three days? One reminder. The label on each send means a crashed worker can never send it twice.",
      "A low score hands the person to a separate save journey — automatically.",
    ],
  },
  {
    key: "digest",
    step: "react",
    file: "journeys/weekly-digest.ts",
    lang: "ts",
    source: `import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";

export const weeklyDigest = defineJourney({
  meta: {
    id: "weekly-digest",
    trigger: { event: "feature.used" },
    entryLimit: "unlimited",
  },
  run: async (user, ctx) => {
    // Absorb a rolling 7-day window of feature.used
    // into ONE execution — a busy week is one email.
    const digest = await ctx.digest({
      window: days(7),
      label: "weekly-activity",
    });

    // A week is a long wait — re-check consent first.
    if (!(await ctx.guard.isSubscribed())) return;

    // Batching is plain TypeScript over the window.
    const byFeature = Object.groupBy(digest.events, (e) =>
      String(e.properties?.feature ?? "Other"),
    );

    await sendEmail({
      to: user.email,
      template: "weekly-digest",
      props: {
        stats: Object.entries(byFeature).map(
          ([label, ev]) => ({ label, value: ev?.length }),
        ),
      },
    });
  },
});`,
    notes: [
      "Someone uses a feature and the journey starts collecting. Everything they do for the next seven days folds into one email instead of seven.",
      "Before sending, it re-checks they're still subscribed — a week is a long time.",
      "The summary itself is plain TypeScript: group the week's events however you like.",
    ],
  },
  {
    key: "bucket-winback",
    step: "react",
    file: "journeys/winback.ts",
    lang: "ts",
    source: `import { defineJourney, sendEmail } from "@hogsend/engine";
import { wentDormant } from "../buckets/went-dormant";

// Bucket → journey composition: falling into the
// bucket starts the sequence, leaving it ends it.
export const winback = defineJourney({
  meta: {
    id: "winback",
    trigger: { event: wentDormant.entered },
    // The moment they act again they leave the
    // bucket — and this run exits cleanly.
    exitOn: [{ event: wentDormant.left }],
  },
  run: async (user, ctx) => {
    await sendEmail({
      to: user.email,
      template: "reactivation-checkin",
    });
  },
});`,
    notes: [
      "This journey starts the moment someone falls into the dormant lane — the bucket itself is the trigger, and a typo'd bucket name fails the build.",
      "If they come back, they leave the bucket and the journey ends itself — even mid-wait.",
      "No scheduler, no segment sync: the lane movement is the automation.",
    ],
  },

  /* --------------------------------------------------------------- prove -- */
  {
    key: "experiment",
    step: "prove",
    file: "journeys/welcome-experiment.ts",
    lang: "ts",
    source: `import { defineJourney, sendEmail } from "@hogsend/engine";

// Subject-line A/B without an external experiment tool.
export const welcomeExperiment = defineJourney({
  meta: {
    id: "welcome-experiment",
    trigger: { event: "user.signed_up" },
    // Converted? Out instantly — mid-sequence, anywhere.
    exitOn: [{ event: "subscription.created" }],
  },
  run: async (user, ctx) => {
    // Deterministic per user — recorded on first pass,
    // replayed verbatim across redeploys. No RNG, no drift.
    const arm = await ctx.variant("subject", [
      "subject-a",
      "subject-b",
    ]);

    await sendEmail({
      to: user.email,
      template: arm === "subject-a" ? "welcome" : "first-win",
    });
  },
});`,
    notes: [
      "Half of new signups get one version, half get the other — decided per person, no external A/B tool.",
      "The split is stable: a redeploy or crash can never flip which version someone is in.",
      "The moment someone subscribes, they leave the experiment — no more test emails mid-checkout.",
      "The results read side by side in Studio, with revenue attached.",
    ],
  },
  {
    key: "holdout",
    step: "prove",
    file: "journeys/winback-holdout.ts",
    lang: "ts",
    source: `import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";

export const winback = defineJourney({
  meta: {
    id: "winback",
    trigger: { event: "user.dormancy_detected" },
    entryLimit: "once_per_period",
    entryPeriod: days(60),
    // 15% never get the message — the baseline
    // your lift number is read against.
    holdout: { percent: 15 },
    // Credit is scoped to money, not opens.
    goal: "revenue",
  },
  run: async (user, ctx) => {
    await sendEmail({
      to: user.email,
      template: "reactivation-checkin",
    });

    await ctx.sleep({ duration: days(7), label: "day-21" });

    if (user.properties.plan === "paid") {
      await sendEmail({
        to: user.email,
        template: "winback-offer",
      });
    }
  },
});`,
    notes: [
      "15% of eligible people never get the emails. That's the control group — built in, one line.",
      "The goal is revenue, so the comparison is money made, not emails opened.",
      "Too few conversions to trust? Studio says “collecting” instead of showing you a fake percentage.",
      "And nobody gets worked more than once every 60 days.",
    ],
  },

  {
    key: "funnel",
    step: "prove",
    file: "funnels.ts",
    lang: "ts",
    source: `import { defineFunnel } from "@hogsend/engine";

// The path to revenue, written as the events
// you already send. No query builder.
export const trialFunnel = defineFunnel({
  id: "trial",
  name: "Trial to paid",
  stages: [
    { id: "signed_up", on: "user.signed_up" },
    { id: "activated", on: "project.created" },
    { id: "trial_started", on: "trial.started" },
    {
      id: "subscribed",
      on: "subscription.created",
      milestone: "won",
    },
  ],
  // Only ever closes a deal that was actually open.
  lostOn: "trial.expired",
});`,
    notes: [
      "The path to revenue, written as events you already send: sign up, activate, start a trial, subscribe.",
      "Deals move stage when their event fires. Browser events can't forge a move — only trusted server sources count by default.",
      "subscription.created is the money stage — that's what the revenue readouts count as won.",
      "An expiring trial marks the deal lost, but only a deal that was actually open.",
    ],
  },

  /* --------------------------------------------------------------- steer -- */
  {
    key: "broadcast",
    step: "steer",
    file: "scripts/launch.ts",
    lang: "ts",
    source: `import { Hogsend } from "@hogsend/client";

const hs = new Hogsend({
  baseUrl: process.env.HOGSEND_API_URL!,
  apiKey: process.env.HOGSEND_DATA_KEY!,
});

// A one-off send you drive by hand — to a list,
// or to a LIVE bucket.
const { campaignId, status } = await hs.campaigns.send({
  name: "March launch",
  list: "product-updates",         // or a live bucket
  template: "launch-announcement", // typed vs your registry
  props: { feature: "Flags" },
  sendAt: "2026-08-01T09:00:00Z",  // omit to send now
});`,
    notes: [
      "A broadcast is a one-off send you drive by hand — to a list, or to a live bucket like “went dormant”.",
      "The audience is whoever is in the lane at send time, not a stale export.",
      "The template and its props are typed — a mistake fails the build, not the send.",
      "Schedule it with a date, or leave it off to send now. Either way it lands in the same stream and earns revenue credit like everything else.",
    ],
  },
  {
    key: "flags",
    step: "steer",
    file: "flags.ts",
    lang: "ts",
    source: `import { defineFlag } from "@hogsend/engine";

// Flags live in your repo — typed, reviewed, deployed.
export const newCheckout = defineFlag({
  key: "new-checkout-flow",
  name: "New checkout flow",
  type: "boolean",
});

// In React — the same shape as PostHog's hook:
// const enabled = useFlag("new-checkout-flow");`,
    notes: [
      "Feature flags live in the repo, next to the journeys and pages they gate.",
      "In React they read exactly like PostHog's hook — one line.",
      "One flag can gate an email, a page, or a whole branch of a journey.",
    ],
  },
  {
    key: "mcp",
    step: "steer",
    file: ".mcp.json",
    lang: "json",
    source: `{
  "mcpServers": {
    "hogsend": {
      "command": "npx",
      "args": ["-y", "@hogsend/mcp"],
      "env": {
        "HOGSEND_API_URL": "https://api.your-instance.com",
        "HOGSEND_ADMIN_KEY": "hsk_…"
      }
    }
  }
}`,
    notes: [
      "Point your coding agent at the engine and it can operate it: draft journey blueprints, pull reports, inspect what's running.",
      "Risky actions stay operator-gated — an agent can prepare a test send, but a human approves it.",
      "Works over stdio here, or hosted at /v1/mcp — Claude, Cursor, anything that speaks MCP.",
    ],
  },
];
