import type { HighlightOptions } from "fumadocs-core/highlight";

type ShikiTransformer = NonNullable<HighlightOptions["transformers"]>[number];

/* ==========================================================================
 *  Hover glossary for the scaffold explorer. Keys are exact Shiki token
 *  texts (identifiers and string contents) found in `scaffold-files.ts`;
 *  values are the one-liner shown in the hover card. The transformer marks
 *  the FIRST occurrence per file so the code stays readable; the client
 *  explorer renders the card from the same map.
 * ========================================================================== */

export const GLOSSARY: Record<string, string> = {
  /* ---- packages ---------------------------------------------------------- */
  "@hogsend/engine":
    "The framework: journeys, sends, webhooks, tracking. A versioned dependency in your app — not a fork.",
  "@hogsend/engine/journeys":
    "The environment-free authoring entry — the same journey module loads in a unit test with zero infrastructure.",
  "@hogsend/core":
    "Types, schemas, condition evaluation and duration helpers. No infrastructure attached.",
  "@hogsend/testing":
    "Deterministic journey tests: virtual time, scripted events, captured sends. No Postgres, no Docker.",
  "@hogsend/testing/vitest":
    "Optional Vitest sugar — adds the toHaveSent mailbox matchers.",
  "@hogsend/client":
    "The server SDK — secret-key access to events, contacts, groups, links and campaigns from any Node backend.",
  "@hogsend/react":
    "The browser SDK: provider, capture, flags and identity for your product's front end.",
  "@hogsend/video":
    "Watch-depth tracking — milestones fire once, monotonic, as ordinary events.",
  "@hogsend/mcp":
    "The MCP server — an agent operates the engine through the same typed API you use.",

  /* ---- journey authoring ------------------------------------------------- */
  defineJourney:
    "A journey is a TypeScript function: a trigger plus control flow. It ships as a durable task with your deploy.",
  entryLimit:
    "How often the same person can enter: once, once_per_period, or unlimited.",
  exitOn: "Events that end the journey instantly — even mid-sleep or mid-wait.",
  where:
    "A property contract on the triggering event — typed builder, evaluated before anyone enrolls. Also the guardrail on agent-produced events.",
  waitForEvent:
    "Durably parks the journey until THIS user fires the event, or the timeout passes. Returns which one happened.",
  sleep:
    "Durable sleep — a seven-day wait survives deploys, restarts and crashes.",
  sleepUntil: "Durable sleep to an absolute instant instead of a duration.",
  digest: "Opens a rolling window and folds every event in it into one send.",
  variant:
    "A deterministic A/B arm per user — recorded on first pass, replayed verbatim. No RNG.",
  hasEvent: "Queries the event log: has this already happened for this user?",
  isSubscribed:
    "Re-checks consent — worth doing after a long sleep, since unsubscribes don't exit a journey.",
  days: "Duration helper — days(3) instead of a magic string. hours() and minutes() too.",
  hours:
    "Duration helper — hours(3) instead of a magic string. days() and minutes() too.",

  /* ---- sends + channels -------------------------------------------------- */
  sendEmail:
    "Renders the React template, checks preferences, adds first-party open/click tracking, then hands HTML to your provider.",
  sendSms:
    "Plain-text SMS with consent and STOP-list checks built in — marketing sends fail closed without an opt-in.",
  sendConnectorAction:
    "One call shape for Discord, Telegram and Slack — DMs, channel messages, role grants.",

  /* ---- standing definitions ---------------------------------------------- */
  defineBucket:
    "A live, always-current segment. Entering or leaving it is an event — so it can trigger a journey.",
  defineFlag:
    "Feature flags defined in your repo — typed, reviewed, deployed with your code.",
  defineDestination:
    "Fans lifecycle events out to any signed webhook — CRM, Slack, Segment, your own endpoint.",
  defineWebhookSource:
    "Turns any inbound webhook into events that can trigger journeys — auth, Zod validation, transform.",
  stripeSource:
    "The built-in Stripe preset: signature-verified, events normalized, one line to enable.",
  createWorker:
    "Boots the worker that executes every journey as a durable task.",

  /* ---- testing ------------------------------------------------------------ */
  createJourneyTest:
    "Runs the real journey function against a virtual clock — a 60-day wait resolves in milliseconds.",
  toHaveSent:
    "Asserts against the captured mailbox — nothing was actually delivered.",
  toHaveSentTimes: "Asserts an exact captured count — including exactly zero.",

  /* ---- SDKs ---------------------------------------------------------------- */
  HogsendProvider:
    "One browser client for the whole tree. pk_ keys are anonymous-only by design; identity is server-minted.",
  useFlag:
    "Reads a flag defined in your repo — same hook shape as PostHog's, and a typo'd key won't compile.",
  capture:
    "A first-party event from the browser — any journey can trigger on it.",
  track:
    "One capture starts the lifecycle — the engine routes the event to every journey that triggers on it.",
  idempotencyKey:
    "Dedupes at the ingest layer — a retrying agent loop or webhook can fire this many times and it lands once.",
};

/** Marks the first occurrence of each glossary term in a highlighted file
 *  with `data-term`, which the explorer turns into a hover card. Create a
 *  fresh transformer per file so "first occurrence" is per-file. Shiki
 *  tokens carry their delimiters (` "@hogsend/core"`, `entryLimit: `), so
 *  the term is split into its own child span when affixes are present. */
export function glossaryTransformer(): ShikiTransformer {
  const seen = new Set<string>();
  return {
    name: "scaffold-glossary",
    span(node) {
      const child = node.children[0];
      if (node.children.length !== 1 || child?.type !== "text") return;
      const match = child.value.match(/^(\s*["']?)([^"':\s]+)(["']?:?\s*)$/);
      if (!match) return;
      const [, prefix, term, suffix] = match;
      if (!term || !GLOSSARY[term] || seen.has(term)) return;
      seen.add(term);
      if (!prefix && !suffix) {
        node.properties["data-term"] = term;
        return;
      }
      node.children = [
        ...(prefix ? [{ type: "text" as const, value: prefix }] : []),
        {
          type: "element" as const,
          tagName: "span",
          properties: { "data-term": term },
          children: [{ type: "text" as const, value: term }],
        },
        ...(suffix ? [{ type: "text" as const, value: suffix }] : []),
      ];
    },
  };
}
