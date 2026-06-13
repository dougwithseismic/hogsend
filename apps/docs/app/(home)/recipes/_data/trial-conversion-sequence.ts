import type { RecipeLander } from "./types";

const ONBOARDING_CODE = `export const trialOnboarding = defineJourney({
  meta: {
    id: "trial-onboarding",
    name: "Conversion — trial onboarding",
    enabled: true,
    trigger: { event: Events.TRIAL_STARTED },
    entryLimit: "once",
    suppress: hours(12),
    exitOn: [
      { event: Events.SUBSCRIPTION_CREATED },
      { event: Events.USER_DELETED },
    ],
  },

  run: async (user, ctx) => {
    // Day 1 — one concrete outcome, not a feature tour.
    await ctx.sleep({ duration: days(1), label: "day-1" });
    if (!(await ctx.guard.isSubscribed())) return;

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.TRIAL_FIRST_VALUE,
      subject: "Get your first result today",
      journeyName: user.journeyName,
    });

    // Mid-trial — branch on what they actually did.
    await ctx.sleep({ duration: days(3), label: "mid-trial" });
    if (!(await ctx.guard.isSubscribed())) return;

    const usage = await ctx.history.hasEvent({
      userId: user.id,
      event: Events.FEATURE_USED,
      within: days(4),
    });

    if (usage.count >= 3) {
      // Engaged — sell the paid tier on what they already use.
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: Templates.TRIAL_UPGRADE_VALUE,
        subject: "You're getting value — here's what Pro adds",
        journeyName: user.journeyName,
        props: { usageCount: usage.count },
      });
    } else {
      // Cold — conversion needs activation first, not a pitch.
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: Templates.TRIAL_ACTIVATION_NUDGE,
        subject: "Three days in — the fastest path to a result",
        journeyName: user.journeyName,
      });
    }
  },
});`;

const EXPIRING_CODE = `// Triggered by the trial-expiring-soon bucket the moment a
// contact's trial_days_left drops to 3 — at any trial length.
export const trialExpiring = defineJourney({
  meta: {
    id: "trial-expiring",
    name: "Conversion — trial expiring",
    enabled: true,
    // typed ref — a misspelled bucket id is a compile error
    trigger: { event: trialExpiringSoon.entered },
    entryLimit: "once",
    suppress: hours(12),
    exitOn: [
      { event: trialExpiringSoon.left },      // converted or trial extended
      { event: Events.SUBSCRIPTION_CREATED },
    ],
  },

  run: async (user, ctx) => {
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.TRIAL_EXPIRING_SOON,
      subject: "Your trial ends in 3 days",
      journeyName: user.journeyName,
      props: { daysLeft: Number(user.properties.trial_days_left ?? 3) },
    });

    // Two days to upgrade on their own → last call lands at T-1.
    const { timedOut } = await ctx.waitForEvent({
      event: Events.SUBSCRIPTION_CREATED,
      timeout: days(2),
      label: "await-upgrade",
    });
    if (!timedOut) return; // they upgraded — exitOn already handled it
    if (!(await ctx.guard.isSubscribed())) return;

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.TRIAL_LAST_DAY,
      subject: "Last day — keep what you've built",
      journeyName: user.journeyName,
    });
  },
});`;

