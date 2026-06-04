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

const TRACKING_CODE = `run: async (user, ctx) => {
  await sendEmail({ to: user.email, template: "welcome" });
  await ctx.sleep({ duration: days(1) });
  const { sent, count } = await ctx.history.email({
    email: user.email,
    template: "welcome",
  });
  if (sent && count > 0) {
    ctx.posthog.capture({ event: "welcome_email_engaged" });
  }
}`;

/**
 * BuildingBlocks — dark showcase of the two core primitives (Journeys and
 * Buckets) plus first-party tracking. The async server `CodeHighlight` nodes
 * are rendered here and passed as `media` props into the client
 * `TabbedShowcase` (RSC composes server-rendered nodes into client islands).
 */
export async function BuildingBlocks() {
  const [journeyMedia, bucketMedia, trackingMedia] = await Promise.all([
    CodeHighlight({ code: JOURNEY_CODE, lang: "ts" }),
    CodeHighlight({ code: BUCKET_CODE, lang: "ts" }),
    CodeHighlight({ code: TRACKING_CODE, lang: "ts" }),
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
      id: "buckets",
      label: "Buckets",
      title: "Live groups of people",
      description:
        "Define who belongs with declarative criteria. Membership updates as events arrive, and joining a bucket can kick off a journey on its own.",
      tags: ["Live membership", "Time-based", "Kick off journeys"],
      media: <MockupFrame barcode>{bucketMedia}</MockupFrame>,
    },
    {
      id: "tracking",
      label: "Tracking",
      title: "Know what landed",
      description:
        "Opens and clicks are tracked per send, and engagement flows back as events. Check history mid-journey or pipe it straight into PostHog.",
      tags: ["Opens & clicks", "Per-send", "PostHog events"],
      media: <MockupFrame barcode>{trackingMedia}</MockupFrame>,
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
            subtitle="Journeys are emails that play out over time. Buckets are live groups of people. The moment someone joins a bucket, it can start a journey for them."
          />
        </Reveal>

        <Reveal delay={0.1} className="mt-14 md:mt-20">
          <TabbedShowcase tabs={tabs} />
        </Reveal>
      </div>
    </Section>
  );
}
