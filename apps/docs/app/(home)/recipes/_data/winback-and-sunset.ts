import type { RecipeLander } from "./types";

const JOURNEY_CODE = `export const winbackAndSunset = defineJourney({
  meta: {
    id: "winback-and-sunset",
    name: "Retention — win-back and sunset",
    enabled: true,
    // The trigger is a bucket join — the engine computes dormancy, you don't.
    trigger: { event: dormant30d.entered },
    entryLimit: "once_per_period",
    entryPeriod: days(180),
    suppress: hours(24),
    // Returning leaves the bucket, which exits the run — even mid-sleep.
    exitOn: [{ event: dormant30d.left }],
  },

  run: async (user, ctx) => {
    // Touch 1 — the win-back attempt.
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.RETENTION_WINBACK,
      subject: "What's changed since you've been away",
      journeyName: user.journeyName,
    });

    // A return during this week fires dormant30d.left and ends the run here.
    await ctx.sleep({ duration: days(7), label: "post-winback" });
    if (!(await ctx.guard.isSubscribed())) return;

    // Touch 2 — still silent: ask the question directly.
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.RETENTION_REPERMISSION,
      subject: "Should we keep emailing you?",
      journeyName: user.journeyName,
    });

    const answer = await ctx.waitForEvent({
      event: Events.REPERMISSION_ANSWERED,
      timeout: days(10),
      lookback: minutes(30),
    });

    if (!answer.timedOut && answer.properties?.answer === "stay") {
      return; // explicit opt-in renewed — keep them, send nothing more
    }

    // "leave", any other answer, or ten days of silence: sunset via the
    // Admin API preference write. exitOn already vetoed anyone who returned.
    const res = await fetch(
      \`\${process.env.API_PUBLIC_URL}/v1/admin/contacts/\${user.id}/preferences\`,
      {
        method: "PUT",
        headers: {
          Authorization: \`Bearer \${process.env.ADMIN_API_KEY}\`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ unsubscribedAll: true }),
      },
    );
    if (!res.ok) throw new Error(\`Sunset write failed: \${res.status}\`);
    await ctx.checkpoint("sunset-applied");
  },
});`;

const BUCKET_CODE = `// src/buckets/dormant-30d.ts
import { days, defineBucket } from "@hogsend/engine";
import { Events } from "../journeys/constants/index.js";

export const dormant30d = defineBucket({
  meta: {
    id: "dormant-30d",
    name: "Dormant 30 days",
    enabled: true,
    timeBased: true,
    criteria: (b) =>
      b.all(
        // The floor: active once, ever — keeps never-active signups out.
        b.event(Events.APP_ACTIVE).exists(),
        // The decay: nothing in the last 30 days. The reconcile cron
        // materializes the join — no event announces dormancy.
        b.event(Events.APP_ACTIVE).within(days(30)).notExists(),
      ),
  },
});`;

