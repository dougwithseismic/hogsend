import { CodeHighlight } from "@/components/ds/code-highlight";
import { AuroraBeam } from "@/components/ds/fx";
import { MockupFrame } from "@/components/ds/mockup";
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

/**
 * BuildingBlocks — dark showcase of the core primitives playing out over time:
 * Journeys (sleep & branch), waiting for what the user does next
 * (ctx.waitForEvent), first-party open/click tracking, Buckets, and outbound
 * Destinations (fan email + lifecycle events out to PostHog/Segment/Slack/any
 * signed webhook). The async server `CodeHighlight` nodes are rendered here and
 * passed as `media` props into the client `TabbedShowcase` (RSC composes
 * server-rendered nodes into client islands).
 */
export async function BuildingBlocks() {
  const [
    journeyMedia,
    waitMedia,
    trackingMedia,
    bucketMedia,
    destinationsMedia,
  ] = await Promise.all([
    CodeHighlight({ code: JOURNEY_CODE, lang: "ts" }),
    CodeHighlight({ code: WAIT_CODE, lang: "ts" }),
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
      tags: ["Trigger on events", "Sleep & branch", "Stop on conversion"],
      media: <MockupFrame barcode>{journeyMedia}</MockupFrame>,
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
            title="Journeys and buckets, working together"
            subtitle="Journeys are emails that play out over time — sleep, wait for what the user does next, and track opens and clicks as you go. Buckets are live groups of people. And every email and lifecycle event fans out to your destinations — PostHog, Segment, Slack, or any signed webhook."
          />
        </Reveal>

        <Reveal delay={0.1} className="mt-14 md:mt-20">
          <TabbedShowcase tabs={tabs} />
        </Reveal>
      </div>
    </Section>
  );
}
