import type React from "react";
import { defineVideo, type VideoConfig } from "../../lib/define-video";
import { type ClipSpec, clipDuration, JourneyClip } from "./trace";

// ---------------------------------------------------------------------------
// Embeddable journey clips — bare trace runs of the REAL dogfood journeys
// (apps/api/src/journeys), trimmed for the frame. No hooks, no end cards:
// these loop inside landing-page sections and docs.
// ---------------------------------------------------------------------------

const SPECS: ClipSpec[] = [
  // The full onboarding journey from the use-case page — every mechanic
  // in one run: send, engine fan-out, a durable wait that RESOLVES,
  // branch on the answer, person write-back.
  {
    id: "journey-onboarding",
    file: "src/journeys/onboarding.ts",
    code: `export const onboarding = defineJourney({
  meta: { trigger: { event: Events.USER_SIGNED_UP } },
  run: async (user, ctx) => {
    await sendEmail({ template: "quickstart" });

    const { timedOut } = await ctx.waitForEvent({
      event: Events.PROJECT_CREATED,
      timeout: days(3),
    });

    await sendEmail({
      template: timedOut
        ? "activation-nudge"
        : "feature-highlight",
    });

    getPostHog()?.identify(user.id, { activated: true });
  },
});`,
    steps: [
      { kind: "event", event: "user.signed_up", band: [1, 1] },
      {
        kind: "send",
        subject: "Welcome — your shortest path to a first win",
        band: [3, 1],
      },
      {
        kind: "fanout",
        events: ["email.delivered", "email.opened"],
        band: [3, 1],
      },
      {
        kind: "wait",
        event: "project.created",
        timeout: "3d",
        resolve: "arrived · 41h",
        band: [5, 4],
      },
      {
        kind: "send",
        subject: "Nice — here's what to try next",
        clicked: true,
        accent: true,
        band: [10, 5],
      },
      {
        kind: "fanout",
        label: "identify",
        events: ["activated: true"],
        band: [16, 1],
      },
    ],
  },

  // activation-welcome.ts — welcome, then branch on what they actually did.
  {
    id: "journey-welcome",
    file: "src/journeys/welcome.ts",
    code: `export const welcome = defineJourney({
  meta: { trigger: { event: Events.USER_CREATED } },
  run: async (user, ctx) => {
    await sendEmail({ template: "welcome" });

    await ctx.sleep({ duration: days(2) });

    const { found } = await ctx.history.hasEvent({
      event: Events.FEATURE_USED,
    });

    await sendEmail({
      template: found
        ? "advanced-tips"
        : "activation-nudge",
    });
  },
});`,
    steps: [
      { kind: "event", event: "user.created", band: [1, 1] },
      {
        kind: "send",
        subject: "Welcome to Hogsend — let's get you set up",
        band: [3, 1],
      },
      { kind: "sleep", label: "2 days", days: 2, band: [5, 1] },
      {
        kind: "check",
        question: "feature_used",
        candidates: ["page.viewed", "feature.used*"],
        verdict: "found: true",
        band: [7, 3],
      },
      {
        kind: "send",
        subject: "Nice work — here's what to try next",
        clicked: true,
        accent: true,
        band: [11, 5],
      },
    ],
  },

  // churn-prevention.ts — dunning that stops the moment they pay (exitOn).
  {
    id: "journey-churn",
    file: "src/journeys/churn-prevention.ts",
    code: `export const churn = defineJourney({
  meta: {
    trigger: { event: Events.PAYMENT_FAILED },
    exitOn: [{ event: Events.PAYMENT_SUCCEEDED }],
  },
  run: async (user, ctx) => {
    await sendEmail({ template: "payment-failed" });

    await ctx.sleep({ duration: days(1) });

    await sendEmail({ template: "payment-reminder" });
  },
});`,
    steps: [
      { kind: "event", event: "payment.failed", band: [2, 1] },
      {
        kind: "send",
        subject: "Your payment didn't go through",
        clicked: true,
        band: [6, 1],
      },
      { kind: "sleep", label: "1 day", band: [8, 1] },
      {
        kind: "exit",
        event: "payment.succeeded",
        note: "card updated",
        band: [3, 1],
      },
    ],
  },

  // conversion-abandoned-checkout.ts — nudge only if they didn't finish.
  {
    id: "journey-checkout",
    file: "src/journeys/abandoned-checkout.ts",
    code: `export const checkout = defineJourney({
  meta: { trigger: { event: Events.CHECKOUT_ABANDONED } },
  run: async (user, ctx) => {
    await ctx.sleep({ duration: hours(2) });

    const { found } = await ctx.history.hasEvent({
      event: Events.CHECKOUT_COMPLETED,
      within: hours(2),
    });
    if (found) return;

    await sendEmail({ template: "need-help" });
  },
});`,
    steps: [
      { kind: "event", event: "checkout.abandoned", band: [1, 1] },
      { kind: "sleep", label: "2 hours", band: [3, 1] },
      {
        kind: "check",
        question: "checkout_completed",
        sub: "within 2h",
        candidates: ["pricing.viewed", "docs.opened"],
        verdict: "found: false",
        band: [5, 4],
      },
      {
        kind: "send",
        subject: "Need help with anything?",
        clicked: true,
        accent: true,
        band: [11, 1],
      },
    ],
  },

  // feedback-nps.ts — semantic links: the click IS the answer.
  {
    id: "journey-nps",
    file: "src/journeys/feedback-nps.ts",
    code: `export const nps = defineJourney({
  meta: { trigger: { event: Events.USER_CREATED } },
  run: async (user, ctx) => {
    await ctx.sleep({ duration: days(14) });

    await sendEmail({ template: "nps-survey" });

    const answer = await ctx.waitForEvent({
      event: Events.NPS_SUBMITTED,
      timeout: days(3),
    });

      const score = answer.properties?.score;
    await ctx.checkpoint(\`scored-\${score}\`);
  },
});`,
    steps: [
      { kind: "event", event: "user.created", band: [1, 1] },
      { kind: "sleep", label: "14 days", band: [3, 1] },
      {
        kind: "send",
        subject: "Quick question — how are we doing?",
        band: [5, 1],
      },
      {
        kind: "wait",
        event: "nps.submitted",
        timeout: "3d",
        resolve: "score: 9",
        band: [7, 4],
      },
    ],
  },

  // reactivation-dormancy.ts — win-back, offer picked off a person property.
  {
    id: "journey-winback",
    file: "src/journeys/winback.ts",
    code: `export const winback = defineJourney({
  meta: { trigger: { event: Events.USER_DORMANCY_DETECTED } },
  run: async (user, ctx) => {
    await sendEmail({ template: "we-miss-you" });

    await ctx.sleep({ duration: days(7) });

    const paid = user.properties.plan === "paid";
    await sendEmail({
      template: paid
        ? "winback-offer"
        : "whats-new",
    });
  },
});`,
    steps: [
      { kind: "event", event: "user.dormancy_detected", band: [1, 1] },
      {
        kind: "send",
        subject: "We haven't seen you in a while",
        band: [3, 1],
      },
      { kind: "sleep", label: "7 days", band: [5, 1] },
      {
        kind: "check",
        question: "user.plan",
        verdict: 'plan: "paid"',
        band: [7, 1],
      },
      {
        kind: "send",
        subject: "We'd hate to see you go — here's an option",
        clicked: true,
        accent: true,
        band: [8, 5],
      },
    ],
  },

  // feedback-nps.ts — everything fans back out to PostHog: the engine
  // emits the email lifecycle first-party, the journey writes the score
  // back as a person property.
  {
    id: "journey-posthog",
    file: "src/journeys/feedback-nps.ts",
    code: `export const survey = defineJourney({
  meta: { trigger: { event: Events.USER_CREATED } },
  run: async (user, ctx) => {
    await sendEmail({ template: "nps-survey" });

    const answer = await ctx.waitForEvent({
      event: Events.NPS_SUBMITTED,
      timeout: days(3),
    });

    const score = answer.properties?.score;
    getPostHog()?.identify(user.id, {
      nps_score: score,
    });
  },
});`,
    steps: [
      { kind: "event", event: "user.created", band: [1, 1] },
      {
        kind: "send",
        subject: "Quick question — how are we doing?",
        band: [3, 1],
      },
      {
        kind: "fanout",
        events: ["email.delivered", "email.opened", "email.link_clicked"],
        band: [3, 1],
      },
      {
        kind: "wait",
        event: "nps.submitted",
        timeout: "3d",
        resolve: "score: 9",
        band: [5, 4],
      },
      {
        kind: "fanout",
        label: "identify",
        events: ["nps_score: 9"],
        band: [11, 3],
      },
    ],
  },

  // retention-milestone.ts — celebrate, then invite the share.
  {
    id: "journey-milestone",
    file: "src/journeys/milestone.ts",
    code: `export const milestone = defineJourney({
  meta: {
    trigger: { event: Events.MILESTONE_REACHED },
    entryLimit: "unlimited",
  },
  run: async (user, ctx) => {
    await sendEmail({ template: "congrats" });

    await ctx.sleep({ duration: days(1) });

    await sendEmail({ template: "share-it" });
  },
});`,
    steps: [
      { kind: "event", event: "milestone.reached", band: [2, 1] },
      {
        kind: "send",
        subject: "Congratulations on your achievement!",
        clicked: true,
        band: [6, 1],
      },
      { kind: "sleep", label: "1 day", band: [8, 1] },
      {
        kind: "send",
        subject: "Share your achievement with the community",
        band: [10, 1],
      },
    ],
  },
];

const makeClip = (spec: ClipSpec): VideoConfig => {
  const Clip: React.FC = () => <JourneyClip spec={spec} />;
  return defineVideo({
    id: spec.id,
    durationInFrames: clipDuration(spec.steps),
    fps: 30,
    component: Clip,
  });
};

export const JOURNEY_CLIPS: VideoConfig[] = SPECS.map(makeClip);
