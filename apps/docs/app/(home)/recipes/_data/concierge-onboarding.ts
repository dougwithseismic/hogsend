import type { RecipeLander } from "./types";

const JOURNEY_CODE = `export const conciergeOnboarding = defineJourney({
  meta: {
    id: "concierge-onboarding",
    name: "Onboarding — enterprise concierge",
    enabled: true,
    trigger: {
      event: Events.USER_SIGNED_UP,
      // self-serve plans take the automated welcome journey instead
      where: (b) => b.prop("plan").eq("enterprise"),
    },
    entryLimit: "once",
    suppress: hours(12),
    // a booked meeting means onboarding is in human hands — stop all of
    // this. The awaited csm.contacted event must NEVER appear here.
    exitOn: [{ event: Events.MEETING_BOOKED }],
  },

  run: async (user, ctx) => {
    const seats = Number(user.properties.seats ?? 0);

    // Page a human. The csm-alert task (onEvents) emails the CSM inbox.
    await ctx.trigger({
      event: Events.CSM_ASSIGNMENT_REQUESTED,
      userId: user.id,
      properties: {
        plan: "enterprise",
        seats,
        requestedAt: new Date().toISOString(),
      },
    });

    // Park until the CSM marks contact — one event from their tool or CRM.
    let contact = await ctx.waitForEvent({
      event: Events.CSM_CONTACTED,
      timeout: days(1),
      label: "await-csm",
    });

    if (contact.timedOut) {
      // A day of silence: re-page. The fresh requestedAt gives the alert
      // task a new idempotency key, so the reminder isn't deduped.
      await ctx.trigger({
        event: Events.CSM_ASSIGNMENT_REQUESTED,
        userId: user.id,
        properties: {
          plan: "enterprise",
          seats,
          requestedAt: new Date().toISOString(),
          reminder: true,
        },
      });

      contact = await ctx.waitForEvent({
        event: Events.CSM_CONTACTED,
        timeout: days(1),
        label: "await-csm-2",
        // covers a csm.contacted that landed between the two waits
        lookback: hours(1),
      });
    }

    if (!(await ctx.guard.isSubscribed())) return;

    if (contact.timedOut) {
      // Two days, no human: the customer never waits on an absent CSM.
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: Templates.ONBOARDING_ENTERPRISE_WELCOME,
        subject: "Getting your team set up",
        journeyName: user.journeyName,
      });
      return;
    }

    // The CSM's event carries who reached out — straight into the email.
    const csmName = String(
      contact.properties?.csm_name ?? "your account team",
    );

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.ONBOARDING_CONCIERGE_INTRO,
      subject: "Next steps for your rollout",
      journeyName: user.journeyName,
      props: { csmName },
    });
  },
});`;

const CSM_SIDE_CODE = `// CRM automation or internal tool — the CSM side is one event
await hs.events.send({
  name: "csm.contacted",
  userId: "user_123", // the customer's id — the wait is scoped to them
  eventProperties: { csm_name: "Sarah", channel: "email" },
});

// from your calendar tool's webhook — exits the journey at any point
await hs.events.send({
  name: "meeting.booked",
  userId: "user_123",
  eventProperties: { meeting_at: "2026-06-18T15:00:00Z" },
});`;