export const winbackAndSunset: RecipeLander = {
  slug: "winback-and-sunset",
  category: "retention",
  title: "Win-back and sunset",
  metaDescription:
    "A win-back and sunset policy in TypeScript: a dormancy bucket triggers the journey, a semantic yes/no re-permission email collects the verdict, and silence becomes a clean unsubscribe via a preference write.",
  cardDescription:
    "Try to win dormant users back, then turn sustained silence into a clean unsubscribe.",
  eyebrow: "Recipe — Retention & engagement",
  subhead:
    "A lapsed-active bucket starts the flow, exitOn ends it the instant the user returns, and a 'leave' answer — or ten days of silence — writes unsubscribedAll: true so the dead address stops costing you deliverability.",
  problem: {
    label: "The dormant-list problem",
    statement:
      "Dormant segments usually live as a saved query in an email tool: someone exports 'inactive 30 days', sends a win-back blast, and the silent addresses stay on the list forever. Mailbox providers score sender domains on engagement, so every campaign to the dead segment lowers inbox placement for the live one — and no system owns the moment when a silent address should become a clean unsubscribe instead of a recurring recipient.",
  },
  walkthrough: {
    eyebrow: "The journey",
    title: "Detection, win-back, re-permission, sunset — one file each way",
    subtitle:
      "The bucket computes dormancy from your event stream in real time; the journey it triggers handles both touches, the semantic answer, and the preference write.",
    note: "The sunset line is only reachable by someone who stayed dormant through both touches and answered 'leave' or nothing — a return at any point fires dormant30d.left, and exitOn cancels the run even between the wait resolving and the write.",
  },
  code: [
    {
      filename: "src/journeys/winback-and-sunset.ts",
      code: JOURNEY_CODE,
      caption:
        "Two touches, one semantic answer, one preference write. exitOn vetoes the sunset for anyone who came back; the timeout makes silence an answer.",
    },
    {
      filename: "src/buckets/dormant-30d.ts",
      code: BUCKET_CODE,
      caption:
        "The lapsed-active composite: the unbounded exists() leg keeps never-active signups out; the windowed leg decays as the clock advances and the reconcile cron emits the join.",
    },
  ],
  points: [
    {
      title: "Dormancy is computed, not exported",
      body: "The bucket evaluates its criteria against your own event stream and emits bucket:entered:dormant-30d the moment a once-active user crosses the 30-day window — the reconcile cron finds the join no event announces. No saved segment to refresh, no export to schedule.",
    },
    {
      title: "A returning user structurally can't be sunset",
      body: "Coming back fires app.active, which removes them from the bucket, which exits the journey via exitOn — even mid-sleep or mid-wait. The preference write sits after both gates, so the race between 'they came back' and 'we unsubscribed them' can't happen.",
    },
    {
      title: "The answer is an event, the timeout is too",
      body: "Both re-permission buttons are EmailActions sharing one event; ctx.waitForEvent returns the confirmed answer's properties, and ten days of silence resolves the same wait with timedOut: true. One code path handles 'leave' and 'never replied' identically — which is the definition of a sunset policy.",
    },
    {
      title: "The unsubscribe is a real preference write",
      body: 'PUT /v1/admin/contacts/:id/preferences sets unsubscribedAll: true, after which every tracked send returns status: "unsubscribed" instead of delivering. A failed write throws and marks the run failed in Studio — never a silent skip that leaves a dead address mailable.',
    },
  ],
  faq: [
    {
      q: "Why sunset at all instead of just mailing less often?",
      a: "Mailbox providers score sender domains on engagement. Sends to addresses that never open drag inbox placement down for subscribers who do, and long-dead addresses decay into spam traps. A sunset policy converts sustained silence into a clean preference write before it converts into a reputation problem.",
    },
    {
      q: "What happens if the user comes back mid-flow?",
      a: "Their app.active event stops the bucket criteria matching, the bucket emits dormant30d.left, and that event is in the journey's exitOn — the run is cancelled immediately, even during a sleep or wait, and the sunset write never executes.",
    },
    {
      q: "Why not make 'Remove me' a plain unsubscribe link?",
      a: "EmailAction rejects unsubscribe and preference URLs as href by design. Routing the answer through the journey means one preference write covers both the explicit 'leave' and the silent timeout, and the choice is recorded as a real repermission.answered event your destinations receive.",
    },
    {
      q: "Can the same user be sunset twice?",
      a: 'entryLimit: "once_per_period" with entryPeriod: days(180) means a contact enters this journey at most twice a year, and once unsubscribedAll is set, tracked sends to them return status: "unsubscribed" — there is nothing left to sunset.',
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/winback-and-sunset",
    },
    {
      label: "Buckets guide — the dormancy recipe",
      href: "/docs/guides/buckets",
    },
    {
      label: "Semantic links — answers as events",
      href: "/docs/guides/semantic-links",
    },
    {
      label: "Email guide — preferences and suppression",
      href: "/docs/guides/email",
    },
  ],
  related: ["nps-survey", "weekly-digest", "cancellation-save"],
};
