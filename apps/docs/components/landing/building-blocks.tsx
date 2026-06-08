import { Eyebrow } from "@/components/ds/badge";
import { CodeHighlight } from "@/components/ds/code-highlight";
import { AuroraBeam } from "@/components/ds/fx";
import { CodeMock, MockupFrame } from "@/components/ds/mockup";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { TabbedShowcase } from "@/components/ds/tabs";

const JOURNEY_CODE = `export const welcome = defineJourney({
  meta: {
    id: "activation-welcome",
    trigger: { event: "user_signed_up" },
    entryLimit: "once",
  },
  run: async (user, ctx) => {
    await sendEmail({ to: user.email, template: "welcome" });
    await ctx.sleep({ duration: days(2) });
    const { found } = await ctx.history.hasEvent({
      userId: user.id,
      event: "feature_used",
    });
    if (!found) {
      await sendEmail({ to: user.email, template: "nudge" });
    }
  },
});`;

const EXIT_CODE = `export const trialNudge = defineJourney({
  meta: {
    id: "trial-nudge",
    trigger: { event: "trial_started" },
    // The moment they convert, the journey exits.
    exitOn: [{ event: "subscription_created" }],
  },
  run: async (user, ctx) => {
    await ctx.sleep({ duration: days(3) });
    await sendEmail({ to: user.email, template: "trial-nudge" });
    // …a user who upgrades on day 1 never sees this.
  },
});`;

const WAIT_CODE = `run: async (user, ctx) => {
  await sendEmail({ to: user.email, template: "welcome" });
  // Wait up to 7 days for them to activate — durable, survives deploys.
  const { timedOut } = await ctx.waitForEvent({
    event: "feature_used",
    timeout: days(7),
  });
  if (timedOut) {
    await sendEmail({ to: user.email, template: "nudge" });
  }
}`;

const TIMEZONE_CODE = `run: async (user, ctx) => {
  // 9am in *their* timezone — auto-resolved from PostHog — and
  // inside your send window. A 9am email never lands at 3am.
  await ctx.sleepUntil(ctx.when.nextLocal("09:00"), {
    label: "morning-send",
  });
  await sendEmail({ to: user.email, template: "daily-digest" });
}`;

const CROSS_CODE = `run: async (user, ctx) => {
  await sendEmail({ to: user.email, template: "winback" });
  await ctx.sleep({ duration: days(2) });
  // Hand off to another journey by firing an event — it runs the
  // full pipeline: enrolls downstream journeys, updates buckets,
  // fans out to your destinations.
  await ctx.trigger({ event: "winback_completed", userId: user.id });
}`;

const TRACKING_CODE = `run: async (user, ctx) => {
  await sendEmail({ to: user.email, template: "welcome" });
  await ctx.sleep({ duration: days(1) });
  const { sent, count } = await ctx.history.email({
    email: user.email,
    template: "welcome",
  });
  if (sent && count > 0) {
    // Fire a signal that fans out to your destinations.
    await ctx.trigger({ event: "welcome_email_engaged", userId: user.id });
  }
}`;

const BUCKET_CODE = `export const wentDormant = defineBucket({
  meta: {
    id: "went-dormant",
    enabled: true,
    timeBased: true,
    criteria: (b) =>
      b.all(
        b.event("app.active").exists(),
        b.event("app.active").within(days(7)).notExists(),
      ),
  },
});`;

const DESTINATIONS_CODE = `// Fan email + lifecycle events out to PostHog,
// Segment, Slack, or any signed webhook.
await hs.webhooks.create({
  kind: "slack",
  url: "https://hooks.slack.com/services/…",
  eventTypes: ["email.bounced", "email.complained"],
});

// Or define your own destination in code:
export const crm = defineDestination({
  meta: { id: "crm", name: "CRM" },
  events: ["contact.created", "contact.updated"],
  transform: (envelope, { endpoint }) => ({
    url: endpoint.url,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  }),
});`;

