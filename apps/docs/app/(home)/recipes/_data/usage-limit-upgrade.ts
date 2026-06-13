import type { RecipeLander } from "./types";

const JOURNEY_CODE = `export const usageLimitUpgrade = defineJourney({
  meta: {
    id: "usage-limit-upgrade",
    name: "Conversion — usage limit upgrade",
    enabled: true,
    trigger: {
      event: Events.USAGE_THRESHOLD_REACHED,
      // below 80% is not pressure — those events never enter the journey
      where: (b) => b.prop("usage_pct").gte(80),
    },
    entryLimit: "once_per_period",
    entryPeriod: days(30), // one nudge sequence per billing cycle
    suppress: hours(24),
    // usage.limit_hit is deliberately NOT here — the journey reacts to it.
    exitOn: [{ event: Events.SUBSCRIPTION_UPGRADED }],
  },

  run: async (user, ctx) => {
    // The trigger event's scalar properties ride in on user.properties.
    const usagePct = Number(user.properties.usage_pct ?? 80);
    const metric = String(user.properties.metric ?? "usage");

    // First touch — headroom is still optional, sell it as such.
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.USAGE_APPROACHING_LIMIT,
      subject: \`You've used \${usagePct}% of your plan\`,
      journeyName: user.journeyName,
      props: { usagePct, metric },
    });

    // Second touch only if they actually hit the wall.
    const wall = await ctx.waitForEvent({
      event: Events.USAGE_LIMIT_HIT,
      timeout: days(14),
      label: "await-limit-hit",
    });
    if (wall.timedOut) return; // never hit 100% — one nudge was enough

    if (!(await ctx.guard.isSubscribed())) return;

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.USAGE_LIMIT_HIT,
      subject: "You've hit your plan limit",
      journeyName: user.journeyName,
      props: {
        metric: String(wall.properties?.metric ?? metric),
        blockedCount: Number(wall.properties?.blocked_count ?? 0),
      },
    });
  },
});`;

const METERING_CODE = `// your metering job — both events drive the whole flow
await hs.events.send({
  name: "usage.threshold_reached",
  userId: account.id,
  email: account.ownerEmail,
  eventProperties: {
    usage_pct: 82,
    metric: "events", // flat scalars — the journey branches on these
    period: "2026-06",
  },
  idempotencyKey: \`usage-80-\${account.id}-2026-06\`,
});

// the wall — emitted by the limiter the first time a request is blocked
await hs.events.send({
  name: "usage.limit_hit",
  userId: account.id,
  eventProperties: { metric: "events", blocked_count: 1, period: "2026-06" },
  idempotencyKey: \`usage-100-\${account.id}-2026-06\`,
});`;

export const usageLimitUpgrade: RecipeLander = {
  slug: "usage-limit-upgrade",
  category: "conversion",
  title: "Usage limit upgrade",
  metaDescription:
    "An upgrade-nudge journey in TypeScript: enter at 80% usage via a trigger condition, send a second touch only when usage.limit_hit fires, one sequence per billing cycle, exit on subscription.upgraded.",
  cardDescription:
    "Nudge at 80%, escalate only at the wall, and stop the instant they upgrade.",
  eyebrow: "Recipe — Trial, billing & upgrades",
  subhead:
    "One durable journey gated by a trigger condition: metering can over-emit freely, only an 80%+ reading enrolls, the 100% email fires only if the wall is actually hit, and subscription.upgraded ends the run mid-wait.",
  problem: {
    label: "The upgrade-nudge problem",
    statement:
      "Usage nudges built on a scheduler need their own infrastructure: a job that diffs usage against thresholds, a table remembering who was already nudged this cycle, and a check that the customer didn't upgrade between the query and the send. Metering emits readings hourly, so without dedupe a user at 85% gets the same email every hour — and the 100% escalation either fires on a stale reading or needs yet another sweep.",
  },
  walkthrough: {
    eyebrow: "The journey",
    title: "The trigger condition is the audience",
    subtitle:
      'where: (b) => b.prop("usage_pct").gte(80) plus entryLimit: "once_per_period" replace the threshold-diff job, the nudge ledger, and the dedupe table.',
    note: "The 14-day wait for usage.limit_hit is a durable Hatchet primitive — it survives deploys, resolves the instant the wall event arrives with its payload, and an upgrade mid-wait cancels the run via exitOn before another send.",
  },
  code: [
    {
      filename: "src/journeys/usage-limit-upgrade.ts",
      code: JOURNEY_CODE,
      caption:
        "waitForEvent is the branch (did they hit the wall?); its payload names the blocked metric, and exitOn guarantees an upgrade at any point ends the run.",
    },
    {
      filename: "your metering job",
      code: METERING_CODE,
      caption:
        "Per-period idempotency keys make the metering job safe to re-run — a replayed crossing returns { stored: false } instead of re-firing.",
    },
  ],
  points: [
    {
      title: "The trigger condition is the audience",
      body: 'where: (b) => b.prop("usage_pct").gte(80) evaluates against the event\'s properties before any state is created. Metering can emit hourly readings at any percentage; sub-80 events are skipped and never appear as journey runs.',
    },
    {
      title: "One sequence per billing cycle",
      body: 'entryLimit: "once_per_period" with entryPeriod: days(30) enrolls the first matching event in a cycle and skips every re-fire inside the window with "period_not_elapsed" — no nudge ledger to maintain.',
    },
    {
      title: "The second touch waits for the wall, not the calendar",
      body: 'ctx.waitForEvent({ event: "usage.limit_hit", timeout: days(14) }) resolves the moment the limiter blocks a request, payload included — so the escalation email names the blocked metric instead of restating a percentage.',
    },
    {
      title: "An upgrade ends it instantly",
      body: "subscription.upgraded is in exitOn, so the run is cancelled even mid-wait. The customer who upgrades at 92% never receives the limit-hit email — without any check on your side.",
    },
  ],
  faq: [
    {
      q: "My metering job fires usage.threshold_reached every hour — won't that spam?",
      a: 'No. The trigger condition drops everything under 80%, entryLimit: "once_per_period" admits one enrollment per 30 days, and per-period idempotency keys dedupe replays before any of that. Over-emitting is the expected shape.',
    },
    {
      q: "Why isn't usage.limit_hit in exitOn?",
      a: "Because the journey reacts to it. An exitOn match mid-wait aborts the run before the post-wait send executes — the limit-hit email would never fire. One event name, one role: awaited events stay out of exitOn.",
    },
    {
      q: "How does the limit-hit email know what was blocked?",
      a: "waitForEvent returns the matched event's payload as best-effort scalars. The limiter sends metric and blocked_count as eventProperties, and the journey passes them as typed template props.",
    },
    {
      q: "What if usage drops back below 80% after enrollment?",
      a: "Nothing exits — the run waits out the 14 days, sends nothing more, and completes. The next cycle's crossing can re-enroll once entryPeriod has elapsed.",
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/usage-limit-upgrade",
    },
    {
      label: "Conditions guide — the operator set",
      href: "/docs/guides/conditions",
    },
    {
      label: "Journeys guide — every ctx primitive",
      href: "/docs/guides/journeys",
    },
  ],
  related: [
    "trial-conversion-sequence",
    "failed-payment-dunning",
    "cancellation-save",
  ],
};