export const conciergeOnboarding: RecipeLander = {
  slug: "concierge-onboarding",
  category: "human-in-the-loop",
  title: "Concierge onboarding",
  metaDescription:
    "Route enterprise signups to a human with a journey: a CSM alert task on entry, a durable wait on csm.contacted, a re-page after a day of silence, an automated fallback after two, and an exit on meeting.booked.",
  cardDescription:
    "Page a CSM on enterprise signup, park until they confirm contact, and fall back so the customer never stalls.",
  eyebrow: "Recipe — Human-in-the-loop",
  subhead:
    "A trigger.where on plan admits only enterprise signups; the journey pages the CSM, parks on csm.contacted, re-pages after a day, falls back to the automated welcome after two, and exits the instant a meeting is booked.",
  problem: {
    label: "The human-handoff problem",
    statement:
      "High-touch onboarding handoffs fail quietly: the alert goes to a Slack channel nobody owns, no system notices the CSM hasn't acted, and the customer's first week is silence. The orchestration that's missing — page, escalate after a deadline, fall back to automation — is exactly the kind of stateful timing logic that's painful to bolt onto a CRM and trivial to write as durable code.",
  },
  walkthrough: {
    eyebrow: "The journey",
    title: "The escalation ladder is ordinary control flow",
    subtitle:
      "Page → wait a day → re-page → wait a day → automated fallback is two if blocks around durable waits; the CSM resolves the wait by firing one event from their CRM or tool.",
    note: "The CSM's csm.contacted event carries csm_name as a property, and the journey reads it off the wait result into the customer's intro email — the human's data flows into the automated send.",
  },
  code: [
    {
      filename: "src/journeys/concierge-onboarding.ts",
      code: JOURNEY_CODE,
      caption:
        "Two durable waits with an escalating re-page between them; a meeting.booked at any point — including mid-wait — exits the run with no further sends.",
    },
    {
      filename: "CRM automation or internal tool",
      code: CSM_SIDE_CODE,
      caption:
        "The human side is two plain events keyed to the customer's userId — no engine machinery, no journey code on the CSM's side.",
    },
  ],
  points: [
    {
      title: "The human side is one event",
      body: "The CSM confirms contact with a single hs.events.send (from a CRM automation, internal tool, or one-liner) keyed to the customer's userId. The journey is parked on ctx.waitForEvent for exactly that — no approval tables, no polling.",
    },
    {
      title: "Nobody-acted is a code path, not a gap",
      body: "A day of silence re-pages the CSM with a fresh idempotency key; a second day sends the automated enterprise welcome. The customer's worst case is standard onboarding, never an unowned handoff.",
    },
    {
      title: "Operator pages can't be gated or duplicated",
      body: "The alert task sends via the container's emailService with the transactional category and skipPreferenceCheck — the customer's subscription state never blocks operator mail — and keys idempotency on userId + requestedAt, so task retries don't double-page while deliberate re-pages still send.",
    },
    {
      title: "A booked meeting stops everything",
      body: "meeting.booked is in meta.exitOn, so the engine cancels the run the moment the calendar webhook lands — mid-wait included — and no fallback or intro email fires after the human relationship has started.",
    },
  ],
  faq: [
    {
      q: "How does the CSM mark contact without touching Hogsend?",
      a: "Most teams wire it to the CRM: logging a call or email activity fires the csm.contacted event via an automation. Failing that, it's one curl or SDK call with the customer's userId — anything that can POST /v1/events works.",
    },
    {
      q: "What if the CSM contacts the customer but the event never fires?",
      a: "The flow degrades instead of stalling: a reminder page after one day, the automated welcome after two. The fallback email is generic enough to coexist with a human reach-out, and exitOn meeting.booked still ends the run the moment a meeting lands.",
    },
    {
      q: "Why filter on plan with trigger.where instead of a separate event?",
      a: 'One user.signed_up event serves every signup flow; where: (b) => b.prop("plan").eq("enterprise") does the audience math at enrollment. Self-serve signups never create a run here — they take the automated welcome journey instead.',
    },
    {
      q: "Does the CSM alert respect the customer's unsubscribe?",
      a: "No, deliberately — the alert goes to your team via emailService.send with skipPreferenceCheck and the registry's transactional category. Customer-facing sends in the same journey still check ctx.guard.isSubscribed() after every wait.",
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/concierge-onboarding",
    },
    {
      label: "Journeys guide — waits, triggers, guards",
      href: "/docs/guides/journeys",
    },
    {
      label: "Client SDK — the CSM-side call",
      href: "/docs/data-api/client-sdk",
    },
  ],
  related: ["lead-alerts", "human-approval-gate", "welcome-series"],
};
