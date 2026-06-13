import type { RecipeLander } from "./types";

const JOURNEY_CODE = `export const setupOffer = defineJourney({
  meta: {
    id: "setup-offer",
    name: "Human-in-the-loop — setup offer",
    enabled: true,
    trigger: { event: Events.TRIAL_STARTED },
    entryLimit: "once",
    suppress: hours(12),
    // Converting withdraws the pitch, even mid-wait. The awaited answer
    // event (offer.answered) must NEVER appear here.
    exitOn: [{ event: Events.SUBSCRIPTION_CREATED }],
  },

  run: async (user, ctx) => {
    await ctx.sleep({ duration: days(1), label: "pre-offer" });
    if (!(await ctx.guard.isSubscribed())) return;

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.OFFER_SETUP_CALL,
      subject: "Want a hand getting set up?",
      journeyName: user.journeyName,
    });

    // Answers are provisional clicks confirmed ~30s later; lookback covers
    // the gap between the send and this wait being established.
    const answer = await ctx.waitForEvent({
      event: Events.OFFER_ANSWERED,
      timeout: days(4),
      lookback: minutes(30),
    });

    // Gates sends to the USER — the internal flag records the value
    // instead of being gated by it.
    const subscribed = await ctx.guard.isSubscribed();

    if (answer.timedOut || answer.properties?.answer !== "interested") {
      return; // silence or "not now" — the no is respected
    }

    // Scalars only: the lead's email and name are resolved server-side by
    // the notify-lead task. Never put PII in event properties.
    await ctx.trigger({
      event: Events.LEAD_FLAGGED,
      userId: user.id,
      properties: {
        reason: "setup-offer",
        answer: "interested",
        sourceEvent: Events.OFFER_ANSWERED,
        answeredAt: new Date().toISOString(),
        subscribed,
      },
    });
  },
});`;

const TASK_CODE = `export const notifyLeadTask = hatchet.durableTask({
  name: "notify-lead",
  onEvents: [Events.LEAD_FLAGGED],
  retries: 2,
  executionTimeout: "15m",
  fn: async (input: LeadFlaggedInput, ctx) => {
    const { db, emailService } = getContainer();

    const userId = typeof input.userId === "string" ? input.userId : "";
    if (!userId) return { status: "skipped", reason: "missing_user_id" };

    const props = (input.properties ?? {}) as Record<
      string,
      string | number | boolean | null
    >;
    const reason = typeof props.reason === "string" ? props.reason : "unknown";
    const answeredAt =
      typeof props.answeredAt === "string"
        ? props.answeredAt
        : new Date().toISOString();

    // Durable grace window: the hosted answer page's free text ingests as
    // \`<sourceEvent>.comment\` seconds after the click — let it land so
    // the alert carries it inline.
    await ctx.sleepFor({ minutes: 3 });

    // Identity, server-side: the contacts row is authoritative.
    const contact = await db.query.contacts.findFirst({
      where: eq(contacts.externalId, userId),
    });
    const leadEmail = contact?.email ?? userId;

    const result = await emailService.send({
      template: Templates.TRANSACTIONAL_LEAD_ALERT,
      to: ALERT_TO,
      subject: \`[Lead] \${reason} — \${leadEmail}\`,
      props: { leadEmail, reason, answeredAt, subscribed: props.subscribed },
      // NO category override — the registry's "transactional" must win.
      // skipPreferenceCheck: the LEAD's unsubscribe must never gate
      // OPERATOR mail; their state travels in the email body instead.
      skipPreferenceCheck: true,
      // A retry after a successful send short-circuits to the prior
      // email_sends row instead of re-alerting.
      idempotencyKey: \`lead-alert:\${userId}:\${answeredAt}\`,
    });

    return { status: result.status, emailSendId: result.emailSendId };
  },
});`;

