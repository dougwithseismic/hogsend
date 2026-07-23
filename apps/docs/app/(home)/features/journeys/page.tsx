import type { Metadata } from "next";
import type { JSX } from "react";
import {
  CapabilityBand,
  ClosingCta,
  CrossLinks,
  FeatureGrid,
  FeatureHero,
} from "@/components/features/feature-sections";
import { RAILWAY_DEPLOY_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Journeys — code-first lifecycle automation",
  description:
    "A journey is TypeScript control flow compiled into a durable task: waits measured in days, exactly-once sends across replays, deterministic experiments and holdouts, and enrollment guards — authored in your repo, reviewed in a PR, shipped on deploy.",
  alternates: { canonical: "/features/journeys" },
  keywords: [
    "lifecycle journeys",
    "code-first journeys",
    "typescript email automation",
    "durable workflows",
    "drip campaigns in code",
    "email sequences",
    "lifecycle automation",
    "self-hosted",
  ],
};

/* Verbatim from the trial-nudge reference journey — every shape is exact. */
const HERO_JOURNEY_CODE = `import { defineJourney, sendEmail } from "@hogsend/engine";
import { days } from "@hogsend/core";
import { Events, Templates } from "./constants";

export const trialNudge = defineJourney({
  meta: {
    id: "trial-nudge",
    name: "Trial nudge",
    trigger: { event: Events.TrialStarted },
    exitOn: [{ event: Events.SubscriptionStarted }],
  },
  run: async (user, ctx) => {
    await sendEmail({ to: user.email, userId: user.id, template: Templates.TrialWelcome });
    const { timedOut } = await ctx.waitForEvent({
      event: Events.ProjectCreated, timeout: days(3), label: "first-project",
    });
    if (timedOut) {
      await sendEmail({ to: user.email, userId: user.id, template: Templates.TrialNudge });
    }
  },
});`;

const REPLAY_CODE = `// A worker crash or redeploy replays the run from the top.
// Each send derives the same deterministic key on replay:
// the Hatchet run id + the nearest wait label + the template.
await sendEmail({
  to: user.email,
  userId: user.id,
  template: Templates.TrialNudge,
});
// A duplicate provider call hits the email_sends unique
// index and is absorbed. The user gets one email.`;

const EXPERIMENT_CODE = `export const trialNudge = defineJourney({
  meta: {
    id: "trial-nudge",
    name: "Trial nudge",
    trigger: { event: Events.TrialStarted },
    // Divert 10% of would-be entrants as a control group.
    holdout: { percent: 10 },
  },
  run: async (user, ctx) => {
    // Deterministic arm: sha256 over journey + key + user.
    // No RNG — a replay re-derives the identical arm.
    const arm = await ctx.variant("welcome-copy", ["short", "detailed"]);
    await sendEmail({
      to: user.email,
      userId: user.id,
      template:
        arm === "short"
          ? Templates.WelcomeShort
          : Templates.WelcomeDetailed,
    });
  },
});`;

const GUARDRAILS_CODE = `export const onboardingNudge = defineJourney({
  meta: {
    id: "onboarding-nudge",
    name: "Onboarding nudge",
    trigger: {
      event: Events.SignedUp,
      // Only low-scoring signups enter.
      where: (b) => b.prop("score").lte(6),
    },
    entryLimit: "once",
    exitOn: [{ event: Events.Activated }],
  },
  run: async (user, ctx) => {
    await ctx.sleep({ duration: days(7), label: "week-one" });
    // Unsubscribing doesn't exit a journey — re-check after
    // long waits before sending.
    if (!(await ctx.guard.isSubscribed())) return;
    await sendEmail({
      to: user.email,
      userId: user.id,
      template: Templates.WeekOneTips,
    });
  },
});`;

