import type { RecipeLander } from "./types";

const JOURNEY_CODE = `export const humanApprovalGate = defineJourney({
  meta: {
    id: "human-approval-gate",
    name: "Win-back — approval-gated discount",
    enabled: true,
    trigger: {
      event: Events.ACCOUNT_AT_RISK,
      // only high-value accounts justify a custom offer (and a human's time)
      where: (b) => b.prop("mrr").gte(500),
    },
    entryLimit: "once_per_period",
    entryPeriod: days(90),
    suppress: hours(24),
    // goal met — they reactivated on their own. NEVER list the awaited
    // approval.granted event here.
    exitOn: [{ event: Events.SUBSCRIPTION_REACTIVATED }],
  },

  run: async (user, ctx) => {
    const requestedAt = new Date().toISOString();

    // Ask a human. A real ingested event — the request-approval Hatchet
    // task picks it up (onEvents) and emails the approver.
    await ctx.trigger({
      event: Events.APPROVAL_REQUESTED,
      userId: user.id,
      properties: {
        action: "winback-discount",
        discountPct: 30,
        mrr: Number(user.properties.mrr ?? 0),
        requestedAt,
      },
    });

    // Park here until the approver fires approval.granted for THIS user —
    // or two days pass, whichever comes first.
    const approval = await ctx.waitForEvent({
      event: Events.APPROVAL_GRANTED,
      timeout: days(2),
      label: "await-approval",
    });

    if (!(await ctx.guard.isSubscribed())) return;

    if (approval.timedOut) {
      // Fail safe: silence means the standard, pre-approved offer.
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: Templates.WINBACK_STANDARD,
        subject: "Before you go — a quick look at what's new",
        journeyName: user.journeyName,
      });
      return;
    }

    // The approver's payload can adjust the terms — validate it, these are
    // best-effort scalars, not trusted input.
    const discountPct = Math.min(
      Number(approval.properties?.discountPct ?? 30),
      50,
    );

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.WINBACK_DISCOUNT_OFFER,
      subject: \`A \${discountPct}% offer to stay\`,
      journeyName: user.journeyName,
      props: { discountPct },
    });
  },
});`;

const APPROVE_CODE = `// any internal tool, script, CRM automation, or agent
await hs.events.send({
  name: "approval.granted",
  userId: "user_123", // the CUSTOMER's id — the wait is scoped to them
  eventProperties: { approvedBy: "doug@example.com", discountPct: 30 },
  idempotencyKey: \`approval-user_123-\${requestedAt}\`,
});

// or raw HTTP — anything that can POST can approve
// curl -X POST https://api.example.com/v1/events \\
//   -H "Authorization: Bearer $HOGSEND_DATA_KEY" \\
//   -H "Content-Type: application/json" \\
//   -d '{ "name": "approval.granted", "userId": "user_123",
//         "eventProperties": { "approvedBy": "doug@example.com" } }'`;

export const humanApprovalGate: RecipeLander = {
  slug: "human-approval-gate",
  category: "human-in-the-loop",
  title: "Human approval gate",
  metaDescription:
    "Pause a journey before a sensitive send until a person approves: ctx.trigger fires approval.requested, an operator task alerts a human, ctx.waitForEvent holds for approval.granted, and silence fails safe.",
  cardDescription:
    "Park the journey on a durable wait until an operator approves with one event — silence fails safe.",
  eyebrow: "Recipe — Human-in-the-loop",
  subhead:
    'The gate is ctx.waitForEvent({ event: "approval.granted", timeout: days(2) }); the approval is one hs.events.send from any tool, and a timeout sends the pre-approved fallback instead of the custom offer.',
  problem: {
    label: "The approval-workflow problem",
    statement:
      "Putting a human between an automation and a sensitive send usually means building approval infrastructure: a pending-approvals table, a UI to act on it, a poller to resume the suspended workflow, and a reaper for requests nobody answered. Each piece is state to keep consistent with the flow it gates — and the failure mode of a missed approval is either a stuck customer or an unapproved send.",
  },
  walkthrough: {
    eyebrow: "The journey",
    title: "The approval is just an event",
    subtitle:
      "No approval tables, no resume poller: the journey parks on a durable waitForEvent, an operator alert task listens on approval.requested, and anything that can POST /v1/events can approve.",
    note: "The wait is scoped to the enrolled user, so the approval event carries the CUSTOMER's userId; who approved and any adjusted terms ride along as eventProperties the journey reads from the wait result.",
  },
  code: [
    {
      filename: "src/journeys/human-approval-gate.ts",
      code: JOURNEY_CODE,
      caption:
        "ctx.trigger asks, ctx.waitForEvent parks for up to two days, and the timeout path sends the pre-approved fallback — the custom discount structurally cannot go out unapproved.",
    },
    {
      filename: "any internal tool",
      code: APPROVE_CODE,
      caption:
        "The human side is one data-plane call keyed to the customer's userId — operator metadata goes in eventProperties.",
    },
  ],
  points: [
    {
      title: "No approval machinery to build",
      body: "The request is ctx.trigger, the gate is ctx.waitForEvent, the approval is one hs.events.send. There is no pending-approvals table, no resume poller, no special engine feature — just events and a durable wait.",
    },
    {
      title: "Silence fails safe",
      body: "A two-day timeout resolves the wait with timedOut: true and the journey sends the standard pre-approved template. A busy approver or a lost alert degrades the offer, never escalates it.",
    },
    {
      title: "The operator alert can't be gated or lost",
      body: "A Hatchet task with retries sends the alert via the container's emailService: transactional category, skipPreferenceCheck (the customer's unsubscribe never blocks operator mail), and an idempotency key so a task retry can't double-alert.",
    },
    {
      title: "The wait is durable and user-scoped",
      body: "The run survives deploys and restarts while parked, and only an approval.granted ingested for the enrolled user resumes it. The approver's eventProperties (approvedBy, an adjusted discountPct) arrive on the wait result for the journey to validate and use.",
    },
  ],
  faq: [
    {
      q: "Who can approve, and from where?",
      a: "Anything holding a data-plane key: an internal admin tool, a one-line script, a CRM automation, a Studio action, or an agent. The approval is a plain POST /v1/events — there is no approver identity model in the engine; put approvedBy in eventProperties if you need the audit trail.",
    },
    {
      q: "What stops a duplicate approval from double-sending?",
      a: 'The wait resolves once — a second approval.granted is just a stored event acting on nothing. An idempotencyKey on the approval call absorbs client retries, and entryLimit: "once_per_period" caps how often the journey itself re-runs.',
    },
    {
      q: "Why isn't approval.granted in exitOn?",
      a: "An exitOn match mid-wait cancels the run before the post-wait branch executes — the journey would exit instead of sending the approved offer. The awaited event and the exit events must be different names: one event, one role.",
    },
    {
      q: "What happens if the approval arrives after the timeout?",
      a: "Nothing, by design — the run already took the fallback path, and the late event is stored but resumes nothing. If late approvals must still act, trigger a separate journey on approval.granted; it's a real ingested event, so cross-journey fan-out works.",
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/human-approval-gate",
    },
    {
      label: "Journeys guide — waitForEvent and ctx.trigger",
      href: "/docs/guides/journeys",
    },
    {
      label: "Events API — the approval call",
      href: "/docs/data-api/events",
    },
  ],
  related: ["lead-alerts", "concierge-onboarding", "support-followup"],
};
