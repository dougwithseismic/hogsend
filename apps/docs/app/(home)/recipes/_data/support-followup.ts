import type { RecipeLander } from "./types";

const JOURNEY_CODE = `export const supportFollowup = defineJourney({
  meta: {
    id: "support-followup",
    name: "Support — resolution follow-up",
    enabled: true,
    trigger: { event: Events.TICKET_RESOLVED },
    // a heavy support week is one follow-up, not three
    entryLimit: "once_per_period",
    entryPeriod: days(7),
    suppress: hours(12),
    // reopened through normal support channels — the question is moot.
    // The awaited support.followup_answered event must NEVER appear here.
    exitOn: [{ event: Events.TICKET_REOPENED }],
  },

  run: async (user, ctx) => {
    const ticketId = String(user.properties.ticket_id ?? "");

    // Land the question the next morning in the customer's timezone —
    // not thirty seconds after the agent hits "resolve".
    await ctx.sleepUntil(ctx.when.tomorrow().at("09:00"), {
      label: "next-morning",
    });
    if (!(await ctx.guard.isSubscribed())) return;

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.SUPPORT_FOLLOWUP,
      subject: "Did that fix it?",
      journeyName: user.journeyName,
      props: { ticketId },
    });

    // The yes/no buttons are semantic links: the click IS the answer,
    // confirmed ~30s later (scanner bursts suppressed). lookback covers
    // an answer landing between the send and this wait.
    const answer = await ctx.waitForEvent({
      event: Events.SUPPORT_FOLLOWUP_ANSWERED,
      timeout: days(4),
      label: "await-answer",
      lookback: minutes(30),
    });

    if (answer.timedOut) return; // silence — leave them be

    if (answer.properties?.answer === "no") {
      // A real event: the support-alert task pages the queue, destinations
      // receive it, and another journey could trigger on it.
      await ctx.trigger({
        event: Events.SUPPORT_REOPEN_REQUESTED,
        userId: user.id,
        properties: {
          ticket_id: ticketId,
          source: "followup-email",
          answeredAt: new Date().toISOString(),
        },
      });
    }
    // "yes" ends the run — the answer is already in user_events and at
    // every destination for CSAT reporting.
  },
});`;

const TEMPLATE_CODE = `// src/emails/support/followup.tsx — each answer is a semantic link
import { EmailAction, HOSTED_ANSWER_HREF } from "@hogsend/email";
import { Events } from "../../journeys/constants/index.js";

<Section className="my-6 text-center">
  <EmailAction
    event={Events.SUPPORT_FOLLOWUP_ANSWERED}
    properties={{ answer: "yes" }}
    href={HOSTED_ANSWER_HREF}
    className="mx-1 inline-block rounded-lg border px-5 py-2"
  >
    Yes, all sorted
  </EmailAction>
  <EmailAction
    event={Events.SUPPORT_FOLLOWUP_ANSWERED}
    properties={{ answer: "no" }}
    href={HOSTED_ANSWER_HREF}
    className="mx-1 inline-block rounded-lg border px-5 py-2"
  >
    No, still broken
  </EmailAction>
</Section>`;