export default function JourneysFeaturePage(): JSX.Element {
  return (
    <main className="flex flex-1 flex-col">
      <FeatureHero
        eyebrow="Journeys"
        title="Lifecycle automation as TypeScript control flow"
        subhead="A journey is a function: an event triggers it, waits and branches are code, and it compiles into a durable task. Written by you or your coding agent, reviewed in a PR, tested, versioned, and shipped like the rest of your product."
        primaryCta={{ label: "Start building", href: "/docs/getting-started" }}
        secondaryCta={{
          label: "Deploy on Railway",
          href: RAILWAY_DEPLOY_URL,
          external: true,
        }}
        microcopy="One file per journey · Durable waits · Exactly-once sends"
      />

      <CapabilityBand
        eyebrow="Durable execution"
        title="Waits measured in days survive deploys"
        code={{
          filename: "src/journeys/trial-nudge.ts",
          code: HERO_JOURNEY_CODE,
        }}
      >
        <p>
          <code>ctx.waitForEvent</code> parks the run until this user emits the
          event or the timeout elapses, then returns{" "}
          <code>{"{ timedOut, properties }"}</code> — branch on the answer
          directly. <code>ctx.sleep</code> and <code>ctx.sleepUntil</code> hold
          for a duration or an absolute instant. All three are durable: the
          worker can restart, redeploy, or crash mid-wait and the run resumes
          where it left off.
        </p>
        <p>
          <code>ctx.when</code> builds timezone-bound instants —{" "}
          <code>{'ctx.when.next("tuesday").at("09:00")'}</code>,{" "}
          <code>.tomorrow().at()</code>, <code>.in(days(2)).at()</code>, with{" "}
          <code>.tz()</code> and <code>.window(start, end)</code> refinements.
          The user's timezone resolves automatically: PostHog, then the contact
          record, then the client default, then UTC.
        </p>
      </CapabilityBand>

      <CapabilityBand
        eyebrow="Exactly-once delivery"
        title="A crash never sends the email twice"
        flip
        code={{
          filename: "replay-safety.ts",
          code: REPLAY_CODE,
        }}
      >
        <p>
          Durable tasks replay from the top after a crash or redeploy.{" "}
          <code>sendEmail()</code> and <code>ctx.trigger()</code> derive a
          deterministic idempotency key automatically — anchored on the
          replay-stable run id and the nearest wait label — so the replayed call
          resolves to the same key as the original.
        </p>
        <p>
          A unique index on <code>email_sends</code> absorbs the duplicate
          provider call. No authoring rule to remember in the common case;
          exactly-once is the default.
        </p>
      </CapabilityBand>

      <CapabilityBand
        eyebrow="Experiments built in"
        title="A/B arms and holdouts without an RNG"
        code={{
          filename: "src/journeys/trial-nudge.ts",
          code: EXPERIMENT_CODE,
        }}
      >
        <p>
          <code>ctx.variant(key, arms)</code> assigns a deterministic arm per
          enrollment — a sha256 bucket over the journey, key, and user, no
          random number generator — recorded once and replayed verbatim within
          that enrollment.
        </p>
        <p>
          <code>{"meta.holdout: { percent }"}</code> diverts a deterministic
          hash bucket of would-be entrants before <code>run()</code> executes.{" "}
          <code>GET /v1/admin/journeys/:id/lift</code> reports the treatment
          effect against that held-out cohort — beta-binomial, with a
          suppression floor.
        </p>
      </CapabilityBand>

      <CapabilityBand
        eyebrow="Guardrails"
        title="Guards run before your code does"
        flip
        code={{
          filename: "src/journeys/onboarding-nudge.ts",
          code: GUARDRAILS_CODE,
        }}
      >
        <p>
          Four checks precede every <code>run()</code>: the enabled flag,
          trigger conditions, the entry limit (<code>once</code>,{" "}
          <code>once_per_period</code>, or <code>unlimited</code>), and the
          recipient's email preferences. An ineligible event is skipped without
          creating state.
        </p>
        <p>
          <code>meta.exitOn</code> rules cancel a run cleanly — even mid-wait,
          so no post-wait side effects fire. For the one thing exit rules don't
          cover, <code>ctx.guard.isSubscribed()</code> re-checks consent after a
          long wait.
        </p>
      </CapabilityBand>

      <FeatureGrid
        eyebrow="Capabilities"
        title="The whole authoring surface"
        subtitle="Durable primitives on ctx, guards in meta, helpers from @hogsend/core."
        items={[
          {
            title: "defineJourney()",
            body: "One function takes { meta, run } and compiles your TypeScript control flow into a durable task. The trigger is an event.",
          },
          {
            title: "Trigger conditions",
            body: (
              <>
                Gate entry on event properties with a builder:{" "}
                <code>{'where: (b) => b.prop("score").lte(6)'}</code>.
              </>
            ),
          },
          {
            title: "Durable sleeps",
            body: (
              <>
                <code>ctx.sleep({"{ duration }"})</code> holds for a duration;{" "}
                <code>ctx.sleepUntil(at)</code> holds until an absolute instant.
                Both survive restarts.
              </>
            ),
          },
          {
            title: "ctx.waitForEvent",
            body: (
              <>
                Wait for this user's next event or a timeout — returns{" "}
                <code>{"{ timedOut, properties }"}</code>. Optional{" "}
                <code>lookback</code> checks recent history first.
              </>
            ),
          },
          {
            title: "ctx.when",
            body: (
              <>
                Timezone-bound scheduling: <code>.next(weekday).at()</code>,{" "}
                <code>.tomorrow().at()</code>, <code>.in(duration).at()</code>,{" "}
                <code>.tz()</code>, <code>.window(start, end)</code>. Timezone
                auto-resolves: PostHog → contact → client default → UTC.
              </>
            ),
          },
          {
            title: "ctx.variant",
            body: "Deterministic recorded A/B arm per enrollment — sha256, no RNG — replayed verbatim within the enrollment.",
          },
          {
            title: "Holdouts + lift",
            body: (
              <>
                <code>{"meta.holdout: { percent }"}</code> diverts a
                deterministic hash bucket; the lift report at{" "}
                <code>/v1/admin/journeys/:id/lift</code> is beta-binomial with a
                suppression floor.
              </>
            ),
          },
          {
            title: "Exactly-once sends",
            body: (
              <>
                <code>sendEmail()</code> and <code>ctx.trigger()</code>{" "}
                auto-derive idempotency keys from the run id and wait label; the{" "}
                <code>email_sends</code> unique index absorbs duplicate calls
                across replays.
              </>
            ),
          },
          {
            title: "Enrollment guards",
            body: "Enabled flag, trigger conditions, entry limit (once / once_per_period / unlimited), and email-preference check run before run(). Ineligible events skip without creating state.",
          },
          {
            title: "Exit rules",
            body: (
              <>
                <code>meta.exitOn</code> cancels a run cleanly — even mid-wait.{" "}
                <code>ctx.guard.isSubscribed()</code> re-checks consent after
                long waits.
              </>
            ),
          },
          {
            title: "History reads",
            body: (
              <>
                <code>ctx.history.hasEvent</code>, <code>.journey</code>,{" "}
                <code>.email</code>, and <code>.sms</code> answer "did this
                already happen?" — past events, journey completions, prior
                sends.
              </>
            ),
          },
          {
            title: "Digest + throttle",
            body: (
              <>
                <code>ctx.digest</code> collects a window of trigger events into
                one execution; <code>ctx.throttle</code> reports whether a
                recipient is over a send count, so the journey can branch.
              </>
            ),
          },
          {
            title: "Cross-journey triggers",
            body: (
              <>
                <code>ctx.trigger({"{ event, userId, properties }"})</code>{" "}
                pushes an event through the full ingest pipeline — one journey
                can start another.
              </>
            ),
          },
          {
            title: "Checkpoints",
            body: (
              <>
                <code>ctx.checkpoint(label)</code> records where the run is, so
                a long journey is observable mid-flight.
              </>
            ),
          },
          {
            title: "Duration helpers",
            body: (
              <>
                <code>days()</code>, <code>hours()</code>, and{" "}
                <code>minutes()</code> from <code>@hogsend/core</code> replace
                magic duration strings.
              </>
            ),
          },
        ]}
      />

      <CrossLinks
        items={[
          {
            label: "Campaigns",
            description:
              "One-shot broadcasts and waves — one template to a whole list, at an instant you pick.",
            href: "/campaigns",
          },
          {
            label: "Email templates",
            description:
              "React Email templates, rendered to HTML by the engine before any provider is called.",
            href: "/emails",
          },
          {
            label: "Growth playbook",
            description:
              "Lifecycle plays you can implement as journeys like these.",
            href: "/playbook",
          },
          {
            label: "Recipes",
            description:
              "Copyable journey code, organized by lifecycle category.",
            href: "/recipes",
          },
        ]}
      />

      <ClosingCta
        title="Write your first journey"
        subtitle="Scaffold an app with create-hogsend — journeys, templates, and the worker are files in the repo it creates."
      />
    </main>
  );
}
