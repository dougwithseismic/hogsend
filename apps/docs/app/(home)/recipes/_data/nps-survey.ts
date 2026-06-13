import type { RecipeLander } from "./types";

const JOURNEY_CODE = `export const npsSurvey = defineJourney({
  meta: {
    id: "nps-survey",
    name: "Feedback — NPS survey",
    enabled: true,
    // Any product activity makes them eligible; the entry limit does the
    // cadence — at most one survey per user per 90 days.
    trigger: { event: Events.APP_ACTIVE },
    entryLimit: "once_per_period",
    entryPeriod: days(90),
    suppress: hours(24),
    // No exitOn — and the awaited answer (nps.submitted) must NEVER be one.
  },

  run: async (user, ctx) => {
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.FEEDBACK_NPS_SURVEY,
      subject: "How likely are you to recommend us?",
      journeyName: user.journeyName,
    });

    // Answers are provisional clicks confirmed ~30s after the scanner-burst
    // window — timeouts are days, never minutes.
    const answer = await ctx.waitForEvent({
      event: Events.NPS_SUBMITTED,
      timeout: days(7),
      lookback: minutes(30),
    });
    if (answer.timedOut) return; // silence — next window is in 90 days

    const band = answer.properties?.band;

    if (band === "detractor") {
      // Scalars only — the alert task resolves email/name server-side.
      await ctx.trigger({
        event: Events.NPS_DETRACTOR_FLAGGED,
        userId: user.id,
        properties: {
          band: "detractor",
          sourceEvent: Events.NPS_SUBMITTED,
          sourceTemplate: Templates.FEEDBACK_NPS_SURVEY,
          answeredAt: new Date().toISOString(),
        },
      });
      return; // a human follows up — no automated reply to a low score
    }

    if (band === "promoter") {
      if (!(await ctx.guard.isSubscribed())) return;
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: Templates.FEEDBACK_REFERRAL_ASK,
        subject: "Glad it's working — know a team who'd want this?",
        journeyName: user.journeyName,
      });
    }
    // band === "passive" (7–8): the run ends with no follow-up.
  },
});`;

const TEMPLATE_CODE = `// the answer row — three bands, one event, one answer slot
import { EmailAction, HOSTED_ANSWER_HREF } from "@hogsend/email";
import { Events } from "../journeys/constants/index.js";

<Section className="my-6 text-center">
  <EmailAction
    event={Events.NPS_SUBMITTED}
    properties={{ band: "detractor" }}
    href={HOSTED_ANSWER_HREF}
  >
    0–6
  </EmailAction>
  <EmailAction
    event={Events.NPS_SUBMITTED}
    properties={{ band: "passive" }}
    href={HOSTED_ANSWER_HREF}
  >
    7–8
  </EmailAction>
  <EmailAction
    event={Events.NPS_SUBMITTED}
    properties={{ band: "promoter" }}
    href={HOSTED_ANSWER_HREF}
  >
    9–10
  </EmailAction>
</Section>`;

