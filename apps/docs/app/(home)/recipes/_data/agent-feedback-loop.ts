import type { RecipeLander } from "./types";

const JOURNEY_CODE = `export const exitInterview = defineJourney({
  meta: {
    id: "exit-interview",
    name: "Agentic — exit interview",
    enabled: true,
    trigger: {
      event: Events.TRIAL_COMPLETED,
      where: (b) => b.prop("converted").neq(true),
    },
    entryLimit: "once",
    suppress: hours(12),
    // Buying ends the conversation. Neither awaited event may appear here.
    exitOn: [{ event: Events.SUBSCRIPTION_CREATED }],
  },

  run: async (user, ctx) => {
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.FEEDBACK_EXIT_INTERVIEW,
      subject: "What stopped you?",
      journeyName: user.journeyName,
    });

    // The user's answer — EmailAction buttons fire churn.reason_provided.
    const answer = await ctx.waitForEvent({
      event: Events.CHURN_REASON_PROVIDED,
      timeout: days(5),
      lookback: minutes(30),
    });
    if (answer.timedOut) return; // never answered — leave them be

    // The agent's verdict. The confirmed answer is already on its way to
    // the agent as an email.action delivery; the agent fires
    // churn.followup_selected back. lookback covers a verdict that landed
    // before this wait was established — the agent can decide in seconds.
    const verdict = await ctx.waitForEvent({
      event: Events.CHURN_FOLLOWUP_SELECTED,
      timeout: hours(6),
      lookback: minutes(30),
    });

    if (!(await ctx.guard.isSubscribed())) return;

    const action = verdict.timedOut
      ? "none"
      : String(verdict.properties?.action ?? "none");

    if (action === "offer") {
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: Templates.FEEDBACK_SAVE_OFFER,
        subject: "One more month on us",
        journeyName: user.journeyName,
      });
      return;
    }

    if (action === "handoff") {
      // scalars only — the alert task resolves identity server-side
      await ctx.trigger({
        event: Events.LEAD_FLAGGED,
        userId: user.id,
        properties: {
          reason: "exit-interview",
          answer: String(answer.properties?.reason ?? "unknown"),
          sourceEvent: Events.CHURN_REASON_PROVIDED,
          answeredAt: new Date().toISOString(),
        },
      });
    }
    // "none" or timeout — the answer is recorded; nothing else sends.
  },
});`;

const ENDPOINT_CODE = `app.post(
  "/hogsend/actions",
  express.raw({ type: "application/json" }), // keep the raw bytes
  async (req, res) => {
    let event: { id: string; type: string; timestamp: string; data: unknown };
    try {
      event = verifyHogsendWebhook({
        payload: req.body.toString("utf8"),
        headers: req.headers as Record<string, string>,
        secret: process.env.HOGSEND_WEBHOOK_SECRET!,
      }) as typeof event;
    } catch {
      return res.sendStatus(401);
    }

    const data = event.data as {
      event: string;
      properties: Record<string, unknown> | null;
      userId: string | null;
    };
    if (
      event.type !== "email.action" ||
      data.event !== "churn.reason_provided" ||
      !data.userId
    ) {
      return res.sendStatus(200); // not ours — acknowledge and drop
    }

    const action = await decideFollowup(data.userId, data.properties);

    // The verdict is a plain event. Keying it on the delivery id makes the
    // at-least-once webhook stream exactly-once at the decision layer.
    await hs.events.send({
      name: "churn.followup_selected",
      userId: data.userId,
      eventProperties: { action },
      idempotencyKey: \`verdict-\${event.id}\`,
    });

    return res.sendStatus(200);
  },
);`;

