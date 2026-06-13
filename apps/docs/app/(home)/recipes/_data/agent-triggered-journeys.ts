import type { RecipeLander } from "./types";

const AGENT_CODE = `// the agent's tool — any process holding an ingest-scoped key
import { Hogsend } from "@hogsend/client";

const hs = new Hogsend({
  baseUrl: process.env.HOGSEND_BASE_URL!,
  apiKey: process.env.HOGSEND_DATA_KEY!, // hsk_… key with the ingest scope
});

// identity facts → the contact record (what buckets segment on)
await hs.contacts.upsert({
  userId: lead.userId,
  email: lead.email,
  properties: { company_size: lead.companySize, industry: lead.industry },
});

// what happened → one event, scalar properties only. The idempotency key
// is derived from the run, so however many times the agent loop retries,
// the event ingests once.
await hs.events.send({
  name: "lead.research_completed",
  userId: lead.userId,
  eventProperties: { score: lead.score, tier: lead.tier },
  idempotencyKey: \`research-\${lead.userId}-\${runId}\`,
});`;

const JOURNEY_CODE = `export const highFitFollowup = defineJourney({
  meta: {
    id: "high-fit-followup",
    name: "Agent-triggered — high-fit follow-up",
    enabled: true,
    trigger: {
      event: Events.LEAD_RESEARCH_COMPLETED,
      // the contract on agent output: in-range scores only —
      // a hallucinated score of 9000 never enrolls anyone
      where: (b) => b.all(b.prop("score").gte(80), b.prop("score").lte(100)),
    },
    entryLimit: "once_per_period",
    entryPeriod: days(30),
    suppress: hours(12),
    exitOn: [{ event: Events.MEETING_CREATED }],
  },

  run: async (user, ctx) => {
    if (!(await ctx.guard.isSubscribed())) return;

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.SALES_HIGH_FIT,
      subject: "A setup plan sized for your team",
      journeyName: user.journeyName,
      props: { tier: String(user.properties.tier ?? "") },
    });

    const meeting = await ctx.waitForEvent({
      event: Events.MEETING_CREATED,
      timeout: days(7),
    });
    if (!meeting.timedOut) return; // booked — exitOn already covered it

    if (!(await ctx.guard.isSubscribed())) return;
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.SALES_HIGH_FIT_NUDGE,
      subject: "Still happy to walk you through it",
      journeyName: user.journeyName,
    });
  },
});`;

export const agentTriggeredJourneys: RecipeLander = {
  slug: "agent-triggered-journeys",
  category: "agentic",
  title: "Agent-triggered journeys",
  metaDescription:
    "Agents as data-plane producers: hs.events.send with run-derived idempotency keys, one shared event vocabulary, and trigger.where guards that keep model output out of inboxes.",
  cardDescription:
    "An agent is just another producer — same events, same journeys, with guards on its output.",
  eyebrow: "Recipe — Agents & AI",
  subhead:
    "A Claude Code skill, a cron agent, or any script fires the same hs.events.send your app server does; idempotency keys absorb retries, and the journey's trigger conditions — not the agent — decide who enrolls.",
  problem: {
    label: "The untrusted-producer problem",
    statement:
      "Agent loops retry, and a retried run replays the whole tool call — without an idempotency key the same event ingests twice and double-enrolls the user. Agents also improvise event names at the call site, splintering the vocabulary your triggers and funnels query. And model output is untrusted input: an out-of-range score wired straight to a send means a hallucination reaches an inbox.",
  },
  walkthrough: {
    eyebrow: "The flow",
    title: "Same pipeline, any producer",
    subtitle:
      "The agent writes contacts and events through the data-plane SDK; the journey enrolls on the event and applies its own guards before anything sends.",
    note: "Nothing in the journey knows the producer was an agent. The same event fired by a backfill script enrolls identically — one pipeline, one set of guards.",
  },
  code: [
    {
      filename: "the agent's tool",
      code: AGENT_CODE,
      caption:
        "The idempotency key is derived from the run id, not the clock — a retried agent loop replays the call and gets { stored: false } instead of a second enrollment.",
    },
    {
      filename: "src/journeys/high-fit-followup.ts",
      code: JOURNEY_CODE,
      caption:
        'trigger.where is the contract on agent output: it evaluates before any state is created, so an ineligible event returns { status: "skipped" } and no one is enrolled.',
    },
  ],
  points: [
    {
      title: "Idempotency at the ingest layer",
      body: "A replayed events.send carrying the same idempotencyKey within the window returns { stored: false } — nothing re-ingests, no journey re-triggers. Derive the key from stable run identity, never from a timestamp the retry would regenerate.",
    },
    {
      title: "trigger.where is the contract on model output",
      body: "The where builder evaluates against the event's properties before any journey state exists. Out-of-range scores, unknown enum values, or missing fields skip enrollment entirely — garbage output never reaches a send.",
    },
    {
      title: "entryLimit backstops legitimate re-runs",
      body: "once_per_period with entryPeriod: days(30) caps the user at one follow-up sequence per month even when the agent re-scores them weekly under fresh idempotency keys.",
    },
    {
      title: "One vocabulary, pinned in code",
      body: "Event names live in an as const Events map following context.object_action. Agents and humans share the same constants, so the funnel query never needs a translation table between producers.",
    },
  ],
  faq: [
    {
      q: "Does Hogsend have a special API for agents?",
      a: "No — agents call the same data-plane SDK as your app server: hs.events.send, hs.contacts.upsert, hs.emails.send. What exists for agents is a learning surface: vendored Claude Code skills in every scaffolded app, --json output on every CLI data command, and /llms.txt as a stable machine entrypoint.",
    },
    {
      q: "What stops a retried agent run from double-enrolling someone?",
      a: 'Two layers. The idempotencyKey makes a replayed send return { stored: false } at the ingest layer, and entryLimit: "once_per_period" caps enrollment at the journey layer even when a later run uses a new key.',
    },
    {
      q: "What if the model outputs a score of 9000?",
      a: "The journey's trigger.where requires score between 80 and 100, evaluated against the event's properties before any state is created. The event is stored but the enrollment is skipped — no run, no send.",
    },
    {
      q: "How does the agent know which events exist?",
      a: "The Events constants file is the closed vocabulary — hand it to the agent directly, or via the vendored hogsend-client-sdk skill. The agent can verify its writes landed with hogsend events <userId> --json.",
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/agent-triggered-journeys",
    },
    {
      label: "Hogsend for AI agents — skills, CLI, llms.txt",
      href: "/docs/agents",
    },
    {
      label: "Event naming — the convention",
      href: "/docs/guides/event-naming",
    },
    { label: "Client SDK — the data plane", href: "/docs/data-api/client-sdk" },
  ],
  related: [
    "ai-drafted-sends",
    "agent-feedback-loop",
    "posthog-triggered-journeys",
  ],
};
