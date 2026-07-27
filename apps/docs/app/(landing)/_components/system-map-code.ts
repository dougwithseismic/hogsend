/* ==========================================================================
 *  The engine files behind the system map's IDE stage.
 *
 *  Every snippet is the real authoring API (defineJourney, ctx.digest,
 *  ctx.waitForEvent, refineContact, ctx.variant, holdout/goal,
 *  defineWebhookSource, defineBucket + typed transition refs) trimmed to
 *  fit one editor pane — the same shapes the dogfood app ships.
 *
 *  Files are grouped per engine moment via `step` (matches ENGINE_STEPS
 *  keys in system-map.tsx). `notes` is the right-rail narration — what is
 *  actually happening, line by line, every line a checkable fact.
 * ========================================================================== */

export type EngineCodeFile = {
  key: string;
  /** ENGINE_STEPS key this file belongs to. */
  step: "journeys" | "enrichment" | "conversions" | "buckets";
  /** Editor tab label. */
  file: string;
  lang: string;
  source: string;
  /** Right-rail narration — what's actually happening in this file. */
  notes: string[];
};

export const ENGINE_CODE: EngineCodeFile[] = [
  /* ------------------------------------------------------------ journeys -- */
  {
    key: "onboarding",
    step: "journeys",
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
      "user.signed_up fires and the journey enrolls this user — once, ever. The entry limit is engine-enforced.",
      "The welcome email renders from a React template that lives in this same repo.",
      "ctx.waitForEvent parks the run for up to 3 days. The wait is durable — deploys, restarts, and crashes don't lose it.",
      "The branch is plain TypeScript: nudge the stalled, congratulate the activated.",
    ],
  },
  {
    key: "nps",
    step: "journeys",
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
      "The survey's score buttons are semantic links — a click fires a real nps.submitted event carrying the score. No form, no webhook glue.",
      "ctx.waitForEvent reads the answer straight off the click and the journey branches on it.",
      "No answer in 3 days → one reminder. The distinct idempotencyLabel keeps a worker replay from ever double-sending.",
      "A 6-or-below triggers nps.detractor — a separate save journey enrolls from that event.",
    ],
  },
  {
    key: "digest",
    step: "journeys",
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
      "The first feature.used enrolls the user; every one that lands during the 7-day window is absorbed by ctx.digest instead of sending again.",
      "A busy week becomes ONE email, not one per action.",
      "After the week-long window the journey re-checks consent before sending — unsubscribes mid-window are honored.",
      "The grouping is Object.groupBy — the digest collects the window, the batching logic is yours.",
    ],
  },

  /* ---------------------------------------------------------- enrichment -- */
  {
    key: "high-fit",
    step: "enrichment",
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
      "refineContact asks Apollo for title, company, and size the moment the contact appears.",
      "Fill-if-absent: it only writes fields your own data hasn't filled. Nothing you know gets overwritten.",
      "Lookups are cached and budget-capped, and the call never throws mid-journey.",
      "The very first email already branches on company size — a 50-person team gets the team pitch.",
    ],
  },
  {
    key: "lead-form",
    step: "enrichment",
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
      "Any service that can POST a webhook becomes a source: authenticated by a shared-secret header, validated with Zod, transformed in one function.",
      "The returned event enters the same stream as everything else — it can enroll journeys directly.",
      "The contact record upserts from the payload, so a lead form fills the CRM side too.",
    ],
  },

  /* --------------------------------------------------------- conversions -- */
  {
    key: "experiment",
    step: "conversions",
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
      "ctx.variant deals each user a deterministic arm — a pure hash, no RNG, no clock.",
      "The arm is recorded on first pass and replayed verbatim, so a redeploy never flips someone's experience mid-journey.",
      "exitOn pulls anyone who converts out instantly, even mid-sequence.",
      "Arms read against each other in the conversion readout — no external experiment tool.",
    ],
  },
  {
    key: "holdout",
    step: "conversions",
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
      "holdout: 15% of eligible users never get the message — the control group is built into the journey, not bolted on.",
      "goal: \"revenue\" scopes credit to money. Lift is the arm's revenue against the holdout's, not opens or clicks.",
      'Under 10 conversions the verdict stays "collecting" — small cohorts ship flagged, never as a fake percentage.',
      "once_per_period caps re-entry: a user can only be worked once every 60 days.",
    ],
  },

  /* ------------------------------------------------------------- buckets -- */
  {
    key: "went-dormant",
    step: "buckets",
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
      "Declarative criteria: was active at some point, silent for the last 7 days.",
      "Membership recomputes as events arrive — no nightly sync job, no stale lists.",
      "Entering and leaving each emit a typed transition event other code can react to.",
    ],
  },
  {
    key: "bucket-winback",
    step: "buckets",
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
      "wentDormant.entered is the bucket's typed transition ref — the journey triggers off the bucket itself, and a typo'd id is a compile error.",
      "The user acts again → they leave the bucket → exitOn ends the sequence cleanly, even mid-wait.",
      "No scheduler, no saved segment sync: the lane movement IS the automation.",
    ],
  },
];