export const npsSurvey: RecipeLander = {
  slug: "nps-survey",
  category: "retention",
  title: "NPS survey",
  metaDescription:
    "A recurring NPS survey as one TypeScript journey: semantic-link score bands answered inside the email, a 90-day cadence enforced by entryLimit, detractors flagged for human follow-up, promoters routed to a referral ask.",
  cardDescription:
    "Score bands answered inside the email, detractors flagged to a human, promoters asked for a referral.",
  eyebrow: "Recipe — Retention & engagement",
  subhead:
    'Three EmailActions collect the score without a form or landing page, ctx.waitForEvent hands the journey the band, and entryLimit: "once_per_period" is the entire 90-day cadence — no last_surveyed_at property to maintain.',
  problem: {
    label: "The NPS-tooling problem",
    statement:
      "NPS usually means a survey tool, a webhook into a spreadsheet, and a quarterly export to find detractors weeks after they were unhappy. The form lives outside the email, so response rates depend on a landing-page hop; the score lives outside your event stream, so nothing can react to it; and the cadence is a calendar reminder, not a per-user rule.",
  },
  walkthrough: {
    eyebrow: "The journey",
    title: "Ask, read the band, route — one file",
    subtitle:
      "The cadence, the durable wait for the answer, and all three band branches live in a single defineJourney() — the survey tool is your email template.",
    note: "The detractor branch deliberately sends nothing to the user: it fires a scalars-only internal event that an alert task (outside the journey) turns into operator email — the same flagging pattern Hogsend runs in production for lead alerts.",
  },
  code: [
    {
      filename: "src/journeys/nps-survey.ts",
      code: JOURNEY_CODE,
      caption:
        "entryLimit does the cadence, waitForEvent does the collection, an if on properties.band does the routing.",
    },
    {
      filename: "src/emails/feedback-nps-survey.tsx",
      code: TEMPLATE_CODE,
      caption:
        "Three anchors sharing one event share one answer slot — first confirmed click wins, and the hosted answer page collects an optional free-text comment as nps.submitted.comment.",
    },
  ],
  points: [
    {
      title: "The score is an event, not a form submission",
      body: "Each band is an EmailAction whose click fires nps.submitted with { band } through the full ingest pipeline — stored in user_events, routed to journeys, fanned out to destinations under your event name. No survey tool, no landing-page wiring, no JavaScript in the email.",
    },
    {
      title: "The cadence is enrollment metadata",
      body: 'entryLimit: "once_per_period" with entryPeriod: days(90) is checked by the enrollment guard before any state is created — an 89-day-too-early trigger event returns { status: "skipped", reason: "period_not_elapsed" }. Active users get surveyed quarterly; dormant users, who can\'t score you, never enroll.',
    },
    {
      title: "Scanner clicks can't submit your survey",
      body: "Corporate mail gateways follow every link within seconds of delivery. Confirmation is deferred past the burst window (~30s) with the whole burst visible, so a SafeLinks crawl is suppressed and the first human answer per (send, event) wins.",
    },
    {
      title: "Detractors reach a human, with the why attached",
      body: "The flag event carries scalars only — band, source event, timestamp — and the alert task resolves the lead's identity server-side from contacts. The hosted answer page's free-text comment ingests as nps.submitted.comment, so the follow-up email to your operator can include the reason, not just the score.",
    },
  ],
  faq: [
    {
      q: "Can I collect the exact 0–10 score instead of bands?",
      a: 'Yes — eleven EmailActions with properties: { score: n } sharing the one nps.submitted event. They still share a single answer slot (first confirmed score wins), and the journey branches on typeof answer.properties?.score === "number". Bands just collapse eleven buttons into three.',
    },
    {
      q: "Why doesn't the detractor branch email the user?",
      a: "An automated reply under a bad score reads as automated. The branch fires an internal nps.detractor_flagged event instead; a custom Hatchet task outside the journey turns it into an operator alert (the Lead alerts recipe), and a human decides the follow-up.",
    },
    {
      q: "What stops the same user being surveyed every week?",
      a: 'The journey triggers on everyday activity (app.active), but entryLimit: "once_per_period" + entryPeriod: days(90) caps enrollment at once per quarter per user — the guard runs before any state is created, so off-cadence events are skipped, not enrolled.',
    },
    {
      q: "How does the free-text 'why' get collected?",
      a: "href={HOSTED_ANSWER_HREF} lands every click on the engine-hosted answer page, which confirms the recorded band and offers an optional comment box. A submitted comment ingests as nps.submitted.comment with the answer's properties attached — a real event journeys and destinations receive.",
    },
  ],
  links: [
    { label: "The full recipe in the docs", href: "/docs/recipes/nps-survey" },
    {
      label: "Semantic links guide — answer semantics",
      href: "/docs/guides/semantic-links",
    },
    {
      label: "Journeys guide — waitForEvent and entry limits",
      href: "/docs/guides/journeys",
    },
  ],
  related: ["lead-alerts", "winback-and-sunset", "review-request"],
};
