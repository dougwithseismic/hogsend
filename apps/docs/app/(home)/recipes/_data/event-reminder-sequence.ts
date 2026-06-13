import type { RecipeLander } from "./types";

const JOURNEY_CODE = `const HOUR = 60 * 60 * 1000;

export const eventReminderSequence = defineJourney({
  meta: {
    id: "event-reminder-sequence",
    name: "Webinar — reminder sequence",
    enabled: true,
    trigger: {
      event: Events.WEBINAR_REGISTERED,
      // a registration without a start time can't be scheduled against
      where: (b) => b.prop("start_time").exists(),
    },
    entryLimit: "unlimited",
    suppress: hours(1),
    exitOn: [{ event: Events.WEBINAR_CANCELLED }],
  },

  run: async (user, ctx) => {
    const title = String(user.properties.title ?? "the session");
    const startsAt = new Date(String(user.properties.start_time ?? ""));
    if (Number.isNaN(startsAt.getTime())) return;

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.WEBINAR_CONFIRMATION,
      subject: "You're registered",
      journeyName: user.journeyName,
      props: { title },
    });

    // T-24h. sleepUntil resolves IMMEDIATELY for past instants, so guard
    // each reminder — a late registration takes only the touches ahead.
    if (Date.now() < startsAt.getTime() - 24 * HOUR) {
      await ctx.sleepUntil(new Date(startsAt.getTime() - 24 * HOUR));
      if (!(await ctx.guard.isSubscribed())) return;
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: Templates.WEBINAR_REMINDER,
        subject: "Starts tomorrow",
        journeyName: user.journeyName,
        props: { title, hoursToGo: 24 },
      });
    }

    // T-1h — same guard, same template, different props.
    if (Date.now() < startsAt.getTime() - 1 * HOUR) {
      await ctx.sleepUntil(new Date(startsAt.getTime() - 1 * HOUR));
      if (!(await ctx.guard.isSubscribed())) return;
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: Templates.WEBINAR_REMINDER,
        subject: "Starting in an hour",
        journeyName: user.journeyName,
        props: { title, hoursToGo: 1 },
      });
    }

    // Did they show up? Resolves the instant webinar.joined lands.
    const joined = await ctx.waitForEvent({
      event: Events.WEBINAR_JOINED,
      timeout: hours(3),
      lookback: minutes(30),
    });

    // Hold the follow-up until the session is over either way.
    await ctx.sleepUntil(new Date(startsAt.getTime() + 2 * HOUR));
    if (!(await ctx.guard.isSubscribed())) return;

    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: joined.timedOut
        ? Templates.WEBINAR_REPLAY
        : Templates.WEBINAR_THANKS,
      subject: joined.timedOut
        ? "Sorry we missed you — here's the replay"
        : "Thanks for joining",
      journeyName: user.journeyName,
      props: { title },
    });
  },
});`;

const TRIGGER_CODE = `// registration — starts the sequence; start_time drives every wait
await hs.events.send({
  name: "webinar.registered",
  email: attendee.email,
  userId: attendee.id,
  eventProperties: {
    webinar_id: webinar.id,
    title: webinar.title,
    start_time: webinar.startsAt.toISOString(),
  },
  idempotencyKey: \`webinar-reg-\${webinar.id}-\${attendee.id}\`,
});

// they joined the live session — resolves the attendance wait
await hs.events.send({
  name: "webinar.joined",
  userId: attendee.id,
  eventProperties: { webinar_id: webinar.id },
});

// called off — exits every registrant's run, even mid-sleep
await hs.events.send({
  name: "webinar.cancelled",
  userId: attendee.id,
  eventProperties: { webinar_id: webinar.id },
});`;

