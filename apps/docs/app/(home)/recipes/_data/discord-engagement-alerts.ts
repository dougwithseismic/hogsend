import type { RecipeLander } from "./types";

const DESTINATION_CODE = `// The one list of lifecycle moments that page a channel — Discord markdown.
function alertContent(
  type: string,
  data: Record<string, unknown>,
): string | null {
  // Semantic answers: data.event is YOUR event name, data.properties the
  // confirmed answer scalars.
  if (type === "email.action") {
    const event = String(data.event ?? "");
    const props = (data.properties ?? {}) as Record<string, unknown>;

    if (event === "demo.answered" && props.answer === "interested") {
      return \`:raising_hand: **\${data.to}** raised their hand for a demo\`;
    }
    return null; // every other answer is not an alert
  }

  if (type === "email.complained") {
    return \`:no_entry: Spam complaint from **\${data.to}** (template \\\`\${data.templateKey}\\\`)\`;
  }

  if (type === "journey.completed") {
    return \`:checkered_flag: **\${data.userEmail}** completed \\\`\${data.journeyId}\\\`\`;
  }

  return null;
}

export const discordAlerts = defineDestination({
  meta: {
    id: "discord-alerts", // == the webhook_endpoints.kind this serves
    name: "Discord alerts",
    description: "Page a channel on hand-raises, complaints, and completions.",
  },
  events: ["email.action", "email.complained", "journey.completed"],
  transform(envelope, ctx) {
    const cfg = (ctx.endpoint.config ?? {}) as { webhookUrl?: string };
    const url = cfg.webhookUrl ?? ctx.endpoint.url;
    if (!url) {
      // A throw is a non-retryable config error — straight to the DLQ.
      throw new Error("discord-alerts endpoint is missing config.webhookUrl");
    }

    const content = alertContent(envelope.type, envelope.data);
    if (!content) return null; // skip: marked delivered, no POST, no retry

    return {
      url,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Discord incoming-webhook body; 204 is success.
      body: JSON.stringify({ content, username: "Hogsend" }),
      isSuccess: (status) => status === 204 || (status >= 200 && status < 300),
    };
  },
});`;

const ENDPOINT_CODE = `// Register the transform in BOTH src/index.ts and src/worker.ts:
//   createHogsendClient({ journeys, destinations, email: { templates } })

// Then create the endpoint that routes deliveries through it. The webhook URL
// lives in per-endpoint config, never an env var.
await hs.webhooks.create({
  url: "https://discord.com/api/webhooks/123/abc",
  kind: "discord-alerts", // matches meta.id — deliveries run your transform
  eventTypes: ["email.action", "email.complained", "journey.completed"],
  config: { webhookUrl: "https://discord.com/api/webhooks/123/abc" },
});

// The shipped discordDestination (kind: "discord") posts one line per
// subscribed event with no content filtering — use it for a bounce/complaint
// firehose. This custom transform is for content rules like "only hand-raises".`;

