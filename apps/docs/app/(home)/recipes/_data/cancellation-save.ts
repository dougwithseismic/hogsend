import type { RecipeLander } from "./types";

const JOURNEY_CODE = `export const cancellationSave = defineJourney({
  meta: {
    id: "cancellation-save",
    name: "Conversion — cancellation save",
    enabled: true,
    trigger: { event: Events.SUBSCRIPTION_CANCEL_REQUESTED },
    entryLimit: "once_per_period",
    entryPeriod: days(90), // one save attempt per quarter
    suppress: hours(12),
    // The awaited answer event is deliberately NOT here — one event, one role.
    exitOn: [{ event: Events.SUBSCRIPTION_REACTIVATED }],
  },

  run: async (user, ctx) => {
    // Ask why. Three semantic links share one answer slot — first answer wins.
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.CANCEL_REASON_SURVEY,
      subject: "Before you go — one question",
      journeyName: user.journeyName,
    });

    const answer = await ctx.waitForEvent({
      event: Events.CANCEL_REASON_GIVEN,
      timeout: days(3),
      lookback: minutes(30), // covers an answer landing in the send→wait gap
      label: "await-reason",
    });
    if (answer.timedOut) return; // no answer — let the cancellation stand

    if (!(await ctx.guard.isSubscribed())) return;

    const reason = answer.properties?.reason;

    if (reason === "price") {
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: Templates.CANCEL_DISCOUNT_OFFER,
        subject: "Stay for 30% less",
        journeyName: user.journeyName,
      });
      return;
    }

    if (reason === "missing_feature") {
      // Route a human in — scalars only; the alert task resolves identity
      // server-side from the contacts row, never from event properties.
      await ctx.trigger({
        event: Events.CANCEL_SAVE_ESCALATED,
        userId: user.id,
        userEmail: user.email,
        properties: { reason: "missing_feature", source: "cancel-survey" },
      });
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: Templates.CANCEL_ROADMAP,
        subject: "What's coming — and a person to talk to",
        journeyName: user.journeyName,
      });
      return;
    }

    // "not_using" — a pause keeps the account where a refund doesn't.
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.CANCEL_PAUSE_OFFER,
      subject: "Pause instead — keep your data and your rate",
      journeyName: user.journeyName,
    });
  },
});`;

const TEMPLATE_CODE = `// src/emails/cancel/reason-survey.tsx — the answer row
import { EmailAction, HOSTED_ANSWER_HREF } from "@hogsend/email";
import { Events } from "../../journeys/constants/index.js";

<Section className="my-6 text-center">
  <EmailAction
    event={Events.CANCEL_REASON_GIVEN}
    properties={{ reason: "price" }}
    href={HOSTED_ANSWER_HREF}
  >
    It costs too much
  </EmailAction>
  <EmailAction
    event={Events.CANCEL_REASON_GIVEN}
    properties={{ reason: "missing_feature" }}
    href={HOSTED_ANSWER_HREF}
  >
    It's missing something I need
  </EmailAction>
  <EmailAction
    event={Events.CANCEL_REASON_GIVEN}
    properties={{ reason: "not_using" }}
    href={HOSTED_ANSWER_HREF}
  >
    I'm not using it enough
  </EmailAction>
</Section>`;

