import type { RecipeLander } from "./types";

const SOURCE_CODE = `// Hogsend's own outbound catalog — if the PostHog destination forwards
// broadly, events Hogsend fanned out would echo straight back into ingest.
const RESERVED_EVENT_PREFIXES = ["email.", "journey.", "bucket.", "contact."];

export const posthogSource = defineWebhookSource({
  meta: { id: "posthog", name: "PostHog" },
  auth: {
    type: "match",
    header: "x-posthog-webhook-secret",
    envKey: "POSTHOG_WEBHOOK_SECRET",
  },
  schema: posthogWebhookSchema, // zod for PostHog's { event, person } body
  async transform(payload) {
    const eventName = payload.event.event;
    const userId = payload.event.distinct_id;
    const rawEmail = payload.person?.properties?.email;
    const userEmail = typeof rawEmail === "string" ? rawEmail : "";

    // Echo guard: never re-ingest events Hogsend itself fanned out.
    if (payload.event.properties?.$lib === "hogsend") return null;
    if (RESERVED_EVENT_PREFIXES.some((p) => eventName.startsWith(p))) {
      return null;
    }

    // Identity guard: a person with an email, or an identified session.
    // Anonymous distinct_ids would mint a junk contact per session.
    if (!userEmail && payload.event.properties?.$is_identified !== true) {
      return null;
    }

    // Property split: behavioral data → eventProperties (trigger.where,
    // exitOn); profile data → contactProperties (contact merge). Never mixed.
    const eventProperties: Record<string, unknown> = {
      ...payload.event.properties,
    };
    if (payload.event.uuid) {
      eventProperties._posthogEventId = payload.event.uuid;
    }

    return {
      event: eventName,
      userId,
      userEmail,
      eventProperties,
      contactProperties: { ...payload.person?.properties },
    };
  },
});`;

const JOURNEY_CODE = `export const posthogSignup = defineJourney({
  meta: {
    id: "posthog-signup",
    name: "PostHog — signup welcome",
    enabled: true,
    trigger: {
      event: Events.USER_SIGNED_UP, // "user_signed_up" — PostHog's name, as-is
      // evaluates the forwarded event.properties, not the person profile
      where: (b) => b.prop("plan").eq("pro"),
    },
    entryLimit: "once",
    suppress: hours(12),
  },

  run: async (user, ctx) => {
    await sendEmail({
      to: user.email, // read from person.properties.email by the source
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.ACTIVATION_WELCOME,
      subject: "Welcome — let's get you set up",
      journeyName: user.journeyName,
    });
  },
});`;

export const posthogTriggeredJourneys: RecipeLander = {
  slug: "posthog-triggered-journeys",
  category: "pipelines",
  title: "PostHog-triggered journeys",
  metaDescription:
    "Forward PostHog events into Hogsend journeys with a defineWebhookSource(): an echo guard, a reserved-namespace guard, an identified-only guard, and a strict event/person property split.",
  cardDescription:
    "Forward identified PostHog events into journeys — with the guards that keep echoes and anonymous noise out.",
  eyebrow: "Recipe — Pipelines & orchestration",
  subhead:
    "One HTTP webhook destination in PostHog, one defineWebhookSource() in your repo: forwarded events trigger journeys through the full ingest pipeline, and four transform guards drop echoes, engine events, and anonymous sessions first.",
  problem: {
    label: "The firehose problem",
    statement:
      "Pointing an analytics firehose at an email engine fails in specific ways. Hogsend fans its own engagement events out to PostHog, so a broad forwarding rule echoes them straight back into ingest. Anonymous distinct_ids mint one junk contact per browsing session. And merging person properties into event properties makes trigger filters match on stale profile data. Each one inflates user_events or double-enrolls journeys.",
  },
  walkthrough: {
    eyebrow: "The webhook source",
    title: "Four guards between PostHog and your journeys",
    subtitle:
      "One defineWebhookSource() owns the feed: shared-secret auth, a zod schema, and a transform that drops echoes, engine events, and anonymous sessions before anything reaches the pipeline.",
    note: "Returning null accepts the delivery with a 200 — PostHog never retries a dropped event — while everything admitted feeds the same ingestEvent() pipeline the SDK uses: stored, routed to journeys, checked against exitOn, contact upserted.",
  },
  code: [
    {
      filename: "src/webhook-sources/posthog.ts",
      code: SOURCE_CODE,
      caption:
        "The production PostHog receiver: echo guard, reserved-namespace guard, identified-only guard, and the event/person property split.",
    },
    {
      filename: "src/journeys/posthog-signup.ts",
      code: JOURNEY_CODE,
      caption:
        "The payoff: a journey triggers on the PostHog event name verbatim, and trigger.where filters on the forwarded event properties.",
    },
  ],
  points: [
    {
      title: "The echo guard makes the loop safe",
      body: 'With engagement events fanning out to PostHog, a broad PostHog-side forwarding rule would send them straight back. Two independent checks — the $lib === "hogsend" marker and the reserved email./journey./bucket./contact. namespaces — hold however the PostHog destination is filtered.',
    },
    {
      title: "Anonymous noise never mints contacts",
      body: "Events are admitted only with a person email or $is_identified === true. Throwaway browser-session distinct_ids return null — a 200 to PostHog, nothing in your contact base.",
    },
    {
      title: "The property split survives the hop",
      body: "PostHog event.properties land as eventProperties (the event row, trigger.where, exitOn); person.properties land as contactProperties (the contact merge). The bags are never combined, so journey filters evaluate behavior, not stale profile data.",
    },
    {
      title: "One pipeline behind every source",
      body: "The transform's IngestEvent feeds the same ingestEvent() as the SDK and every other webhook source: stored in user_events, routed to journeys via Hatchet, evaluated against exit conditions, contact upserted — in one request.",
    },
  ],
  faq: [
    {
      q: "Should I forward every PostHog event?",
      a: "No. Add one event matcher per event your journeys care about — typically 5 to 15. Without matchers the destination fires on everything, including $pageview and $autocapture, and you pay ingest for events nothing triggers on.",
    },
    {
      q: "What stops Hogsend's own email events looping back?",
      a: 'The echo guard. Events Hogsend captures into PostHog carry $lib: "hogsend" and engine-emitted names live in reserved namespaces (email., journey., bucket., contact.) — the transform drops both before ingest, regardless of how the PostHog-side filter is configured.',
    },
    {
      q: "Why are anonymous events dropped?",
      a: "An anonymous distinct_id is a throwaway browser-session id. Ingesting it creates a junk contact per session that no journey can email and no entry limit can protect. Identify sessions (or set email as a person property at signup) and the same events pass.",
    },
    {
      q: "What secures the endpoint?",
      a: "A shared secret: PostHog sends x-posthog-webhook-secret, the source compares it to POSTHOG_WEBHOOK_SECRET. Note that match-type auth is open when the env var is unset — always set it in an internet-reachable deployment.",
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/posthog-triggered-journeys",
    },
    {
      label: "Webhook sources guide — the transform contract",
      href: "/docs/guides/webhook-sources",
    },
    {
      label: "PostHog integration — both directions of the loop",
      href: "/docs/integrations/posthog",
    },
  ],
  related: [
    "cross-journey-funnels",
    "lifecycle-alerts-in-slack",
    "agent-triggered-journeys",
  ],
};