export const leadAlerts: RecipeLander = {
  slug: "lead-alerts",
  category: "human-in-the-loop",
  title: "Lead alerts",
  metaDescription:
    "Turn an in-email hand-raise into an operator alert: a semantic answer flags the lead with a scalars-only event, and a Hatchet task resolves identity server-side and emails the operator past the lead's own unsubscribe state.",
  cardDescription:
    "A confirmed hand-raise pages a human — outside the journey's exit rules and the lead's preferences.",
  eyebrow: "Recipe — Human-in-the-loop",
  subhead:
    "A journey asks the question with semantic buttons; a notify-lead task outside every journey catches the lead.flagged event, waits a grace window for the free-text comment, and sends the alert through the preference-exempt transactional path.",
  problem: {
    label: "The lost hand-raise problem",
    statement:
      "An interested reply is the highest-value event an email stream produces and the easiest to lose. If the alert lives inside the journey, the same exit rule that makes the flow polite — stop when they convert — can cancel the run the moment after the answer arrives. If it goes down the normal lifecycle send path, the lead's own unsubscribe or a category suppression silently drops the operator's mail.",
  },
  walkthrough: {
    eyebrow: "The seam",
    title: "Ask in a journey, alert in a task",
    subtitle:
      "The journey flags the answer with a scalars-only event; a Hatchet task outside every journey's exit scope turns it into operator mail.",
    note: "The flag carries no PII — the task resolves the lead's email and name from the contacts row. Event properties fan out to destinations, so identity never rides in them.",
  },
  code: [
    {
      filename: "src/journeys/setup-offer.ts",
      code: JOURNEY_CODE,
      caption:
        "The flag fires even when the lead has unsubscribed — an explicit hand-raise reaches the operator, with the subscription state recorded in the properties instead of gating the trigger.",
    },
    {
      filename: "src/workflows/notify-lead.ts",
      code: TASK_CODE,
      caption:
        "onEvents routing means the task already holds the event when it runs — an exitOn cancelling the journey a moment after the flag can't kill the alert.",
    },
  ],
  points: [
    {
      title: "The alert outlives the journey",
      body: "meta.exitOn can cancel the flagging journey's run the moment after ctx.trigger resolves — a subscription.created seconds after the hand-raise aborts everything after the trigger. The notify-lead task already holds the event; the alert sends regardless.",
    },
    {
      title: "Operator mail is never gated by the lead",
      body: "The task sends via emailService.send with skipPreferenceCheck: true and no category override, so the registry's transactional category wins. The lead's unsubscribe state is reported in the alert body instead of silently dropping it.",
    },
    {
      title: "Scalars-only flag, identity resolved server-side",
      body: "Event properties travel the ingest pipeline and fan out to destinations, so the flag carries reason and timestamps — never email or name. The task reads identity from the contacts row, which is authoritative.",
    },
    {
      title: "Retry-safe end to end",
      body: "Hatchet retries the task (retries: 2), the grace window is a durable sleep, and the idempotencyKey on the send short-circuits a post-success retry to the existing email_sends row — the operator is paged exactly once per hand-raise.",
    },
  ],
  faq: [
    {
      q: "Why not send the alert from inside the journey?",
      a: "Two reasons. An exitOn match can cancel the run immediately after the flag fires, killing any code after it. And journey-side sendEmail sends under the preference-checked journey category, so the lead's unsubscribe would silently drop operator mail. The task sidesteps both.",
    },
    {
      q: "What if the lead unsubscribed before raising their hand?",
      a: "The flag still fires — an explicit hand-raise goes to the operator, who follows up personally. The journey records the subscription state in the flag's properties, and the alert surfaces it in the body, so the operator knows not to re-enroll them in automated mail.",
    },
    {
      q: "How does the free-text comment get into the alert?",
      a: "The hosted answer page's comment ingests as offer.answered.comment seconds after the click. The task sleeps a 3-minute durable grace window, then looks the comment up in user_events. A comment that misses the window still ingests as a normal event — only its inline delivery is best-effort.",
    },
    {
      q: "Will a mail scanner's clicks page the operator?",
      a: "No. Semantic answers are confirmed only after the ~30-second burst window around the click has fully elapsed, with the whole burst visible — a scanner following every link in the email is suppressed, including its first click.",
    },
  ],
  links: [
    { label: "The full recipe in the docs", href: "/docs/recipes/lead-alerts" },
    {
      label: "Semantic links — answer semantics",
      href: "/docs/guides/semantic-links",
    },
    {
      label: "Journeys guide — ctx.trigger and waits",
      href: "/docs/guides/journeys",
    },
  ],
  related: ["human-approval-gate", "support-followup", "nps-survey"],
};
