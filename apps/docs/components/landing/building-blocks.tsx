import { ArrowRight } from "lucide-react";
import { Eyebrow, TagPill } from "@/components/ds/badge";
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

/** The terse "you'd draw this on a canvas" snippet for the slow-way card. */
const CANVAS_CODE = `# welcome.flow.yaml
nodes:
  - id: trigger
    type: signup
  - id: wait
    type: delay
    days: 2
  - id: branch
    type: condition
    field: feature_used
  - id: send_nudge
    type: email
    template: nudge
edges:
  - from: trigger    to: wait
  - from: wait       to: branch
  - from: branch     to: send_nudge`;

/**
 * BuildingBlocks — the cream "what you actually write" section. It opens with a
 * Wispr-style speed comparison ("45 wpm vs 220 wpm"): a small bordered cream
 * card for the slow drag-and-drop canvas way next to a larger highlighted card
 * for the fast Hogsend · TypeScript way (a real `defineJourney` in a dark code
 * inset). It then keeps the journeys / wait / tracking / buckets showcase with
 * all of its real code samples, rendered through the restyled `TabbedShowcase`
 * (serif title + Figtree body + dark `CodeHighlight` inset). The async server
 * `CodeHighlight` nodes are rendered here and passed as `media` into the client
 * showcase (RSC composes server-rendered nodes into client islands).
 */
export async function BuildingBlocks() {
  const [journeyMedia, waitMedia, trackingMedia, bucketMedia, canvasMedia] =
    await Promise.all([
      CodeHighlight({ code: JOURNEY_CODE, lang: "ts" }),
      CodeHighlight({ code: WAIT_CODE, lang: "ts" }),
      CodeHighlight({ code: TRACKING_CODE, lang: "ts" }),
      CodeHighlight({ code: BUCKET_CODE, lang: "ts" }),
      CodeHighlight({ code: CANVAS_CODE, lang: "yaml" }),
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
        />
      </Reveal>

      {/* Speed comparison — the slow drag-and-drop way vs. the fast code way. */}
      <Reveal delay={0.1} className="mt-14 md:mt-20">
        <div className="grid grid-cols-1 items-stretch gap-6 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
          {/* The slow way: a small, muted, bordered cream card. */}
          <div className="flex flex-col rounded-3xl border-2 border-ink/10 bg-paper p-7 md:p-8">
            <Eyebrow tone="light">THE OLD WAY</Eyebrow>
            <h3 className="mt-5 font-display text-[1.75rem] leading-[1.1] tracking-tight text-ink/55 md:text-3xl">
              Drag-and-drop canvas
            </h3>
            <p className="mt-3 max-w-sm font-sans text-ink/55 text-sm leading-relaxed md:text-base">
              Wire a flowchart of nodes by hand in a builder UI, then export it
              to YAML you can't review, diff, or test.
            </p>

            <div className="mt-6 [&_pre]:opacity-70">{canvasMedia}</div>

            <div className="mt-6 flex flex-wrap gap-2">
              <TagPill tone="light">No types</TagPill>
              <TagPill tone="light">No code review</TagPill>
              <TagPill tone="light">Locked in a UI</TagPill>
            </div>
          </div>

          {/* The fast way: a larger, highlighted card in a teal panel. */}
          <div className="flex flex-col rounded-3xl bg-fathom p-7 text-lumen md:p-8">
            <Eyebrow tone="dark">HOGSEND · TYPESCRIPT</Eyebrow>
            <h3 className="mt-5 font-display text-[1.75rem] leading-[1.1] tracking-tight text-lumen md:text-[2.25rem]">
              Just write code
            </h3>
            <p className="mt-3 max-w-md font-sans text-base text-lumen/75 leading-relaxed">
              The same flow is a function you own — triggers, sleeps, and
              branches as plain TypeScript control flow. It types, diffs, and
              ships through code review like everything else.
            </p>

            <div className="mt-6">{journeyMedia}</div>

            <div className="mt-6 flex flex-wrap gap-2">
              <TagPill tone="dark">Type-safe</TagPill>
              <TagPill tone="dark">Versioned in git</TagPill>
              <TagPill success>Survives deploys</TagPill>
            </div>

            <p className="mt-6 inline-flex items-center gap-2 font-mono text-[11px] text-lumen/60 uppercase tracking-wide">
              <ArrowRight className="size-3.5 text-glow" aria-hidden="true" />
              From a flowchart you draw to a function you own
            </p>
          </div>
        </div>
      </Reveal>

      {/* The four primitives, with all their real code samples preserved. */}
      <Reveal delay={0.15} className="mt-16 md:mt-24">
        <TabbedShowcase tabs={tabs} />
      </Reveal>
    </Section>
  );
}
