import type { RecipeLander } from "./types";

const JOURNEY_CODE = `export const firstWeekSchedule = defineJourney({
  meta: {
    id: "first-week-schedule",
    name: "Scheduling — first-week touchpoints",
    enabled: true,
    trigger: { event: Events.TRIAL_STARTED },
    entryLimit: "once",
    suppress: hours(12),
    exitOn: [{ event: Events.SUBSCRIPTION_CREATED }],
  },

  run: async (user, ctx) => {
    // Tomorrow at 08:30 wall-clock in the user's own timezone. The chain
    // returns a plain Date; sleepUntil does the durable waiting.
    await ctx.sleepUntil(ctx.when.tomorrow().at("08:30"), {
      label: "day-1-morning",
    });
    if (!(await ctx.guard.isSubscribed())) return;

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.ONBOARDING_DAY_ONE,
      subject: "Day one: the three things worth doing first",
      journeyName: user.journeyName,
    });

    // Next Tuesday at 09:00, clamped into business hours for this chain:
    // an instant outside 09:00–17:00 snaps forward to the next open slot.
    const tuesday = ctx.when.window("09:00", "17:00").next("tue").at("09:00");
    await ctx.sleepUntil(tuesday, { label: "tuesday-tips" });
    if (!(await ctx.guard.isSubscribed())) return;

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.ONBOARDING_WEEKLY_TIPS,
      subject: "Three workflows other teams ship in week one",
      journeyName: user.journeyName,
    });
  },
});`;

const COOKBOOK_CODE = `// The next 09:30 wall-clock — today if 09:30 is still ahead, else tomorrow.
ctx.when.nextLocal("09:30");

// The upcoming named weekday — short ("tue") or full ("tuesday") names.
ctx.when.next("tue").at("09:00");

// Tomorrow at 08:00 in a FIXED timezone instead of the user's.
ctx.when.tz("America/New_York").tomorrow().at("08:00");

// N days out, at a time that day, clamped into a window for this chain.
ctx.when.window("09:00", "17:00").in(days(5)).at("14:00");

// Past-instant policy: "next" (default) rolls forward to the next valid
// occurrence; "now" clamps to now so the step runs immediately instead.
ctx.when.ifPast("now").nextLocal("09:00");

// Every chain returns a plain Date — hand it to the durable sleep.
await ctx.sleepUntil(ctx.when.nextLocal("09:30"), { label: "morning-send" });`;

export const timezoneAwareScheduling: RecipeLander = {
  slug: "timezone-aware-scheduling",
  category: "scheduling",
  title: "Timezone-aware scheduling",
  metaDescription:
    "Schedule emails in each user's local time with ctx.when and ctx.sleepUntil: nextLocal, weekday chains, send windows, ifPast policies, and a timezone resolution chain that falls back from PostHog to contact properties to UTC.",
  cardDescription:
    "Turn 'next Tuesday at 9am, their time' into a Date and sleep durably until it.",
  eyebrow: "Recipe — Timing & scheduling",
  subhead:
    "ctx.when resolves the user's timezone (PostHog person property → contact property → client default → UTC) and turns a human rule into an absolute Date; ctx.sleepUntil waits for it durably, surviving deploys and restarts.",
  problem: {
    label: "The 9am problem",
    statement:
      "'Send at 9am' usually means 9am server time — 3am in one user's inbox, mid-evening in another's. Fixing it by hand means storing per-user offsets that go stale, reimplementing DST transitions, and keeping a timer alive across deploys: a setTimeout waiting for Tuesday does not survive Monday's release.",
  },
  walkthrough: {
    eyebrow: "The journey",
    title: "The chain computes, the sleep waits",
    subtitle:
      "ctx.when is pure date math bound to the user's timezone; ctx.sleepUntil is the durable Hatchet primitive that actually waits. The split means restarts are invisible and the date logic is plain, testable code.",
    note: "Both scheduled instants here are waits like any other: a subscription.created mid-sleep exits the run via exitOn before the next send, so scheduled sends need no goal-met polling.",
  },
  code: [
    {
      filename: "src/journeys/first-week-schedule.ts",
      code: JOURNEY_CODE,
      caption:
        "Two sends, both landing at a deliberate local moment — tomorrow 08:30 wall-clock, then next Tuesday inside business hours.",
    },
    {
      filename: "the ctx.when cookbook",
      code: COOKBOOK_CODE,
      caption:
        "Refinements (.tz, .window, .ifPast) return new builders; terminals (.at, nextLocal) return a plain Date for ctx.sleepUntil.",
    },
  ],
  points: [
    {
      title: "The timezone resolves itself",
      body: "Each chain takes the first valid IANA candidate from: an explicit .tz() override, PostHog person properties ($timezone, then $geoip_time_zone), the contact's stored timezone, the contact's properties.timezone, the client default, then UTC. Invalid strings are skipped, never thrown.",
    },
    {
      title: "Durable to the instant",
      body: 'ctx.sleepUntil is a Hatchet durable sleep: the journey state goes to "waiting", the process can restart or redeploy any number of times, and the run resumes at the computed instant. An instant already in the past resolves immediately.',
    },
    {
      title: "Send windows are wall-clock and DST-correct",
      body: 'A .window("09:00", "17:00") clamps resolved instants forward into the open hours, interpreted in the bound timezone — 09:00 is always 9am wall-clock across DST transitions, and an overnight window like 22:00–06:00 wraps midnight. Immediate sendEmail() calls are never delayed.',
    },
    {
      title: "Degrades, never blocks",
      body: "PostHog person reads need POSTHOG_PERSONAL_API_KEY (the phc_ project key is write-only by PostHog's design). Without it the chain soft-fails to contact properties and the client default — surfaced once at boot and by hogsend doctor, with sends still going out.",
    },
  ],
  faq: [
    {
      q: "What happens if the user's timezone is unknown?",
      a: "The resolution chain falls through PostHog person properties, the contact's stored timezone, the contact's properties.timezone, and the client's defaults.timezone before landing on UTC. You can pin any single chain with .tz(\"Asia/Tokyo\") regardless.",
    },
    {
      q: "Does a deploy during the sleep lose the scheduled send?",
      a: "No. ctx.sleepUntil is a durable Hatchet primitive — the wait is engine state, not an in-process timer. The worker can restart any number of times and the journey resumes at the computed instant.",
    },
    {
      q: "What if the computed time is already in the past?",
      a: 'ctx.sleepUntil with a past instant resolves immediately. On the chain side, .ifPast("next") (the default) rolls to the next valid occurrence, while .ifPast("now") clamps to now — the chain decides which \'already passed\' semantics the step wants.',
    },
    {
      q: "Can a whole digest or campaign be sent per-user-local like this?",
      a: "ctx.when is a journey primitive — it schedules one user's next step. A population-wide send (a digest cron, a campaign broadcast) fires at one instant for everyone; see the Weekly digest recipe for that trade-off.",
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/timezone-aware-scheduling",
    },
    {
      label: "Journeys guide — ctx.when and ctx.sleepUntil",
      href: "/docs/guides/journeys",
    },
    {
      label: "Analytics access — the two-credential model",
      href: "/docs/guides/analytics-access",
    },
  ],
  related: ["event-reminder-sequence", "anniversary-emails", "weekly-digest"],
};