export const agentFeedbackLoop: RecipeLander = {
  slug: "agent-feedback-loop",
  category: "agentic",
  title: "Agent feedback loop",
  metaDescription:
    "Confirmed semantic answers fan out to your agent through a filtered, signed webhook endpoint; the agent's verdict returns as a plain event; the journey is parked on ctx.waitForEvent with a lookback.",
  cardDescription:
    "Email answers reach your agent over a signed webhook; its verdict steers the parked journey.",
  eyebrow: "Recipe — Agents & AI",
  subhead:
    "A webhook endpoint subscribed to email.action delivers confirmed answers to your agent service; the agent fires churn.followup_selected back with one hs.events.send, and the journey branches on it like any other event.",
  problem: {
    label: "The open-loop problem",
    statement:
      "An answer recorded in analytics changes nothing unless something reads it and decides. Polling user_events from an agent adds lag and a second source of truth; an unauthenticated callback endpoint is spoofable; and at-least-once webhook delivery double-fires any decision step that isn't idempotent. Each gap is usually patched ad hoc, per integration.",
  },
  walkthrough: {
    eyebrow: "The loop",
    title: "Answer out, verdict back, journey resumes",
    subtitle:
      "The confirmed answer rides the durable outbound spine to the agent; the verdict rides the ingest pipeline back; the journey never left its durable wait.",
    note: "The journey's two waits do different jobs: days for the human's answer, hours for the agent's verdict — with a lookback on the second, because a fast agent can decide before the wait is established.",
  },
  code: [
    {
      filename: "src/journeys/exit-interview.ts",
      code: JOURNEY_CODE,
      caption:
        "Timeout on the verdict is the safe default: if the agent is down, the run ends without a send and the answer stays in user_events.",
    },
    {
      filename: "the agent service",
      code: ENDPOINT_CODE,
      caption:
        "verifyHogsendWebhook authenticates the delivery over the raw bytes; the idempotencyKey derived from event.id makes redelivered answers produce exactly one verdict.",
    },
  ],
  points: [
    {
      title: "Filtered, signed fan-out",
      body: 'The endpoint subscribes to eventTypes: ["email.action"] only — the agent receives confirmed semantic answers and nothing else. Every delivery is signed, and verifyHogsendWebhook throws on a bad signature, a missing header, or a stale timestamp.',
    },
    {
      title: "Confirmed answers only",
      body: "email.action is emitted after the ~30-second burst window with first-answer-wins per (send, event) — a corporate mail scanner's click burst never reaches the decision step, and the agent never sees a duplicate answer.",
    },
    {
      title: "Exactly-once verdicts on at-least-once delivery",
      body: "A retried delivery reuses the same Webhook-Id (event.id), so a verdict keyed idempotencyKey: verdict-<event.id> replays as { stored: false }. The journey's wait can only be woken once per answer.",
    },
    {
      title: "The journey waits durably, with a safe default",
      body: "ctx.waitForEvent parks the run across deploys and restarts; the lookback catches a verdict that landed before the wait was established, and a timeout ends the run without a send.",
    },
  ],
  faq: [
    {
      q: "What does the agent actually receive?",
      a: "The email.action envelope: the consumer event name (churn.reason_provided), its scalar properties, and the send context — emailSendId, templateKey, userId, to, at, linkId, linkUrl. Enough to decide and to attribute, with no extra lookup.",
    },
    {
      q: "What if the agent is slow or down?",
      a: "The spine retries non-2xx deliveries with exponential backoff and a dead-letter queue, so a brief outage just delays the answer. If no verdict arrives within the journey's timeout, the run takes the safe default — no send — and the answer remains in user_events.",
    },
    {
      q: "Does the agent need special credentials to reply?",
      a: "An ordinary ingest-scoped data key — the verdict is a plain hs.events.send. The full-admin key is only needed once, to register the webhook endpoint, and should not live on the agent service.",
    },
    {
      q: "Can the agent see the free-text comment from the hosted answer page?",
      a: "Not in the email.action delivery — only confirmed button answers emit it. The comment ingests separately as churn.reason_provided.comment in user_events; the lead-alerts recipe shows the grace-window lookup pattern for collecting it server-side.",
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/agent-feedback-loop",
    },
    {
      label: "Destinations — the outbound spine",
      href: "/docs/guides/destinations",
    },
    {
      label: "Semantic links — answer semantics",
      href: "/docs/guides/semantic-links",
    },
    {
      label: "Client SDK — verifying inbound webhooks",
      href: "/docs/data-api/client-sdk",
    },
  ],
  related: ["agent-triggered-journeys", "lead-alerts", "cancellation-save"],
};