export const trialConversionSequence: RecipeLander = {
  slug: "trial-conversion-sequence",
  category: "conversion",
  title: "Trial conversion sequence",
  metaDescription:
    "The full trial arc in TypeScript: a day-1 value email, a mid-trial branch on real usage, a bucket-triggered T-3 push at any trial length, and a hard exit the instant subscription.created arrives.",
  cardDescription:
    "A day-1 value email, a usage branch mid-trial, a bucket-timed T-3 push — gone the instant they pay.",
  eyebrow: "Recipe — Trial, billing & upgrades",
  subhead:
    "Two durable journeys and one bucket cover the whole arc: the calendar leg counts forward from trial.started, the T-3 leg fires off a real-time bucket when trial_days_left hits 3, and subscription.created ends either one mid-step.",
  problem: {
    label: "The trial drip problem",
    statement:
      'Trial email is usually a fixed drip computed from signup: day 1, day 7, day 13. Vary the trial length, grant an extension, or let the user upgrade early and the math breaks — the "trial ending" email lands after the card was charged, or three days into a 30-day extension. Detecting "3 days left" needs a nightly cron over the accounts table, and a "did they actually use it" branch needs a segment export that is stale by the time it sends.',
  },
  walkthrough: {
    eyebrow: "The journeys",
    title: "Two clocks, two journeys, one bucket",
    subtitle:
      'trial-onboarding counts forward from trial.started; the T-3 push triggers off a trial-expiring-soon bucket that computes "3 days left" from contact properties — correct at any trial length.',
    note: "Every sleep and wait is durable, and exitOn carries subscription.created on both journeys — an upgrade at any point cancels the run before the next send fires, even mid-sleep.",
  },
  code: [
    {
      filename: "src/journeys/trial-onboarding.ts",
      code: ONBOARDING_CODE,
      caption:
        "The mid-trial branch is ctx.history.hasEvent at decision time — a count of the feature.used events your product already emits, not an exported segment.",
    },
    {
      filename: "src/journeys/trial-expiring.ts",
      code: EXPIRING_CODE,
      caption:
        "trialExpiringSoon.entered is a typed ref off the bucket's own id — the bucket joins when trial_days_left ≤ 3, so the push self-times against expiry instead of signup.",
    },
  ],
  points: [
    {
      title: "The T-3 push works at any trial length",
      body: "A sleep can only count forward from trial.started. The trial-expiring-soon bucket evaluates contact properties (plan, trial_days_left, converted) on every ingested event, so the join — and the journey it triggers — fires three days before expiry whether the trial runs 7, 14, or 30 days.",
    },
    {
      title: "exitOn stops the arc the moment money arrives",
      body: 'subscription.created is in exitOn on both journeys, so an upgrade cancels the run even mid-sleep or mid-wait. The "thanks for upgrading" / "your trial is ending tomorrow" collision structurally can\'t happen.',
    },
    {
      title: "The usage branch reads behavior, not a segment",
      body: 'ctx.history.hasEvent({ event: "feature.used", within: days(4) }) returns a live count at decision time. Engaged users get the upgrade pitch, cold users get an activation nudge — no segment export, nothing to go stale.',
    },
    {
      title: "Typed refs make the bucket binding compile-checked",
      body: 'trialExpiringSoon.entered is literal-typed off the bucket\'s id ("bucket:entered:trial-expiring-soon"). A misspelled binding is a compile error, not a journey that silently never triggers.',
    },
  ],
  faq: [
    {
      q: "Why two journeys instead of one long one?",
      a: "They answer to different clocks. The onboarding leg counts forward from trial.started; the expiry leg counts backward from a trial end the journey can't know at enrollment. Splitting them also gives each its own entryLimit and enable/disable switch.",
    },
    {
      q: "What happens if the user upgrades on day 2?",
      a: "subscription.created is in exitOn, so the onboarding run is cancelled mid-sleep and no further sends fire. The expiry journey never starts: the bucket's criteria exclude converted contacts, so the user never joins it.",
    },
    {
      q: "Where does trial_days_left come from?",
      a: "Your app sends it as a contactProperty on any event (a daily job, the session start). Contact properties merge onto the durable contact record, and bucket membership re-evaluates on ingest — there is no nightly segment recompute.",
    },
    {
      q: "What if a trial is extended?",
      a: 'trial_days_left rises above 3, the criteria stop matching, and bucket:left:trial-expiring-soon ends the expiry journey via exitOn — even mid-wait. With entryLimit "once" on the bucket, the push won\'t re-fire when the extension runs down; set once_per_period if you want re-entry.',
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/trial-conversion-sequence",
    },
    {
      label: "Buckets guide — criteria and typed refs",
      href: "/docs/guides/buckets",
    },
    {
      label: "Journeys guide — every ctx primitive",
      href: "/docs/guides/journeys",
    },
  ],
  related: [
    "usage-limit-upgrade",
    "cancellation-save",
    "failed-payment-dunning",
  ],
};
