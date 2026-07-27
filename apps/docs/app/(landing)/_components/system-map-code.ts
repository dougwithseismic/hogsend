/* ==========================================================================
 *  The four engine files behind the system map's sticky IDE stage.
 *
 *  Every snippet is the real authoring API (defineJourney, refineContact,
 *  ctx.variant, defineBucket) trimmed to fit one editor pane — the same
 *  sources the scaffold explorer ships, kept short. Index-matched to
 *  ENGINE_STEPS in system-map.tsx.
 * ========================================================================== */

export type EngineCodeFile = {
  key: string;
  /** Editor tab label. */
  file: string;
  lang: string;
  source: string;
};

export const ENGINE_CODE: EngineCodeFile[] = [
  {
    key: "journeys",
    file: "onboarding.ts",
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
  },
  {
    key: "enrichment",
    file: "high-fit-welcome.ts",
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
  },
  {
    key: "conversions",
    file: "welcome-experiment.ts",
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
  },
  {
    key: "buckets",
    file: "went-dormant.ts",
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
  },
];
