# JourneyContext (`ctx`) — the full primitive API

`ctx` is the SECOND argument to `run(user, ctx)`. It exposes **durable
orchestration primitives only** — the things that need Hatchet's durable
execution or the journey's bound state (sleep, checkpoints, triggering events,
reading history). It is deliberately small.

It is the `JourneyContext` type from `@hogsend/core`. Everything below is a real
method.

## Durable timing

```ts
// Durable Hatchet sleep. Sets state → "waiting" for the duration, then "active".
// The worker can restart mid-sleep and resume — this is the core durability win.
const { sleptAt, resumedAt } = await ctx.sleep({
  duration: days(2),          // DurationObject from days()/hours()/minutes()
  label: "post-welcome",      // optional — also written as currentNodeId
});

// Durable sleep until an absolute instant (Date or ISO string).
await ctx.sleepUntil(someDate, { label: "wait-for-renewal" });

// Timezone-bound fluent scheduler — always resolves to an absolute Date you
// then pass to sleepUntil. Bound to the user's resolved timezone.
const at = ctx.when.tomorrow().at("09:00");        // 9am local, tomorrow
await ctx.sleepUntil(at, { label: "morning-nudge" });
// other ctx.when builders: .next("mon").at("HH:mm"), .nextLocal("HH:mm"),
// .in(days(3)).at("HH:mm"), and chainers .tz(zone) / .window(start,end) / .ifPast("next"|"now")
```

## Observability

```ts
// Update currentNodeId on the journeyStates row — a breadcrumb for dashboards.
await ctx.checkpoint("awaiting-activation");
```

## Firing events (cross-journey orchestration)

```ts
// Push an event through the FULL ingest pipeline (stores it, routes to matching
// journey tasks via Hatchet, processes exitOn). Lets one journey trigger another.
await ctx.trigger({
  event: Events.JOURNEY_PRO_PATH,
  userId: user.id,            // defaults userEmail to the current user's email
  userEmail: user.email,      // optional override
  properties: { step: "pro_branch" },
});
```

## PostHog (no-op without POSTHOG_API_KEY)

```ts
// Set person properties on PostHog for the current user.
ctx.identify({ plan: "pro", onboarded: true });   // synchronous, void

// Fire a custom PostHog event for the current user.
ctx.posthog.capture({ event: "journey_step_reached", properties: { step: 2 } });
```

## Guards

```ts
// Re-check subscription AFTER a long sleep, before sending again.
if (await ctx.guard.isSubscribed()) {
  await sendEmail({ /* ... */ });
}
```

## History reads (branch on what already happened)

```ts
// Did this user fire an event (optionally within a window)?
const { found, count } = await ctx.history.hasEvent({
  userId: user.id,
  event: Events.FEATURE_USED,
  within: days(7),            // optional DurationObject
});

// Has this user completed another journey before? How many times entered?
const { completed, lastCompletedAt, entryCount } = await ctx.history.journey({
  userId: user.id,
  journeyId: "onboarding",
});

// Has this email already received a given template?
const { sent, lastSentAt, count } = await ctx.history.email({
  email: user.email,
  template: Templates.ACTIVATION_WELCOME,
});
```

## What is NOT on `ctx`

These are **standalone imports**, not methods — keeping `ctx` to pure
orchestration:

- **`sendEmail()`** — `import { sendEmail } from "@hogsend/engine"`. See
  `references/sending-email-from-a-journey.md`.
- **`getPostHog()`** — `import { getPostHog } from "@hogsend/engine"` for the raw
  PostHog service (`ctx.identify` / `ctx.posthog.capture` cover the common cases).
- **SMS / push / Slack** — plain functions you import, never on `ctx`.
- There is **no `ctx.db`, no `ctx.sendEmail`, no `ctx.hatchet`** surfaced to
  consumer journeys. If you reach for one of those, you are modelling it wrong —
  use a primitive above or a standalone import.

The `user` argument (first param) carries identity + attribution: `user.id`,
`user.email`, `user.properties`, `user.stateId` (pass to `sendEmail`),
`user.journeyId`, `user.journeyName`.
