import type { RecipeLander } from "./types";

const ROUTER_CODE = `export const onboardingCheckin = defineJourney({
  meta: {
    id: "onboarding-checkin",
    name: "Onboarding — check-in router",
    enabled: true,
    trigger: { event: Events.USER_SIGNED_UP },
    entryLimit: "once",
    suppress: hours(12),
  },

  run: async (user, ctx) => {
    await ctx.sleep({ duration: days(5), label: "pre-checkin" });
    if (!(await ctx.guard.isSubscribed())) return;

    // The yes/no buttons are semantic links — a click fires
    // checkin.answered { answer } through the full pipeline.
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.ONBOARDING_CHECKIN,
      subject: "One tap: how is setup going?",
      journeyName: user.journeyName,
    });

    const checkin = await ctx.waitForEvent({
      event: Events.CHECKIN_ANSWERED,
      timeout: days(5),
      lookback: minutes(30), // covers the send → wait-established gap
    });

    if (!(await ctx.guard.isSubscribed())) return;
    const answer = checkin.timedOut ? undefined : checkin.properties?.answer;

    if (answer === "yes") {
      // Activated — route to the referral ask.
      await ctx.trigger({
        event: Events.REFERRAL_ELIGIBLE,
        userId: user.id,
        properties: { reason: "activated", source: "onboarding-checkin" },
      });
      return;
    }

    // "no" or silence — the help-offer path. Never re-pitch someone who
    // already completed that flow on another pass.
    const { completed: alreadyPitched } = await ctx.history.journey({
      userId: user.id,
      journeyId: "setup-offer",
    });
    if (alreadyPitched) return;

    await ctx.trigger({
      event: Events.SETUP_ELIGIBLE,
      userId: user.id,
      properties: {
        reason: answer === "no" ? "needs-help" : "silent",
        source: "onboarding-checkin",
      },
    });
  },
});`;

const DOWNSTREAM_CODE = `export const setupOffer = defineJourney({
  meta: {
    id: "setup-offer",
    name: "Onboarding — setup offer",
    enabled: true, // this branch has its own kill switch
    trigger: { event: Events.SETUP_ELIGIBLE },
    entryLimit: "once", // a duplicate eligibility fire is harmless
    suppress: hours(12),
    // Booking at any point withdraws the pitch, even mid-sleep.
    exitOn: [{ event: Events.SETUP_BOOKED }],
  },

  run: async (user, ctx) => {
    // Day-1 breather: an offer landing seconds after the "no" click
    // reads automated, not responsive.
    await ctx.sleep({ duration: days(1), label: "pre-offer" });
    if (!(await ctx.guard.isSubscribed())) return;

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.SETUP_OFFER,
      subject: "If setup is the blocker, we'll do it with you",
      journeyName: user.journeyName,
      // the eligibility event's scalars ride in on user.properties
      props: { reason: String(user.properties.reason ?? "") },
    });
  },
});`;

export const crossJourneyFunnels: RecipeLander = {
  slug: "cross-journey-funnels",
  category: "pipelines",
  title: "Cross-journey funnels",
  metaDescription:
    "Compose journeys into funnels with ctx.trigger() eligibility events: each downstream journey keeps its own entry limits, preference checks, and kill switch, and ctx.history.journey() prevents double-routing.",
  cardDescription:
    "One journey routes into others with eligibility events — every branch keeps its own guards and kill switch.",
  eyebrow: "Recipe — Pipelines & orchestration",
  subhead:
    "The upstream journey ends by firing eligibility events through ctx.trigger(); each downstream flow is its own defineJourney(), so every handoff passes the full enrollment guard chain and every branch deploys, caps, and disables independently.",
  problem: {
    label: "The monolith problem",
    statement:
      "Funnels grown inside one journey become monoliths: a single run() owns weeks of branches, one exitOn list applies to all of them, and shipping a new path redeploys the whole flow. Splitting by hand usually loses the safety net — the second flow needs its own entry caps and preference checks, and someone who already completed a branch gets routed into it again.",
  },
  walkthrough: {
    eyebrow: "The funnel",
    title: "One router, many journeys",
    subtitle:
      "The check-in journey turns an answer (or silence) into setup.eligible / referral.eligible events; the offer and referral journeys trigger on those events with their own limits and exits.",
    note: "Because eligibility events go through the full ingest pipeline, every downstream enrollment passes the same guard chain as any other journey — enabled flag, trigger conditions, entry limit, and the email-preference check — with zero coordination code in the router.",
  },
  code: [
    {
      filename: "src/journeys/onboarding-checkin.ts",
      code: ROUTER_CODE,
      caption:
        "The routing tail fires events, not emails — every send the user receives lives in the downstream journey that owns it.",
    },
    {
      filename: "src/journeys/setup-offer.ts",
      code: DOWNSTREAM_CODE,
      caption:
        "Each branch is an ordinary journey: its own trigger, entryLimit, exitOn, and enabled flag — and the routing context arrives as event properties.",
    },
  ],
  points: [
    {
      title: "The handoff passes every guard",
      body: "ctx.trigger() pushes the eligibility event through the full ingest pipeline, so each downstream enrollment re-checks meta.enabled, trigger.where, entryLimit, and the user's email preferences. An unsubscribe between the check-in and the route is respected at the boundary.",
    },
    {
      title: "Each branch has its own limits and kill switch",
      body: "entryLimit, suppress, and exitOn are per-journey, and a branch disables via its enabled flag or ENABLED_JOURNEYS without touching the router — which keeps firing events into a void, safely.",
    },
    {
      title: "Duplicate fires are harmless",
      body: 'Under entryLimit: "once" a second setup.eligible for the same user returns { status: "skipped", reason: "already_entered_once" }, so several routers can feed one downstream journey without coordination. ctx.history.journey() additionally lets the router skip people who completed the flow.',
    },
    {
      title: "Routing decisions are auditable rows",
      body: 'Eligibility events land in user_events with their reason and source scalars, so "why did this person get the offer" is a query, not a log dive — and the same properties ride into the downstream run on user.properties.',
    },
  ],
  faq: [
    {
      q: "Why not keep the whole funnel in one run() function?",
      a: "One run() means one exitOn list, one entry limit, and one deploy unit for weeks of branches. Split journeys give each branch its own caps, exits, and kill switch, and the handoff re-checks preferences for free.",
    },
    {
      q: "What happens if the eligibility event fires twice?",
      a: 'Nothing. The downstream journey\'s entryLimit guard skips the second enrollment with reason "already_entered_once" — no state is created and no email is sent.',
    },
    {
      q: "Is an unsubscribe respected across the handoff?",
      a: "Yes, twice. The downstream enrollment guard checks preferences at entry, and the journey re-checks ctx.guard.isSubscribed() after its own waits — necessary because an unsubscribe does not exit an in-flight journey.",
    },
    {
      q: "Can two journeys route into the same downstream flow?",
      a: "Yes — the trigger is just an event name. Use the reason/source properties to record which router fired it, trigger.where to split eligibility further, and ctx.history.journey() on the router side to avoid re-pitching completed users.",
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/cross-journey-funnels",
    },
    {
      label: "Journeys guide — ctx.trigger and the guard chain",
      href: "/docs/guides/journeys",
    },
    {
      label: "Semantic links — the in-email answer buttons",
      href: "/docs/guides/semantic-links",
    },
  ],
  related: ["posthog-triggered-journeys", "lead-alerts", "nps-survey"],
};