export const supportFollowup: RecipeLander = {
  slug: "support-followup",
  category: "human-in-the-loop",
  title: "Support follow-up",
  metaDescription:
    "Ask 'did this fix it?' the morning after a ticket resolves: semantic-link yes/no buttons, hosted-answer free text, and a 'no' that fires a reopen event and pages the support queue.",
  cardDescription:
    "A next-morning 'did this fix it?' — yes ends quietly, no fires a reopen event and pages support.",
  eyebrow: "Recipe — Human-in-the-loop",
  subhead:
    "ticket.resolved triggers a timezone-aware next-morning ask; the click is the answer, a 'no' becomes a support.reopen_requested event plus an operator alert, and an out-of-band reopen exits the run before the question sends.",
  problem: {
    label: "The closed-ticket problem",
    statement:
      "Helpdesk CSAT surveys fire the second an agent clicks resolve — before the customer has even tried the fix — and the responses land in a dashboard nobody reconciles with the queue. A customer whose problem isn't actually fixed has to start over: find the thread, reply, wait for triage. The signal exists; it just never becomes a ticket again.",
  },
  walkthrough: {
    eyebrow: "The journey",
    title: "The click is the answer, the answer is an event",
    subtitle:
      "Two EmailAction buttons fire support.followup_answered with the answer as a property; the journey reads it straight off the durable wait and turns a 'no' into a real reopen signal.",
    note: "Confirmation is deferred ~30 seconds past the scanner-burst window, so a corporate mail gateway clicking every link records no answer — and first confirmed answer per (send, event) wins.",
  },
  code: [
    {
      filename: "src/journeys/support-followup.ts",
      code: JOURNEY_CODE,
      caption:
        "ctx.when lands the ask at 09:00 the customer's time; the wait branches on the answer payload, and exitOn ticket.reopened makes an out-of-band reopen cancel the question entirely.",
    },
    {
      filename: "src/emails/support/followup.tsx",
      code: TEMPLATE_CODE,
      caption:
        "HOSTED_ANSWER_HREF lands the click on the engine-hosted answer page — free text typed there ingests as support.followup_answered.comment, a real event.",
    },
  ],
  points: [
    {
      title: "The question lands at a human hour",
      body: 'ctx.when.tomorrow().at("09:00") resolves the customer\'s timezone (PostHog person property, then contact property, then client default) and the durable sleep holds the send until then — not thirty seconds after the agent hits resolve.',
    },
    {
      title: "Scanner clicks don't poison the answer",
      body: "Semantic-link answers are confirmed ~30 seconds after the click with the whole burst window visible, so Outlook SafeLinks following both buttons records nothing. First confirmed answer per (send, event) wins.",
    },
    {
      title: "A 'no' re-enters your queue, not a dashboard",
      body: "ctx.trigger pushes support.reopen_requested through the full ingest pipeline: a Hatchet task pages the support inbox (transactional category, skipPreferenceCheck, idempotent), destinations receive it, and any journey can trigger on it.",
    },
    {
      title: "Surveys don't pile up or fire into reopened tickets",
      body: 'entryLimit "once_per_period" with a 7-day period caps a heavy support week at one survey, and exitOn ticket.reopened cancels the run mid-sleep if the customer reopens through normal channels first.',
    },
  ],
  faq: [
    {
      q: "What if the ticket reopens before the email goes out?",
      a: "ticket.reopened is in meta.exitOn, so the run is cancelled during the overnight sleep and the question never sends. Exit conditions are evaluated by the ingestion pipeline on every incoming event, mid-wait included.",
    },
    {
      q: "Where does the customer's free text go?",
      a: "The hosted answer page offers an optional comment box after the click; a submission ingests as support.followup_answered.comment with the original answer's properties attached. The lead-alerts recipe shows the operator-task pattern that waits a short grace window and folds the comment into the alert email.",
    },
    {
      q: "Why isn't support.followup_answered in exitOn?",
      a: "An exit match mid-wait aborts the run before the post-wait branch executes — the 'no' answer would cancel the journey instead of firing the reopen request. The awaited event and the exit events must be different names: one event, one role.",
    },
    {
      q: "Can I segment contacts on the CSAT outcome?",
      a: 'The answer is an event in user_events, which buckets don\'t read directly. Persist the outcome as a contact property — hs.contacts.upsert({ userId, properties: { last_csat: "positive" } }) from your support tooling or wherever you consume the answer stream — and buckets can segment on it.',
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/support-followup",
    },
    {
      label: "Semantic links guide — answers as events",
      href: "/docs/guides/semantic-links",
    },
    {
      label: "Journeys guide — ctx.when and waitForEvent",
      href: "/docs/guides/journeys",
    },
  ],
  related: ["lead-alerts", "review-request", "nps-survey"],
};
