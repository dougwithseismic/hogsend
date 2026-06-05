import { CodeHighlight } from "@/components/ds/code-highlight";
import { Sunburst } from "@/components/ds/doodle";
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
    ctx.posthog.capture({ event: "welcome_email_engaged" });
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

/**
 * BuildingBlocks — the cream "what you actually write" section. The code is the
 * star here: a large `TabbedShowcase` (vertical tab rail + a tall dark code
 * window) cycling through the four primitives — journeys, waits, tracking, and
 * buckets — each with its real `defineJourney`/`defineBucket` sample. The async
 * server `CodeHighlight` nodes are rendered here and passed as `media` into the
 * client showcase (RSC composes server-rendered nodes into client islands).
 */
export async function BuildingBlocks() {
  const [journeyMedia, waitMedia, trackingMedia, bucketMedia] =
    await Promise.all([
      CodeHighlight({ code: JOURNEY_CODE, lang: "ts" }),
      CodeHighlight({ code: WAIT_CODE, lang: "ts" }),
      CodeHighlight({ code: TRACKING_CODE, lang: "ts" }),
      CodeHighlight({ code: BUCKET_CODE, lang: "ts" }),
    ]);

  const tabs = [
    {
      id: "journeys",
      label: "Journeys",
      title: "Emails that play out over time",
      description:
        "Trigger on an event, send, sleep, then branch on what happened while you waited. Plain TypeScript control flow — no YAML, no canvas.",
      tags: ["Trigger on events", "Sleep & branch", "Stop on conversion"],
      media: journeyMedia,
    },
    {
      id: "wait",
      label: "Wait for event",
      title: "Wait for what they do next",
      description:
        "React to behavior, not just elapsed time — pause the journey until the user does the thing (or a timeout wins), as a durable wait that survives restarts.",
      tags: ["Durable wait", "Event or timeout", "Survives deploys"],
      media: waitMedia,
    },
    {
      id: "tracking",
      label: "Tracking",
      title: "Opens and clicks, first-party",
      description:
        "Every send is tracked first-party for opens and link clicks; engagement flows back as events (email.opened / email.link_clicked) you can branch on mid-journey or pipe into PostHog.",
      tags: ["Open tracking", "Click tracking", "Flows back as events"],
      media: trackingMedia,
    },
    {
      id: "buckets",
      label: "Buckets",
      title: "Live groups of people",
      description:
        "Define who belongs with declarative criteria. Membership updates as events arrive, and joining a bucket can kick off a journey on its own.",
      tags: ["Live membership", "Time-based", "Kick off journeys"],
      media: bucketMedia,
    },
  ];

  return (
    <Section tone="cream">
      <Reveal>
        <SectionHeading
          tone="cream"
          align="center"
          eyebrow="THE BUILDING BLOCKS"
          title={
            <>
              Journeys and buckets,{" "}
              <span className="relative whitespace-nowrap">
                working together
                <Sunburst className="-right-7 -top-3 absolute size-7" />
              </span>
            </>
          }
          subtitle="Journeys are emails that play out over time — sleep, wait for what the user does next, and track opens and clicks as you go. Buckets are live groups of people. The moment someone joins a bucket, it can start a journey for them."
          className="mx-auto"
        />
      </Reveal>

      {/* The four primitives, with all their real code samples — the code window
          is large and a fixed height so it reads as the focus of the section. */}
      <Reveal delay={0.12} className="mt-16 md:mt-24">
        <TabbedShowcase tabs={tabs} />
      </Reveal>
    </Section>
  );
}
