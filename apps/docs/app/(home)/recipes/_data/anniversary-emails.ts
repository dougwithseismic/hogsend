import type { RecipeLander } from "./types";

const JOURNEY_CODE = `export const signupAnniversary = defineJourney({
  meta: {
    id: "signup-anniversary",
    name: "Retention — signup anniversary",
    enabled: true,
    trigger: { event: Events.ANNIVERSARY_REACHED },
    // the yearly cap — a duplicate trigger inside the period is skipped
    entryLimit: "once_per_period",
    entryPeriod: days(365),
    suppress: hours(24),
    exitOn: [{ event: Events.USER_DELETED }],
  },

  run: async (user, ctx) => {
    const years = Number(user.properties.years ?? 1);

    // A celebration email to someone who left a year ago reads as
    // automated noise. Dormant contacts belong in a win-back flow.
    const { found: active } = await ctx.history.hasEvent({
      userId: user.id,
      event: Events.APP_ACTIVE,
      within: days(90),
    });
    if (!active) return;

    // The producer fires at whatever hour the nightly job runs. Land
    // the send at 09:00 in the user's own timezone instead.
    await ctx.sleepUntil(ctx.when.nextLocal("09:00"));
    if (!(await ctx.guard.isSubscribed())) return;

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.RETENTION_ANNIVERSARY,
      subject:
        years === 1
          ? "One year with us today"
          : \`\${years} years with us today\`,
      journeyName: user.journeyName,
      props: { years },
    });
  },
});`;

const TRIGGER_CODE = `// a nightly job in your app — cron, scheduled function, anything
for (const u of usersWithSignupAnniversaryToday) {
  await hs.events.send({
    name: "anniversary.reached",
    email: u.email,
    userId: u.id,
    eventProperties: { years: u.yearsSinceSignup },
    // a re-run of the job is a { stored: false } no-op
    idempotencyKey: \`anniversary-\${u.id}-\${u.yearsSinceSignup}\`,
  });
}`;

export const anniversaryEmails: RecipeLander = {
  slug: "anniversary-emails",
  category: "retention",
  title: "Anniversary emails",
  metaDescription:
    "A signup-anniversary journey in TypeScript: a nightly producer fires anniversary.reached, entryLimit once_per_period caps it at one celebration a year, and ctx.when + sleepUntil land the send at 09:00 in the user's own timezone.",
  cardDescription:
    "One celebration per year, gated on recent activity, landing at 09:00 local time.",
  eyebrow: "Recipe — Retention & engagement",
  subhead:
    'A nightly producer fires the signal, entryLimit: "once_per_period" + entryPeriod: days(365) make a second fire harmless, and a durable sleepUntil parks the run until 09:00 in the user\'s own timezone.',
  problem: {
    label: "The anniversary problem",
    statement:
      "Anniversary sends usually come straight out of the cron that detects them — at 03:00 server time, in every recipient's inbox at once, including people who churned two years ago. A re-run of the job double-sends, and the timezone math (DST, the user who moved countries) lives in hand-rolled date code that runs once a year and is never exercised in between.",
  },
  walkthrough: {
    eyebrow: "The journey",
    title: "The cron detects; the journey times and sends",
    subtitle:
      "The producer only fires an idempotent event — the yearly cap, the dormancy gate, the local-morning landing, and the send all live in one defineJourney().",
    note: "ctx.when resolves the user's timezone automatically (PostHog person properties → contact timezone → client default → UTC) and nextLocal(\"09:00\") can never produce a past instant — today's 09:00 if still ahead, else tomorrow's.",
  },
  code: [
    {
      filename: "src/journeys/signup-anniversary.ts",
      code: JOURNEY_CODE,
      caption:
        "The dormancy gate runs before the sleep, so a churned contact's run ends immediately instead of parking until morning to send nothing.",
    },
    {
      filename: "your nightly job",
      code: TRIGGER_CODE,
      caption:
        "The producer knows the signup date; everything else is the journey's problem. The per-user-per-year idempotency key makes job re-runs no-ops.",
    },
  ],
  points: [
    {
      title: "Two dedupe layers with different scopes",
      body: 'The idempotencyKey (anniversary-<userId>-<year>) makes a replayed producer fire a { stored: false } no-op; entryLimit: "once_per_period" with entryPeriod: days(365) skips enrollment for anything else that fires inside the year — a backfill, a second producer, a renamed key.',
    },
    {
      title: "The local morning is one line",
      body: 'ctx.sleepUntil(ctx.when.nextLocal("09:00")) resolves the user\'s timezone through a documented chain (PostHog $timezone → contact timezone → client default → UTC), handles DST as wall-clock time, and respects a configured send window.',
    },
    {
      title: "Dormant contacts are skipped, not celebrated",
      body: 'ctx.history.hasEvent({ event: "app.active", within: days(90) }) gates the send on recent activity — a contact who left belongs in the win-back recipe, and the gate runs before the sleep so their run costs nothing.',
    },
    {
      title: "The overnight park is durable",
      body: "The run waits from the 02:00 trigger to the 09:00 local send as Hatchet state, surviving deploys and restarts — and the isSubscribed re-check after the sleep catches an unsubscribe that happened overnight, since unsubscribe does not exit a journey.",
    },
  ],
  faq: [
    {
      q: "Why can't the journey just sleep 365 days from signup?",
      a: "A journey run is capped at 720 hours (30 days) of execution, and a year-long run per signup would pin state for every user. The producer computes the date where it lives — your database — and fires an event; the journey owns everything after the signal.",
    },
    {
      q: "What timezone is used if I haven't set up PostHog person reads?",
      a: "The chain falls through: PostHog person properties need POSTHOG_PERSONAL_API_KEY (the phc_ project key is write-only), and without it resolution soft-fails to the contact's stored timezone, then properties.timezone, then the client's defaults.timezone, then UTC.",
    },
    {
      q: "The nightly job ran twice — does anyone get two emails?",
      a: 'No. The same fire carries the same idempotencyKey and is dropped at ingestion. A differently-keyed duplicate is stopped at enrollment by entryLimit: "once_per_period" — the period since the last entry hasn\'t elapsed.',
    },
    {
      q: "What if the trigger arrives after 09:00 local time?",
      a: 'nextLocal("09:00") picks tomorrow\'s 09:00 — it never resolves into the past. For chains that can land in the past (like in(days(0)).at("09:00")), the default ifPast: "next" rolls forward a day and ifPast("now") clamps to an immediate send instead.',
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/anniversary-emails",
    },
    {
      label: "Journeys guide — ctx.when and sleepUntil",
      href: "/docs/guides/journeys",
    },
    {
      label: "Events & contacts — the idempotency model",
      href: "/docs/recipes/events-and-contacts",
    },
  ],
  related: ["winback-and-sunset", "nps-survey", "timezone-aware-scheduling"],
};