export const cancellationSave: RecipeLander = {
  slug: "cancellation-save",
  category: "conversion",
  title: "Cancellation save",
  metaDescription:
    "A cancellation-save journey in TypeScript: a semantic-link reason survey (price, missing feature, not using), a branch per answer, a human escalation on the feature-gap case, and exit on reactivation.",
  cardDescription:
    "Ask why with three one-tap links, branch on the answer, and stop the moment they reactivate.",
  eyebrow: "Recipe — Trial, billing & upgrades",
  subhead:
    "The survey is three EmailActions whose clicks fire cancel.reason_given with a reason property; ctx.waitForEvent resumes the journey with the payload, and a plain if picks the counter-offer — discount, roadmap plus a human, or a pause.",
  problem: {
    label: "The exit-survey problem",
    statement:
      'Most cancellation surveys are a form link in a goodbye email: single-digit response rates, answers landing in a survey tool nobody joins back to the account, and no automation acting on them. By the time someone reads "missing feature X", the subscription lapsed weeks ago — and the customer who said "too expensive" got the same generic goodbye as everyone else.',
  },
  walkthrough: {
    eyebrow: "The journey",
    title: "The click is the form submission",
    subtitle:
      "Each survey button carries an event name and a reason property; the click is recorded server-side at the redirect, confirmed past the scanner burst, and delivered to the waiting journey as a payload.",
    note: "The wait is a durable Hatchet primitive with a lookback covering the send→wait gap, and subscription.reactivated in exitOn cancels the run — even mid-wait — the moment they come back on their own.",
  },
  code: [
    {
      filename: "src/journeys/cancellation-save.ts",
      code: JOURNEY_CODE,
      caption:
        "waitForEvent returns the answer's payload, so the branch is a plain if on properties.reason — and the awaited event stays out of exitOn so the branch actually runs.",
    },
    {
      filename: "src/emails/cancel/reason-survey.tsx",
      code: TEMPLATE_CODE,
      caption:
        "Three EmailActions share one event with different reason properties. HOSTED_ANSWER_HREF lands the click on the engine-hosted answer page, whose free-text box ingests as cancel.reason_given.comment.",
    },
  ],
  points: [
    {
      title: "The click is the form submission",
      body: "No landing page, no survey tool, no JavaScript in the email. The rewriter lifts event + properties into tracked_links at send time and strips the attributes; the click is recorded server-side at the redirect and routed through the full ingest pipeline.",
    },
    {
      title: "Scanner clicks can't trigger a discount",
      body: "Answer confirmation is deferred ~30 seconds so the whole scanner burst (Outlook SafeLinks, Proofpoint) is visible before judging — and first answer per (send, event) wins, so the three buttons share one slot and conflicting clicks count once.",
    },
    {
      title: "The branch runs on the payload",
      body: "ctx.waitForEvent returns { timedOut, properties }, so reason routing is a plain if statement. The lookback covers an answer that lands in the gap between the send and the wait being established.",
    },
    {
      title: "Reactivation ends it, silence ends it, quarters cap it",
      body: 'subscription.reactivated in exitOn cancels the run mid-wait; a timed-out survey lets the cancellation stand with no further mail; entryLimit: "once_per_period" with days(90) allows one save attempt per quarter however often they waver.',
    },
  ],
  faq: [
    {
      q: "What if they click two different reasons?",
      a: 'First answer wins per (send, event name). The three buttons share one answer slot, so a "price" click followed by a "not_using" click counts once, as "price". Later clicks are recorded as raw link clicks but not re-emitted as answers.',
    },
    {
      q: "How do I get their words, not just the button?",
      a: "Point the actions at HOSTED_ANSWER_HREF. The engine-hosted answer page confirms the recorded answer and offers an optional free-text box; a submitted comment ingests as cancel.reason_given.comment — a real event with the answer's properties attached.",
    },
    {
      q: "Why isn't cancel.reason_given in exitOn?",
      a: "An exitOn match mid-wait aborts the run before the post-wait branch executes — the survey would collect answers and never act on them. The journey reacts to the event via waitForEvent; exitOn is reserved for subscription.reactivated.",
    },
    {
      q: "What does the CSM actually receive on the feature-gap branch?",
      a: "The journey fires cancel.save_escalated with scalars only via ctx.trigger. A durable Hatchet task picks it up via onEvents, resolves the customer's identity server-side from the contacts row, and emails the operator with skipPreferenceCheck — the pattern documented in the lead-alerts recipe.",
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/cancellation-save",
    },
    {
      label: "Semantic links guide — answer semantics",
      href: "/docs/guides/semantic-links",
    },
    {
      label: "Lead alerts — the operator-side task",
      href: "/docs/recipes/lead-alerts",
    },
  ],
  related: ["winback-and-sunset", "lead-alerts", "failed-payment-dunning"],
};
