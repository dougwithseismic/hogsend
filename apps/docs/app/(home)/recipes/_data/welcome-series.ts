import type { RecipeLander } from "./types";

const JOURNEY_CODE = `export const welcomeSeries = defineJourney({
  meta: {
    id: "welcome-series",
    name: "Onboarding — welcome series",
    enabled: true,
    trigger: { event: Events.USER_SIGNED_UP },
    entryLimit: "once",
    suppress: hours(12),
    exitOn: [{ event: Events.USER_DELETED }],
  },

  run: async (user, ctx) => {
    // Day 0 — welcome
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.ONBOARDING_WELCOME,
      subject: "Welcome — here's how to get set up",
      journeyName: user.journeyName,
    });

    // Park on the first key action — resumes the instant it fires.
    const activated = await ctx.waitForEvent({
      event: Events.PROJECT_CREATED,
      timeout: days(3),
      lookback: minutes(30),
    });

    if (!(await ctx.guard.isSubscribed())) return;

    if (!activated.timedOut) {
      // They activated — deepen instead of nudging.
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: Templates.ONBOARDING_TIPS,
        subject: "Your first project is live — three things to try next",
        journeyName: user.journeyName,
      });
      return;
    }

    // Three days, no project.
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.ONBOARDING_NUDGE,
      subject: "Your workspace is still empty",
      journeyName: user.journeyName,
    });

    // Give the nudge two days to work before the last touch.
    const second = await ctx.waitForEvent({
      event: Events.PROJECT_CREATED,
      timeout: days(2),
    });
    if (!second.timedOut) return; // the nudge worked — end quietly

    // Final send: a day later, clamped into business hours, their timezone.
    await ctx.sleepUntil(
      ctx.when.window("09:00", "17:00").in(days(1)).at("10:00"),
    );
    if (!(await ctx.guard.isSubscribed())) return;

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.ONBOARDING_RESOURCES,
      subject: "Docs, examples, and a ten-minute setup guide",
      journeyName: user.journeyName,
    });
  },
});`;

const TRIGGER_CODE = `// your app server — two events drive the whole series
await hs.events.send({
  name: "user.signed_up",
  email: user.email,
  userId: user.id,
  eventProperties: { plan: user.plan, source: signup.source },
  idempotencyKey: \`signed-up-\${user.id}\`,
});

// first key action — resolves the wait and flips the branch
await hs.events.send({
  name: "project.created",
  userId: user.id,
  eventProperties: { project_id: project.id },
  idempotencyKey: \`project-created-\${project.id}\`,
});`;

export const welcomeSeries: RecipeLander = {
  slug: "welcome-series",
  category: "onboarding",
  title: "Welcome series",
  metaDescription:
    "A welcome series in TypeScript: send on signup, park on ctx.waitForEvent until the first key action, branch on the answer, and land the final send in business hours. Durable waits, one entry per user.",
  cardDescription:
    "Greet on signup, resume the instant they activate, and nudge only the ones who don't.",
  eyebrow: "Recipe — Onboarding & activation",
  subhead:
    "One durable function holds the whole series: welcome on signup, a wait that resolves the moment the first project is created, a single nudge for the stalled, and a final send clamped into 09:00–17:00 local.",
  problem: {
    label: "The welcome-series problem",
    statement:
      "Most welcome series run on fixed delays: day 0, day 3, day 5, regardless of what the user did. The tips email arrives three days after they activated, the nudge goes to someone who built their first project an hour after the daily sweep, and the activation check is a segment query that can drift from the event stream it summarizes.",
  },
  walkthrough: {
    eyebrow: "The journey",
    title: "The branch is a wait, not a timer",
    subtitle:
      "Trigger, both waits, all four sends, and the business-hours scheduling live in a single defineJourney() — no drip schedule to keep in sync with reality.",
    note: "Both waits and the final sleep are durable Hatchet primitives — a deploy mid-week doesn't reset anyone's place in the series, and the run resumes the instant project.created is ingested.",
  },
  code: [
    {
      filename: "src/journeys/welcome-series.ts",
      code: JOURNEY_CODE,
      caption:
        "waitForEvent is the activation detector: timedOut: false is the tips path, timedOut: true is the nudge path — a plain if statement.",
    },
    {
      filename: "your app server",
      code: TRIGGER_CODE,
      caption:
        "Two idempotent events from your backend drive everything; a replayed signup can never start a second series.",
    },
  ],
  points: [
    {
      title: "The tips email lands minutes after activation",
      body: "ctx.waitForEvent resumes the run the moment project.created is ingested, instead of at the next fixed-delay tick. The lookback window covers a user who activates while the welcome email is still in flight.",
    },
    {
      title: "One welcome per user, ever",
      body: 'entryLimit: "once" is enforced by the enrollment guard before any state is created — a duplicate or replayed signup event is skipped, and the idempotencyKey on the producer side absorbs retries before they even reach the journey.',
    },
    {
      title: "The run survives deploys mid-series",
      body: "Waits and sleeps are durable Hatchet primitives. A worker restart on day 2 resumes exactly where the user was — no re-sent welcomes, no dropped nudges.",
    },
    {
      title: "Preferences and send windows are enforced in code",
      body: "ctx.guard.isSubscribed() runs before every send because unsubscribe does not exit a journey, and ctx.when clamps the final send into 09:00–17:00 in the user's resolved timezone (PostHog property, then contact, then client default, then UTC).",
    },
  ],
  faq: [
    {
      q: "What happens if the user activates while the journey is waiting?",
      a: "The wait resolves immediately with timedOut: false and the run takes the tips branch. If they activated in the gap before the wait was established, the lookback window checks recent user_events first and resolves the same way.",
    },
    {
      q: "Why ctx.waitForEvent instead of sleep three days and check history?",
      a: "Both branch correctly, but sleep-then-check delivers the tips email up to three days after activation. The wait resumes the run the moment the event arrives, so the activated path reacts in minutes, not days.",
    },
    {
      q: "Why isn't project.created in exitOn?",
      a: "It's the branch, not an exit. An exitOn match mid-wait aborts the run before the post-wait code executes, so the tips email would never send. One event name, one role.",
    },
    {
      q: "Does unsubscribing stop the series?",
      a: "Not by exiting it — the run coasts through the waits. ctx.guard.isSubscribed() before each send is what guarantees an unsubscribed user receives nothing, and the tracked mailer enforces preferences again at send time.",
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/welcome-series",
    },
    {
      label: "Journeys guide — every ctx primitive",
      href: "/docs/guides/journeys",
    },
    {
      label: "Lifecycle journeys — registering and templates",
      href: "/docs/recipes/lifecycle-journeys",
    },
  ],
  related: [
    "activation-milestones",
    "verification-chase",
    "trial-conversion-sequence",
  ],
};
