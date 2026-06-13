import type { RecipeLander } from "./types";

const JOURNEY_CODE = `const STEPS = [
  {
    id: "project",
    event: Events.PROJECT_CREATED,
    template: Templates.ONBOARDING_STEP_PROJECT,
    subject: "First step: create a project",
  },
  {
    id: "data",
    event: Events.DATA_CONNECTED,
    template: Templates.ONBOARDING_STEP_DATA,
    subject: "Your project is empty — connect a data source",
  },
  {
    id: "team",
    event: Events.TEAM_INVITED,
    template: Templates.ONBOARDING_STEP_TEAM,
    subject: "Working alone? Invite your team",
  },
] as const;

export const activationMilestones = defineJourney({
  meta: {
    id: "activation-milestones",
    name: "Onboarding — activation milestones",
    enabled: true,
    trigger: {
      event: Events.USER_SIGNED_UP,
      // invited teammates aren't responsible for workspace setup
      where: (b) => b.prop("role").eq("owner"),
    },
    entryLimit: "once",
    suppress: hours(24),
    exitOn: [
      { event: Events.ONBOARDING_COMPLETED },
      { event: Events.USER_DELETED },
    ],
  },

  run: async (user, ctx) => {
    for (const step of STEPS) {
      // Done out of order? Skip ahead — waits are forward-looking.
      const done = await ctx.history.hasEvent({
        userId: user.id,
        event: step.event,
      });
      if (done.found) continue;

      // Visible as currentNodeId in journey state: exactly which step.
      await ctx.checkpoint(\`milestone:\${step.id}\`);

      const reached = await ctx.waitForEvent({
        event: step.event,
        timeout: days(2),
        label: \`await-\${step.id}\`,
      });
      if (!reached.timedOut) continue; // on to the next milestone

      // Stalled on THIS step — nudge it specifically, nothing else.
      if (!(await ctx.guard.isSubscribed())) return;
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: step.template,
        subject: step.subject,
        journeyName: user.journeyName,
      });

      const nudged = await ctx.waitForEvent({
        event: step.event,
        timeout: days(3),
        label: \`await-\${step.id}-nudged\`,
        lookback: minutes(30),
      });
      if (nudged.timedOut) return; // still stalled — stop, don't pile on
    }
    // All milestones reached — the run completes. exitOn already covers
    // onboarding.completed landing mid-wait.
  },
});`;

export const activationMilestones: RecipeLander = {
  slug: "activation-milestones",
  category: "onboarding",
  title: "Activation milestones",
  metaDescription:
    "Onboarding as setup milestones in TypeScript: skip what's done with ctx.history, park on each step with ctx.waitForEvent, nudge only the stalled step, and exit the instant the workspace is fully set up.",
  cardDescription:
    "Walk setup step by step and nudge only the milestone the user is actually stuck on.",
  eyebrow: "Recipe — Onboarding & activation",
  subhead:
    "Milestones are data, orchestration is a for loop: each step gets its own wait, at most one nudge, and a checkpoint that shows operators exactly where the user is — and full activation exits the run even mid-wait.",
  problem: {
    label: "The setup-sequence problem",
    statement:
      "A drip sequence emails about step three to someone stuck on step one, and about step one to someone who finished setup yesterday. Modelling milestones in a visual builder means one branch node per step per outcome, and the 'which step are they on' state lives in a segment that refreshes on its own schedule, not on the event stream.",
  },
  walkthrough: {
    eyebrow: "The journey",
    title: "Three milestones, one loop",
    subtitle:
      "ctx.history skips completed steps, ctx.waitForEvent parks on the current one, and the timeout branch is the only thing that sends email.",
    note: "ctx.checkpoint writes currentNodeId on the journey state row, so a run reads milestone:data or await-data-nudged at a glance — which step, and whether they've been nudged — without opening the code.",
  },
  code: [
    {
      filename: "src/journeys/activation-milestones.ts",
      code: JOURNEY_CODE,
      caption:
        "Adding a fourth milestone is one array entry plus its template — the loop, the guards, and the observability come along for free.",
    },
  ],
  points: [
    {
      title: "Only the stalled step gets email",
      body: "Each milestone has its own wait; a step completed on time produces zero sends. A timeout produces exactly one nudge for that step, then one more wait — and a still-stalled run stops instead of nudging steps the user can't reach yet.",
    },
    {
      title: "Out-of-order completion is handled",
      body: "ctx.waitForEvent is forward-looking, so the journey checks ctx.history.hasEvent before each wait and skips milestones that already happened. A user who invites their team before connecting data never hangs the sequence.",
    },
    {
      title: "Full activation is an exit, not a send",
      body: "The app fires onboarding.completed when all milestones exist; because it's in exitOn, the engine marks the run exited and cancels the durable Hatchet run — a user who finishes setup mid-wait can never receive the queued nudge.",
    },
    {
      title: "The run is observable per step",
      body: "ctx.checkpoint and wait labels write currentNodeId on the journey state, so operators see milestone:project / await-data-nudged per user instead of reverse-engineering position from send logs.",
    },
  ],
  faq: [
    {
      q: "What if the user completes steps in a different order?",
      a: "The hasEvent pre-check before each wait skips any milestone that already exists in user_events, so the loop advances past it immediately. Order only determines nudge priority, not correctness.",
    },
    {
      q: "Why does the journey stop after a failed nudge instead of moving to the next step?",
      a: "Later steps usually depend on the stalled one, and a user who ignored the step-one nudge gains nothing from a step-two email. If they finish setup later on their own, onboarding.completed fires and there is nothing left to do.",
    },
    {
      q: "Why is onboarding.completed a separate event instead of exiting on the last milestone?",
      a: "Milestones complete in any order, so there is no fixed last event — and the milestone events are awaited, which rules them out of exitOn: an exit match mid-wait aborts the run before the loop advances.",
    },
    {
      q: "How do I see which step a user is stuck on?",
      a: "ctx.checkpoint and the wait labels are written to currentNodeId on the journeyStates row — a run parked at await-data-nudged is on the data step and has already been nudged once.",
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/activation-milestones",
    },
    {
      label: "Journeys guide — every ctx primitive",
      href: "/docs/guides/journeys",
    },
    {
      label: "Conditions guide — trigger.where operators",
      href: "/docs/guides/conditions",
    },
  ],
  related: ["welcome-series", "concierge-onboarding", "cross-journey-funnels"],
};
