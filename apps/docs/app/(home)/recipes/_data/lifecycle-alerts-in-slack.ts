import type { RecipeLander } from "./types";

const DESTINATION_CODE = `// The one list of lifecycle moments that page a human.
function alertText(
  type: string,
  data: Record<string, unknown>,
): string | null {
  // Semantic answers: data.event is YOUR event name, data.properties the
  // confirmed answer scalars.
  if (type === "email.action") {
    const event = String(data.event ?? "");
    const props = (data.properties ?? {}) as Record<string, unknown>;

    if (event === "setup.answered" && props.answer === "interested") {
      return \`:raising_hand: \${data.to} answered *interested* to the setup offer\`;
    }
    if (
      event === "nps.submitted" &&
      typeof props.score === "number" &&
      props.score <= 6
    ) {
      return \`:rotating_light: NPS detractor — \${data.to} scored \${props.score}\`;
    }
    return null; // every other answer is not an alert
  }

  // The dunning final notice going out is itself the alert.
  if (type === "email.sent" && data.templateKey === "billing/final-notice") {
    return \`:hourglass: Final dunning notice sent to \${data.to}\`;
  }

  if (type === "email.complained") {
    return \`:no_entry: Spam complaint from \${data.to} (template \${data.templateKey})\`;
  }

  return null;
}

export const slackAlerts = defineDestination({
  meta: {
    id: "slack-alerts", // == the webhook_endpoints.kind this serves
    name: "Slack alerts",
    description: "Page a human on hand-raises, detractors, and final notices.",
  },
  events: ["email.action", "email.sent", "email.complained"],
  transform(envelope, ctx) {
    const cfg = (ctx.endpoint.config ?? {}) as { url?: string };
    const url = cfg.url ?? ctx.endpoint.url;
    if (!url) {
      // A throw is a non-retryable config error — straight to the DLQ.
      throw new Error("slack-alerts endpoint is missing config.url");
    }

    const text = alertText(envelope.type, envelope.data);
    if (!text) return null; // skip: marked delivered, no POST, no retry

    return {
      url,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, username: "Hogsend" }),
    };
  },
});`;

const ENDPOINT_CODE = `// Register the transform in BOTH src/index.ts and src/worker.ts:
//   createHogsendClient({ journeys, destinations, email: { templates } })

// Then create the endpoint that routes deliveries through it.
// eventTypes is the coarse filter; the transform is the fine one.
await hs.webhooks.create({
  kind: "slack-alerts", // matches meta.id — deliveries run your transform
  eventTypes: ["email.action", "email.sent", "email.complained"],
  config: { url: "https://hooks.slack.com/services/T000/B000/XXXX" },
});

// Two channels = two endpoints sharing one transform: the Slack URL lives
// in per-endpoint config, never in an env var.`;

export const lifecycleAlertsInSlack: RecipeLander = {
  slug: "lifecycle-alerts-in-slack",
  category: "pipelines",
  title: "Lifecycle alerts in Slack",
  metaDescription:
    "Page a human on hand-raises, NPS detractors, and dunning final notices with a filtered defineDestination() on Hogsend's durable outbound webhook spine — no per-journey Slack code.",
  cardDescription:
    "One filtered destination decides which lifecycle moments page a human — journeys never touch Slack.",
  eyebrow: "Recipe — Pipelines & orchestration",
  subhead:
    "A defineDestination() filters the outbound envelope stream — return a Slack request for the moments that matter, null for everything else — and inherits the spine's durable delivery: retries, backoff, and a dead-letter queue.",
  problem: {
    label: "The scattered-alerts problem",
    statement:
      "Per-journey Slack code scatters the which-events-page-a-human decision across every flow. Each journey grows an HTTP call that can fail mid-run, fire-and-forget posts vanish during a Slack outage, and changing the paging rules means finding and redeploying every journey that posts. There is no single place to read what alerts exist.",
  },
  walkthrough: {
    eyebrow: "The destination",
    title: "Alert rules in one transform",
    subtitle:
      "The engine fans every catalog event (contact.*, email.*, journey.completed, bucket.*) through the outbound spine; this transform turns the few that warrant a human into Slack messages and skips the rest.",
    note: "Deliveries ride the same durable machinery as every outbound webhook: failed posts retry with backoff, a missing URL dead-letters as a config error, and a transform that returns null marks the row delivered with no POST — a filtered envelope never retries.",
  },
  code: [
    {
      filename: "src/destinations/slack-alerts.ts",
      code: DESTINATION_CODE,
      caption:
        "Three outcomes per envelope: a Slack request (the spine POSTs it), null (skip — delivered no-op), or a throw (config error, straight to the DLQ).",
    },
    {
      filename: "one-off admin script",
      code: ENDPOINT_CODE,
      caption:
        'An endpoint with kind: "slack-alerts" routes deliveries through the transform; its eventTypes subscription keeps irrelevant envelopes from ever creating a delivery row.',
    },
  ],
  points: [
    {
      title: "One file decides what pages a human",
      body: "The alert rules — which semantic answers, which template keys, which complaint events — live in a single transform. Journeys never import a Slack SDK, and changing the paging policy is one deploy of one file.",
    },
    {
      title: "Alerts ride the durable spine",
      body: "Every alert is a webhook_deliveries row with retry, exponential backoff, and a dead-letter queue. A Slack outage delays alerts instead of dropping them — the opposite of a fire-and-forget post from inside a journey.",
    },
    {
      title: "Filtering is a successful no-op",
      body: "Returning null marks the delivery row delivered with no POST and no retry. Combined with the endpoint's eventTypes subscription, the channel receives exactly the moments you defined and nothing else.",
    },
    {
      title: "Semantic answers arrive ready to grade",
      body: 'A confirmed in-email answer fans out as email.action with your event name in data.event and the answer scalars in data.properties — so "NPS score of 6 or below" or "answered interested" is one if statement, not a parsing exercise.',
    },
  ],
  faq: [
    {
      q: "Can I alert on a custom event I fire with ctx.trigger()?",
      a: "Not directly — the outbound catalog is fixed, and custom events stay on the internal pipeline. Route the moment through a catalog envelope instead: a semantic answer (email.action), a dedicated template key (email.sent), journey.completed, or a bucket transition. For alerts needing identity resolution or a grace window, use a custom Hatchet task — the lead-alerts recipe.",
    },
    {
      q: "Do I need a custom destination, or is the shipped Slack preset enough?",
      a: 'The preset (kind: "slack", enabled via ENABLED_DESTINATION_PRESETS) posts one line per subscribed event with no content filtering — fine for bounce/complaint channels. Content rules like "only detractors" or "only this template" need your own defineDestination().',
    },
    {
      q: "What happens when Slack is down?",
      a: "The delivery task retries with exponential backoff off the row's nextRetryAt; exhausted retries dead-letter rather than vanish. The transform never handles retries — it runs fresh on each attempt, which is why it must stay pure.",
    },
    {
      q: "Where does the Slack webhook URL live?",
      a: "In the endpoint's config column, never an env var. That is the deliberate per-endpoint credential model: a #leads channel and a #deliverability channel are two endpoints with different URLs and eventTypes, sharing one transform.",
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/lifecycle-alerts-in-slack",
    },
    {
      label: "Destinations guide — the authoring contract",
      href: "/docs/guides/destinations",
    },
    {
      label: "Outbound destinations — presets and endpoints",
      href: "/docs/data-api/destinations",
    },
    {
      label: "Outbound webhooks — retries, backoff, DLQ",
      href: "/docs/data-api/webhooks",
    },
  ],
  related: ["discord-engagement-alerts", "lead-alerts", "nps-survey"],
};