// The agentic payoff: a journey is a file, so an agent writes it.
const AGENT_LINES = [
  { text: '// prompt: "nudge trials that stall on day 3,', tone: "comment" },
  { text: '//          stop the moment they upgrade"', tone: "comment" },
  { text: "", tone: "plain" },
  { text: "export const trialNudge = defineJourney({", tone: "keyword" },
  { text: "  meta: {", tone: "plain" },
  { text: '    trigger: { event: "trial_started" },', tone: "string" },
  { text: '    exitOn: [{ event: "subscription_created" }],', tone: "string" },
  { text: "  },", tone: "plain" },
  { text: "  run: async (user, ctx) => {", tone: "keyword" },
  { text: "    await ctx.sleep({ duration: days(3) });", tone: "plain" },
  { text: "    await sendEmail({ to: user.email,", tone: "plain" },
  { text: '      template: "trial-nudge" });', tone: "plain" },
  { text: "  },", tone: "plain" },
  { text: "});", tone: "keyword" },
] as const;

/**
 * BuildingBlocks — dark showcase of the core primitives playing out over time:
 * Journeys (sleep & branch), stop-on-conversion (exitOn), waiting for what the
 * user does next (ctx.waitForEvent), right-time sends in the user's timezone
 * (ctx.when), cross-journey handoff (ctx.trigger), first-party open/click
 * tracking, Buckets, and outbound Destinations. Closes on the agentic payoff —
 * journeys are code, so an agent can author them. The async server
 * `CodeHighlight` nodes are rendered here and passed as `media` props into the
 * client `TabbedShowcase` (RSC composes server-rendered nodes into client
 * islands).
 */
