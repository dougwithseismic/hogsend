import { Eyebrow } from "@/components/ds/badge";
import { CodeHighlight } from "@/components/ds/code-highlight";
import { MockupFrame } from "@/components/ds/mockup";
import { Reveal } from "@/components/ds/reveal";
import { Section } from "@/components/ds/section";
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

const ACTIONS_CODE = `// In the email: each answer is a link that MEANS something.
<EmailAction event="nps.submitted" properties={{ score }} href={thanksUrl}>
  {String(score)}
</EmailAction>

// In the journey: wait for the answer, branch on the payload.
const { timedOut, properties } = await ctx.waitForEvent({
  event: "nps.submitted",
  timeout: days(3),
});
if (!timedOut && Number(properties?.score) <= 6) {
  await ctx.trigger({ event: "nps.detractor", userId: user.id });
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

const POSTHOG_CODE = `# The scaffold already asked "Are you using PostHog?"
# → POSTHOG_API_KEY · POSTHOG_HOST · webhook secret minted
#   · outbound PostHog destination enabled

# Once deployed, one command finishes the loop:
$ hogsend connect posthog

→ browser opens · one consent click (OAuth, PKCE)
→ credential stored encrypted, server-side
→ person reads wired — timezones, property conditions
→ PostHog → Hogsend webhook provisioned (idempotent)

# Self-hosted PostHog, or no OAuth? Use a personal key
# scoped to person:read + project:read instead.`;

/**
 * BuildingBlocks — the what-it-does showcase: a split header (red kicker +
 * H2 left, supporting paragraph right) over the giant tabbed product panel
 * with seven real-code tabs: Journeys, waiting for what the user does next
 * (ctx.waitForEvent), in-email answers (semantic links), first-party
 * tracking, Buckets, outbound Destinations, and the one-command PostHog
 * connection. The async server `CodeHighlight` nodes are rendered here and
 * passed as `media` props into the client `TabbedShowcase` (RSC composes
 * server-rendered nodes into client islands).
 */
export async function BuildingBlocks() {
  const [
    journeyMedia,
    waitMedia,
    actionsMedia,
    trackingMedia,
    bucketMedia,
    destinationsMedia,
    posthogMedia,
  ] = await Promise.all([
    CodeHighlight({ code: JOURNEY_CODE, lang: "ts" }),
    CodeHighlight({ code: WAIT_CODE, lang: "ts" }),
    CodeHighlight({ code: ACTIONS_CODE, lang: "tsx" }),
    CodeHighlight({ code: TRACKING_CODE, lang: "ts" }),
    CodeHighlight({ code: BUCKET_CODE, lang: "ts" }),
    CodeHighlight({ code: DESTINATIONS_CODE, lang: "ts" }),
    CodeHighlight({ code: POSTHOG_CODE, lang: "bash" }),
  ]);

  const tabs = [
    {
      id: "journeys",
      label: "Journeys",
      title: "Emails that play out over time",
      description:
        "Trigger on an event, send, sleep, then branch on what happened while you waited. The control flow is plain TypeScript.",
      tags: ["Trigger on events", "Sleep & branch", "Stop on conversion"],
      media: <MockupFrame>{journeyMedia}</MockupFrame>,
    },
    {
      id: "wait",
      label: "Wait for event",
      title: "Wait for what they do next",
      description:
        "Pause the journey until the user acts or a timeout wins. The wait is durable, so it survives deploys, and the branch afterwards is an if statement.",
      tags: ["Durable wait", "Event or timeout", "Survives deploys"],
      media: <MockupFrame>{waitMedia}</MockupFrame>,
    },
    {
      id: "actions",
      label: "In-email answers",
      title: "Ask a question inside the email",
      description:
        "A yes/no, an NPS score, a one-tap choice — each answer is a link whose click fires a real event with its payload. The journey branches on the answer; PostHog receives it under your event name. First answer wins, and scanner click-bursts are filtered before anything is recorded.",
      tags: ["NPS & yes/no", "Answer = event", "Scanner-safe"],
      media: <MockupFrame>{actionsMedia}</MockupFrame>,
    },
    {
      id: "tracking",
      label: "Tracking",
      title: "Opens and clicks, first-party",
      description:
        "Every send is tracked first-party for opens and link clicks; engagement flows back as events (email.opened / email.link_clicked) you can branch on mid-journey or fan out to your destinations.",
      tags: ["Open tracking", "Click tracking", "Flows back as events"],
      media: <MockupFrame>{trackingMedia}</MockupFrame>,
    },
    {
      id: "buckets",
      label: "Buckets",
      title: "Live groups of people",
      description:
        "Define who belongs with declarative criteria. Membership updates as events arrive, and joining a bucket can kick off a journey on its own.",
      tags: ["Live membership", "Time-based", "Kick off journeys"],
      media: <MockupFrame>{bucketMedia}</MockupFrame>,
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
      media: <MockupFrame>{destinationsMedia}</MockupFrame>,
    },
    {
      id: "posthog",
      label: "PostHog",
      title: "Connect PostHog in one command",
      description:
        "The scaffold asks if you're using PostHog and writes the keys. Once deployed, hogsend connect posthog opens one browser consent and wires the rest — person reads for timezones and conditions, the PostHog → Hogsend webhook, and contact properties syncing back onto persons. Prefer your own keys? A scoped personal key works the same way.",
      tags: ["One command, one click", "Person reads wired", "Round-trip safe"],
      media: <MockupFrame>{posthogMedia}</MockupFrame>,
    },
  ];

  return (
    <Section id="building-blocks">
      <Reveal>
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-2 lg:gap-16">
          <div>
            <Eyebrow className="mb-4">The building blocks</Eyebrow>
            <h2 className="max-w-xl font-display text-[32px] text-white leading-[1.2] tracking-[-0.02em] md:text-[40px] md:leading-[48px]">
              Journeys and buckets, working together
            </h2>
          </div>
          <p className="max-w-xl text-base text-white/60 leading-6 lg:justify-self-end lg:self-end">
            Journeys are emails that play out over time — sleep, wait for what
            the user does next, and track opens and clicks as you go. Buckets
            are live groups of people. And every email and lifecycle event fans
            out to your destinations — PostHog, Segment, Slack, or any signed
            webhook.
          </p>
        </div>
      </Reveal>

      <Reveal delay={0.1} className="mt-14 md:mt-20">
        <TabbedShowcase tabs={tabs} />
      </Reveal>
    </Section>
  );
}