export const discordEngagementAlerts: RecipeLander = {
  slug: "discord-engagement-alerts",
  category: "pipelines",
  title: "Discord engagement alerts in a channel",
  metaDescription:
    "Page a Discord channel on hand-raises, spam complaints, and journey completions with a filtered defineDestination() on the durable outbound spine — Discord-markdown content, an incoming-webhook body, and 204-as-success, with no per-journey Discord code.",
  cardDescription:
    "One filtered destination decides which lifecycle moments post to a Discord channel — journeys never touch Discord.",
  eyebrow: "Recipe — Pipelines & orchestration",
  subhead:
    "A defineDestination() filters the outbound envelope stream — return a Discord incoming-webhook request for the moments that matter, null for everything else — inheriting the spine's durable delivery: retries, backoff, and a dead-letter queue.",
  problem: {
    label: "The scattered-alerts problem",
    statement:
      "Per-journey Discord posting scatters the which-events-page-a-channel decision across every flow. Each journey grows an HTTP call that can fail mid-run, fire-and-forget posts vanish during a Discord outage, and changing the paging rules means finding and redeploying every journey that posts. There is no single place to read what alerts exist.",
  },
  walkthrough: {
    eyebrow: "The destination",
    title: "Alert rules in one transform",
    subtitle:
      "The engine fans every catalog event (contact.*, email.*, journey.completed, bucket.*) through the outbound spine; this transform turns the few that warrant eyes into Discord channel posts and skips the rest.",
    note: "Deliveries ride the same durable machinery as every outbound webhook: failed posts retry with backoff, a missing URL dead-letters as a config error, and a transform that returns null marks the row delivered with no POST. Discord incoming webhooks return 204, so the success classifier accepts it.",
  },
  code: [
    {
      filename: "src/destinations/discord-alerts.ts",
      code: DESTINATION_CODE,
      caption:
        "Three outcomes per envelope: a Discord webhook request (the spine POSTs it), null (skip — delivered no-op), or a throw (config error, straight to the DLQ). isSuccess accepts the 204 Discord returns.",
    },
    {
      filename: "one-off admin script",
      code: ENDPOINT_CODE,
      caption:
        'An endpoint with kind: "discord-alerts" routes deliveries through the transform; its eventTypes subscription keeps irrelevant envelopes from ever creating a delivery row.',
    },
  ],
  points: [
    {
      title: "One file decides what posts to the channel",
      body: "The alert rules — which semantic answers, which complaint events, which completions — live in a single transform. Journeys never import a Discord SDK, and changing the paging policy is one deploy of one file.",
    },
    {
      title: "Alerts ride the durable spine",
      body: "Every alert is a webhook_deliveries row with retry, exponential backoff, and a dead-letter queue. A Discord outage delays alerts instead of dropping them — the opposite of a fire-and-forget post from inside a journey.",
    },
    {
      title: "204 is a successful post",
      body: "Discord incoming webhooks return 204 No Content on success, so the transform sets isSuccess to accept 204 alongside the 2xx range. Without it the default 2xx rule would mark every successful post a failure and retry it.",
    },
    {
      title: "Filtering is a successful no-op",
      body: "Returning null marks the delivery row delivered with no POST and no retry. Combined with the endpoint's eventTypes subscription, the channel receives exactly the moments you defined and nothing else.",
    },
  ],
  faq: [
    {
      q: "Do I need this, or is the shipped Discord destination enough?",
      a: 'The shipped discordDestination (kind: "discord") posts one Discord-markdown line per subscribed event with no content filtering — fine for a bounce/complaint firehose. Content rules like "only interested hand-raises" or "only this journey" need your own defineDestination() with a transform that returns null for the rest.',
    },
    {
      q: "Why config.webhookUrl instead of an env var?",
      a: "The Discord webhook URL lives in the endpoint's config column, never an env var. That is the per-endpoint credential model: a #leads channel and a #deliverability channel are two endpoints with different URLs and eventTypes, sharing one transform.",
    },
    {
      q: "What happens when Discord is down?",
      a: "The delivery task retries with exponential backoff off the row's nextRetryAt; exhausted retries dead-letter rather than vanish. The transform runs fresh on each attempt, which is why it must stay a pure projection of the envelope plus the endpoint.",
    },
    {
      q: "Can I alert on a custom event I fire with ctx.trigger()?",
      a: "Not directly — the outbound catalog is fixed, and custom events stay on the internal pipeline. Route the moment through a catalog envelope instead: a semantic answer (email.action), a dedicated template key (email.sent), journey.completed, or a bucket transition.",
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/discord-engagement-alerts",
    },
    {
      label: "Discord integration — the outbound destination",
      href: "/docs/integrations/discord",
    },
    {
      label: "Destinations guide — the authoring contract",
      href: "/docs/guides/destinations",
    },
    {
      label: "Lifecycle alerts in Slack — the same pattern",
      href: "/docs/recipes/lifecycle-alerts-in-slack",
    },
  ],
  related: [
    "lifecycle-alerts-in-slack",
    "lead-alerts",
    "route-a-reaction-as-a-signal",
  ],
};