export async function BuildingBlocks() {
  const [
    journeyMedia,
    exitMedia,
    waitMedia,
    timezoneMedia,
    crossMedia,
    trackingMedia,
    bucketMedia,
    destinationsMedia,
  ] = await Promise.all([
    CodeHighlight({ code: JOURNEY_CODE, lang: "ts" }),
    CodeHighlight({ code: EXIT_CODE, lang: "ts" }),
    CodeHighlight({ code: WAIT_CODE, lang: "ts" }),
    CodeHighlight({ code: TIMEZONE_CODE, lang: "ts" }),
    CodeHighlight({ code: CROSS_CODE, lang: "ts" }),
    CodeHighlight({ code: TRACKING_CODE, lang: "ts" }),
    CodeHighlight({ code: BUCKET_CODE, lang: "ts" }),
    CodeHighlight({ code: DESTINATIONS_CODE, lang: "ts" }),
  ]);

  const tabs = [
    {
      id: "journeys",
      label: "Journeys",
      title: "Emails that play out over time",
      description:
        "Trigger on an event, send, sleep, then branch on what happened while you waited. Plain TypeScript control flow — no YAML, no canvas.",
      tags: ["Trigger on events", "Sleep & branch", "Plain TypeScript"],
      media: <MockupFrame barcode>{journeyMedia}</MockupFrame>,
    },
    {
      id: "exit",
      label: "Stop on conversion",
      title: "Stop the instant they convert",
      description:
        "An exitOn rule pulls a user out of the journey the moment they do the thing — subscribe, activate, pay. Nobody who already converted gets the next nudge, and there's no manual cleanup.",
      tags: ["exitOn rule", "Stops mid-flow", "No wasted sends"],
      media: <MockupFrame barcode>{exitMedia}</MockupFrame>,
    },
    {
      id: "wait",
      label: "Wait for event",
      title: "Wait for what they do next",
      description:
        "React to behavior, not just elapsed time — pause the journey until the user does the thing (or a timeout wins), as a durable wait that survives restarts.",
      tags: ["Durable wait", "Event or timeout", "Survives deploys"],
      media: <MockupFrame barcode>{waitMedia}</MockupFrame>,
    },
    {
      id: "timezone",
      label: "Right-time sends",
      title: "The right time of day, their time",
      description:
        "ctx.when builds a send time in the user's own timezone — auto-resolved from PostHog — and inside the send window you set. A 9am email lands at 9am for them, never 3am. ctx.sleepUntil makes the wait durable.",
      tags: ["Their timezone", "Send windows", "Durable until"],
      media: <MockupFrame barcode>{timezoneMedia}</MockupFrame>,
    },
    {
      id: "cross",
      label: "Cross-journey",
      title: "One journey hands off to the next",
      description:
        "Fire an event from inside a journey with ctx.trigger and it runs the full ingest pipeline — enrolling the user in downstream journeys, updating buckets, fanning out to destinations. Flows compose instead of sprawling.",
      tags: ["ctx.trigger", "One flow → next", "Full pipeline"],
      media: <MockupFrame barcode>{crossMedia}</MockupFrame>,
    },
    {
      id: "tracking",
      label: "Tracking",
      title: "Opens and clicks, first-party",
      description:
        "Every send is tracked first-party for opens and link clicks; engagement flows back as events (email.opened / email.link_clicked) you can branch on mid-journey or fan out to your destinations.",
      tags: ["Open tracking", "Click tracking", "Flows back as events"],
      media: <MockupFrame barcode>{trackingMedia}</MockupFrame>,
    },
    {
      id: "buckets",
      label: "Buckets",
      title: "Live groups of people",
      description:
        "Define who belongs with declarative criteria. Membership updates as events arrive, and joining a bucket can kick off a journey on its own.",
      tags: ["Live membership", "Time-based", "Kick off journeys"],
      media: <MockupFrame barcode>{bucketMedia}</MockupFrame>,
    },
    {
      id: "destinations",
      label: "Destinations",
      title: "Fan events out, durably",
      description:
        "Send email and lifecycle events (delivered, opened, clicked, bounced…) out to PostHog, Segment, Slack, or any signed webhook. Each delivery is retried, signed, and dead-lettered for you — and you can define your own destination in code.",
      tags: [
        "PostHog · Segment · Slack",
        "Signed & retried",
        "Define your own",
      ],
      media: <MockupFrame barcode>{destinationsMedia}</MockupFrame>,
    },
  ];

  return (
    <Section tone="dark">
      <AuroraBeam className="absolute inset-0 -z-0" />

      <div className="relative z-10">
        <Reveal>
          <SectionHeading
            tone="dark"
            eyebrow="THE BUILDING BLOCKS"
            title="A handful of primitives, combined"
            subtitle="Journeys send and wait and branch; they stop the moment a user converts and hand off to each other. Buckets are live groups of people. Sends are tracked first-party, and every signal fans out to your tools."
          />
        </Reveal>

        <Reveal delay={0.1} className="mt-14 md:mt-20">
          <TabbedShowcase tabs={tabs} />
        </Reveal>

        {/* The agentic payoff — a journey is a file, so an agent can write it. */}
        <Reveal delay={0.1}>
          <div className="mt-16 grid grid-cols-1 items-center gap-10 border-white/[0.08] border-t pt-14 md:mt-20 md:pt-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-14">
            <div>
              <Eyebrow tone="dark" className="mb-5">
                AGENTIC-READY
              </Eyebrow>
              <h3 className="max-w-xl font-display text-2xl leading-[1.12] text-white md:text-4xl">
                Journeys are code, so your agent can write them
              </h3>
              <p className="mt-5 max-w-xl text-base text-white/60 md:text-lg">
                A journey is a TypeScript file, not a node on someone's canvas.
                Describe the flow in plain English and your coding agent —
                Claude, Cursor, Copilot — writes the{" "}
                <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[0.85em] text-white/80">
                  defineJourney()
                </code>{" "}
                for you. You review the diff like any other pull request. Hand
                lifecycle email to an agent and actually mean it.
              </p>
            </div>

            <CodeMock
              filename="journeys/trial-nudge.ts"
              lines={[...AGENT_LINES]}
            />
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