export const eventReminderSequence: RecipeLander = {
  slug: "event-reminder-sequence",
  category: "scheduling",
  title: "Event reminder sequence",
  metaDescription:
    "Webinar reminders as a TypeScript journey: T-24h and T-1h sends computed from the registration event's start_time, a post-event branch on webinar.joined, and an exit on cancellation.",
  cardDescription:
    "T-24h and T-1h reminders computed from the event's own start time, then replay vs thanks.",
  eyebrow: "Recipe — Timing & scheduling",
  subhead:
    "The registration event carries start_time; every wait is a durable sleepUntil computed from it, a waitForEvent decides replay vs thanks, and a cancellation exits the run mid-sleep.",
  problem: {
    label: "The reminder-scheduling problem",
    statement:
      "Reminder sends are usually rows in a scheduler table: a worker enqueues T-24h and T-1h jobs per registrant, a second job diffs cancellations against the queue, and a third reconciles attendance afterwards. Each table is a sync problem — the reschedule that misses a queued job, the cancellation that lands after the enqueue, the late registrant who gets a 'starts tomorrow' email two hours before start.",
  },
  walkthrough: {
    eyebrow: "The journey",
    title: "The schedule lives in the event, not a job table",
    subtitle:
      "start_time arrives on webinar.registered; the journey computes every reminder instant from it with plain Date math and hands each to a durable sleepUntil.",
    note: "sleepUntil resolves immediately for past instants rather than skipping — the Date.now() guard in front of each reminder is what makes a late registration take only the touches still ahead of it.",
  },
  code: [
    {
      filename: "src/journeys/event-reminder-sequence.ts",
      code: JOURNEY_CODE,
      caption:
        "Reminder instants are plain Date math on the trigger event's start_time; exitOn webinar.cancelled kills the run at any point, even mid-sleep.",
    },
    {
      filename: "your app server",
      code: TRIGGER_CODE,
      caption:
        "Three events drive everything — webinar.joined usually arrives from your webinar platform's webhook through a webhook source.",
    },
  ],
  points: [
    {
      title: "The schedule is data, not config",
      body: "Reminder times are computed from the start_time property the registration event carries, so every webinar schedules itself — no per-event cron entries, no job table to reconcile when a session is added.",
    },
    {
      title: "Cancellation stops everything mid-sleep",
      body: "webinar.cancelled is in meta.exitOn, so the engine cancels the durable run the instant the event lands — a registrant sleeping toward the T-1h reminder never receives it.",
    },
    {
      title: "Late registrations degrade correctly",
      body: "ctx.sleepUntil resolves immediately for past instants, and each reminder is guarded by a Date.now() check — someone registering 30 minutes before start gets the confirmation and the post-event follow-up, not a stale 'starts tomorrow'.",
    },
    {
      title: "Attendance branching without reconciliation",
      body: "ctx.waitForEvent resolves the instant webinar.joined lands (lookback covers the send-to-wait gap), and the follow-up is held until two hours after start — attendees get thanks, no-shows get the replay, from one if statement.",
    },
  ],
  faq: [
    {
      q: "What happens when a webinar is rescheduled?",
      a: 'Fire webinar.cancelled to exit the running sequence, then a fresh webinar.registered with the new start_time. entryLimit is "unlimited", so the new registration enrolls a new run scheduled off the new instant.',
    },
    {
      q: "Why not use ctx.when for the reminders?",
      a: "ctx.when answers local-time questions — 'next morning in the user's timezone'. A webinar starts at one absolute instant for everyone, so the right tool is plain Date arithmetic on start_time handed to ctx.sleepUntil. The timezone-aware-scheduling recipe covers the ctx.when side.",
    },
    {
      q: "Can one user run two sequences for two webinars at once?",
      a: 'No — the enrollment guards allow one active run per user per journey, so a second registration mid-flight is skipped with reason "already_active". Keep the sequence short, or split per-series journey ids if overlap matters for your schedule density.',
    },
    {
      q: "Where does webinar.joined come from?",
      a: "Your webinar platform. Most platforms emit a join webhook — a defineWebhookSource() transform turns it into the webinar.joined event, which feeds the same ingest pipeline as everything else. See /docs/guides/webhook-sources.",
    },
  ],
  links: [
    {
      label: "The full recipe in the docs",
      href: "/docs/recipes/event-reminder-sequence",
    },
    {
      label: "Journeys guide — sleepUntil and waitForEvent",
      href: "/docs/guides/journeys",
    },
    {
      label: "Events & contacts — idempotency model",
      href: "/docs/recipes/events-and-contacts",
    },
  ],
  related: [
    "timezone-aware-scheduling",
    "anniversary-emails",
    "welcome-series",
  ],
};
